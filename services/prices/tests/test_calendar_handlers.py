from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
import time_machine
from botocore.exceptions import ClientError

from prices import calendar_handlers as ch
from prices import handlers
from prices.calendar_config import CalendarSettings
from prices.calendar_models import EarningsEvent, SplitEvent
from prices.calendar_providers import MockCalendarSource
from prices.config import Settings
from prices.errors import ProviderError, RateLimitError, RetryableProviderError, SymbolNotFoundError
from prices.models import DividendEvent
from prices.repository import Repository
from tests.conftest import TABLE, Infra

NOW = datetime(2026, 10, 15, 5, 30, tzinfo=UTC)
TODAY = NOW.date()
STAMP = "2026-10-15T05:30:00.000Z"


class Ctx:
    aws_request_id = "req-cal"


@pytest.fixture(autouse=True)
def _reset_calendar() -> Iterator[None]:
    ch.reset()
    yield
    ch.reset()


class FakeEarnings:
    name = "alphavantage"
    budgeted = True

    def __init__(self, events: list[EarningsEvent] | None = None, error: Exception | None = None) -> None:
        self.events = events or []
        self.error = error
        self.calls: list[list[str]] = []

    def fetch(self, symbols: Any, today: date) -> list[EarningsEvent]:
        self.calls.append(list(symbols))
        if self.error:
            raise self.error
        return self.events


class FakeActions:
    name = "eodhd"

    def __init__(self, *, budgeted: bool = True, fail: dict[str, Exception] | None = None) -> None:
        self.budgeted = budgeted
        self.fail = fail or {}
        self.split_calls: list[str] = []
        self.dividend_calls: list[str] = []

    def get_splits(self, symbol: str, start: date) -> list[SplitEvent]:
        self.split_calls.append(symbol)
        if symbol in self.fail:
            raise self.fail[symbol]
        return [SplitEvent(symbol, "2026-11-02", 1, 4, "eodhd")] if symbol == "AAPL" else []

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        self.dividend_calls.append(symbol)
        return [
            DividendEvent(
                symbol=symbol, ex_date="2026-11-09", pay_date="2026-11-12", amount=0.26, currency="USD"
            )
        ]


def make_deps(
    *,
    earnings: Any = None,
    actions: Any = None,
    calendar: CalendarSettings | None = None,
) -> ch.CalendarDeps:
    settings = Settings.from_env()
    return ch.CalendarDeps(
        settings=settings,
        calendar=calendar or CalendarSettings(),
        repo=Repository(TABLE),
        crepo=ch.CalendarRepository(TABLE),
        earnings=earnings,
        actions=actions,
    )


def keys_of(infra: Infra, prefix: str) -> list[str]:
    return [f"{i['PK']}|{i['SK']}" for i in infra.items() if str(i["SK"]).startswith(prefix)]


# --------------------------------------------------------------------------- mock end to end


@time_machine.travel(NOW, tick=False)
def test_calendar_refresh_with_the_mock_provider_covers_holdings_and_watchlist(infra: Infra) -> None:
    infra.track("AAPL", "NVDA", "ASML.AS", "BTC-EUR")
    result = ch.calendar_refresh({}, Ctx())
    assert result["tracked"] == 4
    assert result["earnings"] == {"status": "ok", "symbols": 2, "events": 2, "staleDeleted": 0}
    actions = result["corporateActions"]
    assert actions["status"] == "ok"
    assert actions["checkedSymbols"] == ["AAPL", "ASML.AS", "NVDA"]  # crypto has no splits or dividends
    assert actions["failed"] == 0

    assert keys_of(infra, "EARN#")[0].startswith("TICKER#AAPL|EARN#2026-")
    assert {k.split("|")[0] for k in keys_of(infra, "EARN#")} == {
        "TICKER#AAPL",
        "TICKER#NVDA",
    }  # US listings only
    splits = keys_of(infra, "SPLIT#")
    assert len(splits) == 2
    aapl = infra.items("TICKER#AAPL")
    earn = next(i for i in aapl if i["SK"].startswith("EARN#"))
    assert earn["entityType"] == "EARNINGS_EVENT"
    assert earn["source"] == "mock"
    assert earn["timeOfDay"] in ("BMO", "AMC")
    split = next(i for i in infra.items("TICKER#NVDA") if i["SK"].startswith("SPLIT#"))
    assert (int(split["fromFactor"]), int(split["toFactor"]), split["source"]) == (1, 10, "mock")
    assert any(i["SK"].startswith("DIV#") for i in infra.items("TICKER#ASML.AS"))
    marker = infra.get("TICKER#AAPL", "CAL#STATE")
    assert marker is not None
    assert (marker["splitsCheckedAt"], marker["dividendsCheckedAt"]) == (STAMP, STAMP)
    assert infra.get("TICKER#BTC-EUR", "CAL#STATE") is None
    # The mock source is not budgeted; only the record of the earnings run is there.
    assert [i["SK"] for i in infra.items("CALENDAR")] == ["EARNINGS#LASTOK", "EARNINGS#LASTRUN"]


@time_machine.travel(NOW, tick=False)
def test_rerunning_is_idempotent_and_skips_recently_checked_symbols(infra: Infra) -> None:
    infra.track("AAPL", "NVDA")
    ch.calendar_refresh({}, Ctx())
    first = infra.items()
    again = ch.calendar_refresh({}, Ctx())
    assert infra.items() == first
    assert again["corporateActions"]["due"] == 0
    assert again["corporateActions"]["checked"] == 0
    # Once the re-check interval has passed they are due again (and rewrite the very same keys).
    later = make_deps(earnings=MockCalendarSource(), actions=MockCalendarSource())
    result = ch.run_calendar_refresh(later, NOW + timedelta(days=8))
    assert result["corporateActions"]["checked"] == 2
    # Splits and dividends are rewritten under the very same keys ...
    stable = [(i["PK"], i["SK"]) for i in first if not i["SK"].startswith("EARN#")]
    assert [(i["PK"], i["SK"]) for i in infra.items() if not i["SK"].startswith("EARN#")] == stable
    # ... while the mock's report dates moved with the clock: the old ones were replaced, not accumulated.
    assert result["earnings"]["staleDeleted"] == 2
    assert len(keys_of(infra, "EARN#")) == 2


def test_get_deps_is_cached_and_built_from_the_environment(infra: Infra) -> None:
    deps = ch.get_deps()
    assert deps is ch.get_deps()
    assert isinstance(deps.earnings, MockCalendarSource)
    assert deps.actions is deps.earnings
    assert deps.settings.table_name == TABLE
    assert deps.calendar == CalendarSettings()
    ch.reset()
    assert ch.get_deps() is not deps


def test_the_calendar_lambda_initialises_logging_like_the_other_handlers(infra: Infra) -> None:
    ch.calendar_refresh(None, Ctx())
    assert handlers.request_id.get() == "req-cal"


# --------------------------------------------------------------------------- earnings


def test_earnings_without_a_provider_or_symbols(infra: Infra) -> None:
    deps = make_deps()
    assert ch._refresh_earnings(deps, ["AAPL"], TODAY, STAMP) == {"status": "no-provider"}
    deps = make_deps(earnings=FakeEarnings())
    assert ch._refresh_earnings(deps, ["ASML.AS", "BTC-EUR"], TODAY, STAMP) == {"status": "no-symbols"}
    assert deps.earnings.calls == []  # type: ignore[union-attr]
    assert ch._refresh_earnings(deps, [], TODAY, STAMP) == {"status": "no-symbols"}


def test_earnings_use_one_call_per_day(infra: Infra) -> None:
    fake = FakeEarnings([EarningsEvent("AAPL", "2026-10-29", source="alphavantage")])
    deps = make_deps(earnings=fake)
    first = ch._refresh_earnings(deps, ["AAPL", "ASML.AS"], TODAY, STAMP)
    assert first == {"status": "ok", "symbols": 1, "events": 1, "staleDeleted": 0}
    assert fake.calls == [["AAPL"]]
    assert ch._refresh_earnings(deps, ["AAPL"], TODAY, STAMP) == {"status": "budget-exhausted"}
    assert len(fake.calls) == 1
    assert ch._refresh_earnings(deps, ["AAPL"], TODAY + timedelta(days=1), STAMP)["status"] == "ok"
    assert len(fake.calls) == 2


def test_earnings_budget_is_configurable(infra: Infra) -> None:
    fake = FakeEarnings()
    deps = make_deps(earnings=fake, calendar=CalendarSettings(alphavantage_daily_calls=2))
    statuses = [ch._refresh_earnings(deps, ["AAPL"], TODAY, STAMP)["status"] for _ in range(3)]
    assert statuses == ["ok", "ok", "budget-exhausted"]


def test_rescheduled_reports_replace_the_stored_dates_but_history_stays(infra: Infra) -> None:
    deps = make_deps(
        earnings=FakeEarnings([EarningsEvent("AAPL", "2026-11-02", source="alphavantage")]),
        calendar=CalendarSettings(alphavantage_daily_calls=2),
    )
    deps.crepo.put_earnings(
        [
            EarningsEvent("AAPL", "2026-07-30", source="alphavantage"),  # reported already
            EarningsEvent("AAPL", "2026-10-29", source="alphavantage"),  # the old date
            EarningsEvent("MSFT", "2026-10-28", source="alphavantage"),  # not in this feed: untouched
        ],
        STAMP,
    )
    result = ch._refresh_earnings(deps, ["AAPL", "MSFT"], TODAY, STAMP)
    assert result["staleDeleted"] == 1
    assert keys_of(infra, "EARN#") == [
        "TICKER#AAPL|EARN#2026-07-30",
        "TICKER#AAPL|EARN#2026-11-02",
        "TICKER#MSFT|EARN#2026-10-28",
    ]


@pytest.mark.parametrize(
    "error",
    [
        RateLimitError("quota", provider="alphavantage"),
        RetryableProviderError("down", provider="alphavantage"),
        ProviderError("bad", provider="alphavantage"),
        ClientError({"Error": {"Code": "Boom", "Message": "x"}}, "PutItem"),
    ],
)
def test_earnings_failures_are_reported_not_raised(
    infra: Infra, error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    deps = make_deps(earnings=FakeEarnings(error=error), actions=FakeActions())
    infra.track("AAPL")
    with caplog.at_level(logging.WARNING, logger="prices.calendar_handlers"):
        result = ch.run_calendar_refresh(deps, NOW)
    status = "rate-limited" if isinstance(error, RateLimitError) else "failed"
    assert result["earnings"] == {"status": status, "error": type(error).__name__}
    assert "earnings refresh failed" in caplog.text
    # The corporate-action part still runs.
    assert result["corporateActions"]["checkedSymbols"] == ["AAPL"]


def _run_record(infra: Infra, sk: str) -> dict[str, Any] | None:
    return infra.get("CALENDAR", sk)


def test_the_earnings_run_is_recorded_for_the_diagnostics_page(infra: Infra) -> None:
    fake = FakeEarnings([EarningsEvent("GOOGL", "2026-10-28", time_of_day="AMC", source="alphavantage")])
    deps = make_deps(earnings=fake)
    ch._refresh_earnings(deps, ["GOOGL", "AAPL"], TODAY, STAMP)
    last = _run_record(infra, "EARNINGS#LASTRUN")
    assert last is not None
    assert {
        k: last[k] for k in ("at", "trigger", "status", "reason", "tracked", "events", "matchedSymbols")
    } == {
        "at": STAMP,
        "trigger": "scheduled",
        "status": "ok",
        "reason": "",
        "tracked": 2,
        "events": 1,
        "matchedSymbols": ["GOOGL"],
    }
    assert last["entityType"] == "EARNINGS_RUN"
    assert _run_record(infra, "EARNINGS#LASTOK") == {**last, "SK": "EARNINGS#LASTOK"}


def test_a_failed_earnings_run_keeps_the_last_good_record_and_a_clean_reason(infra: Infra) -> None:
    ok = make_deps(earnings=FakeEarnings([EarningsEvent("GOOGL", "2026-10-28", source="alphavantage")]))
    ch._refresh_earnings(ok, ["GOOGL"], TODAY, STAMP)
    boom = ProviderError("alphavantage: 500 for https://x.example/q?apikey=abc", provider="alphavantage")
    failing = make_deps(earnings=FakeEarnings(error=boom))
    ch._refresh_earnings(failing, ["GOOGL"], TODAY + timedelta(days=1), "2026-10-16T05:30:00.000Z")
    last = _run_record(infra, "EARNINGS#LASTRUN")
    assert last is not None
    assert (last["status"], last["reason"]) == ("failed", "alphavantage: 500 for [url]")
    kept = _run_record(infra, "EARNINGS#LASTOK")
    assert kept is not None
    assert (kept["status"], kept["at"]) == ("ok", STAMP)


def test_rate_limits_and_budget_skips_are_recorded_with_their_status(infra: Infra) -> None:
    limited = make_deps(
        earnings=FakeEarnings(
            error=RateLimitError("rate limit " + " ".join(["words"] * 40), provider="alphavantage")
        )
    )
    ch._refresh_earnings(limited, ["AAPL"], TODAY, STAMP)
    last = _run_record(infra, "EARNINGS#LASTRUN")
    assert last is not None
    assert last["status"] == "rate-limited"
    assert len(last["reason"]) == 120
    ch._refresh_earnings(limited, ["AAPL"], TODAY, STAMP)
    skipped = _run_record(infra, "EARNINGS#LASTRUN")
    assert skipped is not None
    assert (skipped["status"], skipped["reason"]) == ("budget-exhausted", "")
    assert _run_record(infra, "EARNINGS#LASTOK") is None


def test_a_reasonless_failure_falls_back_to_the_error_name(infra: Infra) -> None:
    deps = make_deps(earnings=FakeEarnings(error=ProviderError("", provider="alphavantage")))
    ch._refresh_earnings(deps, ["AAPL"], TODAY, STAMP)
    last = _run_record(infra, "EARNINGS#LASTRUN")
    assert last is not None
    assert last["reason"] == "ProviderError"


def test_failing_to_record_the_earnings_run_is_not_fatal(
    infra: Infra, monkeypatch: pytest.MonkeyPatch
) -> None:
    deps = make_deps(earnings=FakeEarnings([EarningsEvent("AAPL", "2026-10-29", source="alphavantage")]))

    def boom(run: dict[str, Any]) -> None:
        raise ClientError({"Error": {"Code": "Boom", "Message": "x"}}, "PutItem")

    monkeypatch.setattr(deps.crepo, "put_earnings_run", boom)
    assert ch._refresh_earnings(deps, ["AAPL"], TODAY, STAMP)["status"] == "ok"


# --------------------------------------------------------------------------- splits and dividends


def test_corporate_actions_without_a_provider(infra: Infra) -> None:
    assert ch._refresh_corporate_actions(make_deps(), ["AAPL"], NOW, TODAY, STAMP) == {
        "status": "no-provider"
    }


def test_symbols_are_checked_oldest_first_within_the_daily_budget(infra: Infra) -> None:
    infra.track("AAPL", "KO", "MSFT", "NVDA")
    actions = FakeActions()
    deps = make_deps(
        actions=actions, calendar=CalendarSettings(eodhd_daily_calls=4)
    )  # 2 symbols (splits + dividends)

    day1 = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT", "NVDA"], NOW, TODAY, STAMP)
    assert (day1["status"], day1["checkedSymbols"], day1["due"]) == ("budget-exhausted", ["AAPL", "KO"], 4)
    assert (day1["splitsWritten"], day1["dividendsWritten"]) == (1, 2)
    # More runs on the same day cannot spend more than the budget.
    day1b = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT", "NVDA"], NOW, TODAY, STAMP)
    assert (day1b["status"], day1b["checkedSymbols"], day1b["due"]) == ("budget-exhausted", [], 2)
    assert actions.split_calls == ["AAPL", "KO"]

    tomorrow = NOW + timedelta(days=1)
    day2 = ch._refresh_corporate_actions(
        deps, ["AAPL", "KO", "MSFT", "NVDA"], tomorrow, tomorrow.date(), STAMP
    )
    assert (day2["status"], day2["checkedSymbols"], day2["due"]) == ("ok", ["MSFT", "NVDA"], 2)
    assert actions.split_calls == ["AAPL", "KO", "MSFT", "NVDA"]
    # Everything was checked within the week: nothing is due on day 3.
    day3 = ch._refresh_corporate_actions(
        deps, ["AAPL", "KO", "MSFT", "NVDA"], NOW + timedelta(days=2), TODAY + timedelta(days=2), STAMP
    )
    assert (day3["status"], day3["due"]) == ("ok", 0)
    # ... and after the re-check interval the oldest ones come round again.
    week = NOW + timedelta(days=8)
    day9 = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT", "NVDA"], week, week.date(), STAMP)
    assert day9["checkedSymbols"] == ["AAPL", "KO"]


def test_dividend_refresh_can_be_turned_off(infra: Infra) -> None:
    actions = FakeActions()
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=2, refresh_dividends=False))
    result = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT"], NOW, TODAY, STAMP)
    assert result["checkedSymbols"] == ["AAPL", "KO"]  # one call each
    assert actions.dividend_calls == []
    marker = infra.get("TICKER#AAPL", "CAL#STATE")
    assert marker is not None
    assert "dividendsCheckedAt" not in marker


def test_a_zero_budget_checks_nothing(infra: Infra) -> None:
    actions = FakeActions()
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=0))
    result = ch._refresh_corporate_actions(deps, ["AAPL"], NOW, TODAY, STAMP)
    assert (result["status"], result["checked"]) == ("budget-exhausted", 0)
    assert actions.split_calls == []


def test_unbudgeted_sources_check_every_due_symbol(infra: Infra) -> None:
    actions = FakeActions(budgeted=False)
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=0))
    result = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT"], NOW, TODAY, STAMP)
    assert result["checkedSymbols"] == ["AAPL", "KO", "MSFT"]


def test_one_failing_symbol_does_not_stop_the_others_and_goes_to_the_back(
    infra: Infra, caplog: pytest.LogCaptureFixture
) -> None:
    actions = FakeActions(fail={"KO": RetryableProviderError("boom", provider="eodhd")})
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=100))
    with caplog.at_level(logging.WARNING, logger="prices.calendar_handlers"):
        result = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT"], NOW, TODAY, STAMP)
    assert result["checkedSymbols"] == ["AAPL", "MSFT"]
    assert (result["failed"], result["failedSymbols"], result["status"]) == (1, ["KO"], "ok")
    assert "calendar check failed" in caplog.text
    ko = infra.get("TICKER#KO", "CAL#STATE")
    assert ko is not None
    assert ko["splitsFailedAt"] == STAMP
    assert "splitsCheckedAt" not in ko  # still due next time ...
    # A failed symbol stays due: only successful checks postpone the next one.
    states = deps.crepo.get_states(["AAPL", "KO", "MSFT"])
    assert ch.due_symbols(["AAPL", "KO", "MSFT"], states, NOW + timedelta(days=8), 7) == [
        "AAPL",
        "KO",
        "MSFT",
    ]
    assert ch.due_symbols(["AAPL", "KO", "MSFT"], states, NOW + timedelta(days=1), 7) == ["KO"]


def test_unknown_symbols_and_storage_errors_are_failures_too(infra: Infra) -> None:
    actions = FakeActions(
        fail={
            "ZZZ": SymbolNotFoundError("nope", provider="eodhd"),
            "KO": ClientError({"Error": {"Code": "X", "Message": "m"}}, "PutItem"),
        }
    )
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=100))
    result = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "ZZZ"], NOW, TODAY, STAMP)
    assert result["failedSymbols"] == ["KO", "ZZZ"]
    assert result["checkedSymbols"] == ["AAPL"]


def test_a_provider_rate_limit_stops_the_run(infra: Infra, caplog: pytest.LogCaptureFixture) -> None:
    actions = FakeActions(fail={"KO": RateLimitError("daily limit", provider="eodhd")})
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=100))
    with caplog.at_level(logging.WARNING, logger="prices.calendar_handlers"):
        result = ch._refresh_corporate_actions(deps, ["AAPL", "KO", "MSFT"], NOW, TODAY, STAMP)
    assert (result["status"], result["checkedSymbols"]) == ("rate-limited", ["AAPL"])
    assert actions.split_calls == ["AAPL", "KO"]  # MSFT is never tried
    assert "provider limit reached" in caplog.text


def test_failing_to_record_a_failure_is_not_fatal(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    actions = FakeActions(fail={"AAPL": ProviderError("bad", provider="eodhd")})
    deps = make_deps(actions=actions, calendar=CalendarSettings(eodhd_daily_calls=100))

    def broken(symbol: str, **attrs: str) -> None:
        raise ClientError({"Error": {"Code": "Throttled", "Message": "m"}}, "UpdateItem")

    monkeypatch.setattr(deps.crepo, "put_state", broken)
    result = ch._refresh_corporate_actions(deps, ["AAPL"], NOW, TODAY, STAMP)
    assert result["failedSymbols"] == ["AAPL"]


def test_due_symbols_orders_by_last_attempt() -> None:
    states: dict[str, dict[str, Any]] = {
        "A": {"splitsCheckedAt": "2026-10-01T00:00:00.000Z"},
        "B": {"splitsCheckedAt": "2026-10-05T00:00:00.000Z"},
        "C": {"splitsCheckedAt": "2026-10-14T00:00:00.000Z"},  # fresh
        "D": {"splitsFailedAt": "2026-10-03T00:00:00.000Z"},
    }
    assert ch.due_symbols(["C", "B", "A", "D", "E", "F"], states, NOW, 7) == [
        "E",
        "F",
        "A",
        "D",
        "B",
    ]  # D failed after A was checked
    assert ch.due_symbols([], states, NOW, 7) == []


def test_a_live_run_without_api_keys_does_nothing_but_succeeds(
    infra: Infra, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "live")
    infra.track("AAPL")
    result = ch.calendar_refresh({}, Ctx())
    assert result["earnings"] == {"status": "no-provider"}
    assert result["corporateActions"] == {"status": "no-provider"}
    assert infra.items("TICKER#AAPL") == []


def test_the_summary_never_contains_api_keys(infra: Infra, caplog: pytest.LogCaptureFixture) -> None:
    infra.track("AAPL")
    deps = make_deps(
        earnings=FakeEarnings(error=ProviderError("failed https://x/?apikey=***", provider="alphavantage"))
    )
    with caplog.at_level(logging.INFO):
        result = ch.run_calendar_refresh(deps, NOW)
    assert "secret-key" not in str(result) + caplog.text
