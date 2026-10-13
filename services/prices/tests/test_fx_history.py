"""Daily ECB fixings (FX_DAY items): Frankfurter time series, mock series, repository, refresh, CLI."""

from __future__ import annotations

import itertools
import json
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

from prices import handlers, keys, local
from prices.config import Settings
from prices.errors import ProviderError, RetryableProviderError
from prices.models import FxDay, FxRates
from prices.providers.frankfurter import FrankfurterFx, has_weekday, year_chunks
from prices.providers.mock import MockFx, mock_eur_rate
from tests.conftest import FakeOpener, Infra

NOW = datetime(2026, 10, 13, 16, 30, tzinfo=UTC)  # Tuesday, inside the default EU window
TODAY = NOW.date()


# --------------------------------------------------------------------------- Frankfurter


def test_year_chunks_never_cross_a_calendar_year() -> None:
    assert list(year_chunks(date(2014, 6, 15), date(2016, 2, 10))) == [
        (date(2014, 6, 15), date(2014, 12, 31)),
        (date(2015, 1, 1), date(2015, 12, 31)),
        (date(2016, 1, 1), date(2016, 2, 10)),
    ]
    assert list(year_chunks(date(2026, 10, 13), date(2026, 10, 13))) == [(TODAY, TODAY)]
    assert list(year_chunks(date(2026, 10, 14), date(2026, 10, 13))) == []
    assert has_weekday(date(2026, 10, 16), date(2026, 10, 16))  # Friday
    assert not has_weekday(date(2026, 10, 17), date(2026, 10, 18))  # weekend only
    assert has_weekday(date(2026, 10, 17), date(2027, 3, 1))


def test_frankfurter_history_chunks_requests_per_year_and_parses(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add(
        "2024-12-30..2024-12-31",
        {
            "amount": 1.0,
            "base": "EUR",
            "start_date": "2024-12-30",
            "end_date": "2024-12-31",
            "rates": {
                "2024-12-31": {"USD": 1.0389, "GBP": "0.82918", "EUR": 1, "BAD": "x", "NEG": -1},
                "2024-12-30": {"usd": 1.0444, "JPY": 163.65},
            },
        },
    )
    opener.add(
        "2025-01-01..2025-12-31",
        {
            "base": "EUR",
            # a non-business start date is snapped back to the previous fixing -> must be dropped
            "start_date": "2024-12-31",
            "rates": {
                "2024-12-31": {"USD": 9.9},
                "2025-01-02": {"USD": 1.0321},
                "2025-01-03": {},
                "2025-01-06": "garbage",
                "2025-12-31": {"USD": 1.1750},
            },
        },
    )
    opener.add("2026-01-01..2026-01-05", {"base": "EUR", "rates": {"2026-01-02": {"USD": 1.17}}})

    days = FrankfurterFx(http=http_factory("frankfurter")).get_history(
        "eur", date(2024, 12, 30), date(2026, 1, 5)
    )

    assert opener.urls == [
        "https://api.frankfurter.dev/v1/2024-12-30..2024-12-31?base=EUR",
        "https://api.frankfurter.dev/v1/2025-01-01..2025-12-31?base=EUR",
        "https://api.frankfurter.dev/v1/2026-01-01..2026-01-05?base=EUR",
    ]
    assert days == [
        FxDay("EUR", "2024-12-30", {"USD": 1.0444, "JPY": 163.65}),
        FxDay("EUR", "2024-12-31", {"USD": 1.0389, "GBP": 0.82918}),
        FxDay("EUR", "2025-01-02", {"USD": 1.0321}),
        FxDay("EUR", "2025-12-31", {"USD": 1.175}),
        FxDay("EUR", "2026-01-02", {"USD": 1.17}),
    ]


def test_frankfurter_history_skips_weekend_and_holiday_chunks(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    fx = FrankfurterFx(http=http_factory("frankfurter"))
    assert fx.get_history("EUR", date(2026, 10, 17), date(2026, 10, 18)) == []  # weekend: no request
    assert opener.urls == []

    opener.add("2025-12-25..2025-12-26", 404)  # only TARGET holidays
    opener.add("2026-01-01..2026-01-01", {"base": "EUR"})  # no rates at all
    assert fx.get_history("EUR", date(2025, 12, 25), date(2025, 12, 26)) == []
    assert fx.get_history("EUR", date(2026, 1, 1), date(2026, 1, 1)) == []
    assert len(opener.urls) == 2


@pytest.mark.parametrize(
    "payload",
    [None, ["not", "a", "dict"], {"base": "USD", "rates": {}}, {"base": "EUR", "rates": ["x"]}],
)
def test_frankfurter_history_rejects_malformed_payloads(
    payload: Any, opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("..", payload)
    with pytest.raises(ProviderError):
        FrankfurterFx(http=http_factory("frankfurter")).get_history("EUR", TODAY, TODAY)


def test_frankfurter_history_propagates_retryable_errors(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("..", 503)
    with pytest.raises(RetryableProviderError):
        FrankfurterFx(http=http_factory("frankfurter")).get_history("EUR", TODAY, TODAY)


def test_frankfurter_latest_records_fixing_date(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add(
        "latest",
        [
            {"base": "EUR", "date": "2026-10-12", "rates": {"USD": 1.16, "EUR": 1}},
            {"rates": {"USD": 1.16}},
        ],
    )
    fx = FrankfurterFx(http=http_factory("frankfurter"))
    first = fx.get_latest("EUR")
    assert first.date == "2026-10-12" and first.rates == {"USD": 1.16}
    second = fx.get_latest("EUR")
    assert second.date is None and second.base == "EUR"


# --------------------------------------------------------------------------- mock FX


def test_mock_fx_history_is_deterministic_business_days_only_and_smooth() -> None:
    a = MockFx(now=lambda: NOW).get_history("EUR", date(2026, 9, 1), date(2026, 12, 31))
    b = MockFx(now=lambda: NOW).get_history("EUR", date(2026, 9, 1), date(2026, 12, 31))
    assert a == b and a[0].date == "2026-09-01" and a[-1].date == "2026-10-13"  # clamped to today
    assert all(date.fromisoformat(d.date).weekday() < 5 for d in a)
    assert len(a) == 31  # weekdays 2026-09-01..2026-10-13
    for prev, cur in itertools.pairwise(a):
        assert set(cur.rates) == {"USD", "GBP", "CHF", "SEK", "DKK", "NOK", "CAD", "JPY"}
        for c, r in cur.rates.items():
            assert abs(r / prev.rates[c] - 1) < 0.01
    assert a[0].rates["USD"] == mock_eur_rate("USD", date(2026, 9, 1))
    assert all(abs(d.rates["DKK"] / 7.46 - 1) < 0.003 for d in a)  # pegged
    latest = MockFx(now=lambda: NOW).get_latest("EUR")
    assert latest.date == a[-1].date and latest.rates == a[-1].rates


def test_mock_fx_history_other_base_and_errors() -> None:
    days = MockFx(now=lambda: NOW).get_history("USD", TODAY, TODAY)
    eur = MockFx(now=lambda: NOW).get_latest("EUR").rates
    assert days[0].base == "USD" and days[0].rates["EUR"] == pytest.approx(1 / eur["USD"], rel=1e-5)
    with pytest.raises(ProviderError):
        MockFx(now=lambda: NOW).get_history("XXX", TODAY, TODAY)


# --------------------------------------------------------------------------- keys / repository / config


def test_fx_day_item_shape() -> None:
    item = keys.fx_day_item(FxDay("EUR", "2026-10-13", {"USD": 1.1612, "JPY": 175, "EUR": 1.0}))
    assert item == {
        "PK": "FX#EUR",
        "SK": "DAY#2026-10-13",
        "entityType": "FX_DAY",
        "base": "EUR",
        "date": "2026-10-13",
        "rates": {"JPY": Decimal("175"), "USD": Decimal("1.1612")},
    }
    assert keys.fx_day_key("EUR", "2026-10-13") == {"PK": "FX#EUR", "SK": "DAY#2026-10-13"}
    # the LATEST item keeps the FxRates shape even when the fixing date is known
    latest = keys.fx_item(FxRates("EUR", "t", {"USD": 1.1}, date="2026-10-13"))
    assert set(latest) == {"PK", "SK", "entityType", "base", "asOf", "rates"}


def test_repository_latest_fx_day_and_put(infra: Infra) -> None:
    repo = handlers.get_deps().repo
    assert repo.latest_fx_day("EUR") is None
    repo.put_fx(FxRates("EUR", "t", {"USD": 1.1}))  # SK LATEST must not match the DAY# prefix
    days = [FxDay("EUR", d, {"USD": 1.1}) for d in ("2026-10-09", "2026-10-12", "2026-10-08")]
    assert repo.put_fx_days(days) == 3
    assert repo.put_fx_days([FxDay("USD", "2026-10-13", {"EUR": 0.9})]) == 1
    assert repo.latest_fx_day("EUR") == "2026-10-12"
    assert repo.latest_fx_day("USD") == "2026-10-13"
    assert repo.latest_fx_day("GBP") is None
    assert infra.get("FX#EUR", "DAY#2026-10-09") == {
        "PK": "FX#EUR",
        "SK": "DAY#2026-10-09",
        "entityType": "FX_DAY",
        "base": "EUR",
        "date": "2026-10-09",
        "rates": {"USD": Decimal("1.1")},
    }


def test_settings_fx_history_start(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FX_HISTORY_START")
    assert Settings.from_env().fx_history_start == date(2015, 1, 1)
    monkeypatch.setenv("FX_HISTORY_START", "  ")
    assert Settings.from_env().fx_history_start == date(2015, 1, 1)
    monkeypatch.setenv("FX_HISTORY_START", "2020-03-02")
    assert Settings.from_env().fx_history_start == date(2020, 3, 2)


# --------------------------------------------------------------------------- scheduled refresh


class RecordingFx:
    """Mock FX that records history calls and can be told to fail."""

    name = "recording"

    def __init__(self, *, history_error: Exception | None = None, latest_error: Exception | None = None):
        self.inner = MockFx(now=lambda: NOW)
        self.calls: list[tuple[str, date, date]] = []
        self.history_error = history_error
        self.latest_error = latest_error

    def get_latest(self, base: str) -> FxRates:
        if self.latest_error:
            raise self.latest_error
        return self.inner.get_latest(base)

    def get_history(self, base: str, start: date, end: date) -> list[FxDay]:
        self.calls.append((base, start, end))
        if self.history_error:
            raise self.history_error
        return self.inner.get_history(base, start, end)


def fx_days(infra: Infra) -> list[str]:
    return [i["date"] for i in infra.items("FX#EUR") if i["SK"].startswith("DAY#")]


def test_initial_backfill_starts_at_fx_history_start(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FX_HISTORY_START", "2026-09-28")
    deps = handlers.get_deps()
    deps.fx = fx = RecordingFx()
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert fx.calls == [("EUR", date(2026, 9, 28), TODAY)]
    assert summary["fxHistoryOk"] is True and summary["fxDaysWritten"] == 12
    assert fx_days(infra)[0] == "2026-09-28" and fx_days(infra)[-1] == "2026-10-13"
    assert "2026-10-03" not in fx_days(infra)  # no weekend items


def test_gap_backfill_starts_after_latest_stored_day(infra: Infra) -> None:
    deps = handlers.get_deps()
    deps.repo.put_fx_days([FxDay("EUR", "2026-10-07", {"USD": 1.1})])
    deps.fx = fx = RecordingFx()
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert fx.calls == [("EUR", date(2026, 10, 8), TODAY)]
    assert fx_days(infra) == ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]
    assert summary["fxDaysWritten"] == 4

    # up to date: no history request, nothing rewritten
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert len(fx.calls) == 1 and summary["fxDaysWritten"] == 0 and summary["fxHistoryOk"] is True


def test_latest_fixing_newer_than_history_is_written(infra: Infra) -> None:
    deps = handlers.get_deps()
    deps.repo.put_fx_days([FxDay("EUR", "2026-10-12", {"USD": 1.1})])
    deps.fx = RecordingFx()
    deps.fx.get_history = lambda base, start, end: []  # type: ignore[method-assign]  # not yet published
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert summary["fxDaysWritten"] == 1 and fx_days(infra) == ["2026-10-12", "2026-10-13"]
    latest = infra.get("FX#EUR", "LATEST")
    assert infra.get("FX#EUR", "DAY#2026-10-13")["rates"] == latest["rates"]


def test_history_failure_is_isolated_and_today_is_not_written(infra: Infra) -> None:
    infra.track("AAPL")
    deps = handlers.get_deps()
    deps.repo.put_fx_days([FxDay("EUR", "2026-10-07", {"USD": 1.1})])
    deps.fx = RecordingFx(history_error=RetryableProviderError("frankfurter down"))
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert summary["refreshed"] == 1 and summary["fxUpdated"] is True
    assert summary["fxHistoryOk"] is False and summary["fxDaysWritten"] == 0
    assert fx_days(infra) == ["2026-10-07"]  # gap stays detectable for the next run
    assert infra.get("FX#EUR", "LATEST") is not None


def test_storage_failure_is_isolated(infra: Infra) -> None:
    infra.track("AAPL")
    deps = handlers.get_deps()
    deps.fx = RecordingFx()

    def boom(days: Any) -> int:
        raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "x"}}, "BatchWriteItem")

    deps.repo.put_fx_days = boom  # type: ignore[method-assign]
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert summary["refreshed"] == 1 and summary["fxHistoryOk"] is False and summary["fxDaysWritten"] == 0


def test_latest_failure_still_backfills_history(infra: Infra) -> None:
    deps = handlers.get_deps()
    deps.fx = RecordingFx(latest_error=RetryableProviderError("latest down"))
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert summary["fxUpdated"] is False and summary["fxHistoryOk"] is True
    assert summary["fxDaysWritten"] == 9 and infra.get("FX#EUR", "LATEST") is None


def test_scheduled_refresh_with_frankfurter_end_to_end(
    infra: Infra, opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("latest", {"base": "EUR", "date": "2026-10-13", "rates": {"USD": 1.16, "GBP": 0.87}})
    opener.add(
        "2026-10-01..2026-10-13",
        {
            "base": "EUR",
            "rates": {
                "2026-10-01": {"USD": 1.15, "GBP": 0.86},
                "2026-10-02": {"USD": 1.151, "GBP": 0.861},
            },
        },
    )
    deps = handlers.get_deps()
    deps.fx = FrankfurterFx(http=http_factory("frankfurter"))
    summary = handlers.run_scheduled_refresh(deps, NOW)
    assert summary["fxDaysWritten"] == 3  # two from history + today's fixing from /latest
    assert fx_days(infra) == ["2026-10-01", "2026-10-02", "2026-10-13"]
    assert infra.get("FX#EUR", "DAY#2026-10-13") == {
        "PK": "FX#EUR",
        "SK": "DAY#2026-10-13",
        "entityType": "FX_DAY",
        "base": "EUR",
        "date": "2026-10-13",
        "rates": {"GBP": Decimal("0.87"), "USD": Decimal("1.16")},
    }


# --------------------------------------------------------------------------- CLI


def test_local_fx_backfill_command(
    infra: Infra, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("AWS_ENDPOINT_URL", "")
    today = datetime.now(UTC).date()
    start = today - timedelta(days=13)
    assert local.main(["fx-backfill", "--start", start.isoformat()]) == 0
    out = json.loads(capsys.readouterr().out)
    weekdays = sum((start + timedelta(days=i)).weekday() < 5 for i in range(14))
    assert out["fxDaysWritten"] == weekdays and out["start"] == start.isoformat()
    assert out["end"] == today.isoformat() and out["base"] == "EUR"
    assert len(fx_days(infra)) == weekdays

    # without --start: continues after the latest stored day -> nothing left to do
    assert local.main(["fx-backfill"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert (
        out["fxDaysWritten"] == 0
        and out["start"] == (date.fromisoformat(out["lastDay"]) + timedelta(days=1)).isoformat()
    )


def test_local_fx_backfill_rejects_bad_date(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        local.main(["fx-backfill", "--start", "13-10-2026"])
    assert "invalid" in capsys.readouterr().err
