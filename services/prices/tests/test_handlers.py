from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
import time_machine

from prices import handlers
from prices.errors import (
    ProviderUnavailableError,
    RateLimitError,
    RetryableProviderError,
    SymbolNotFoundError,
)
from prices.handlers import amsterdam_hour, parse_symbols
from prices.logging_setup import JsonFormatter, setup_logging
from prices.models import DividendEvent, EodPrice, InstrumentProfile, Quote
from prices.providers.mock import MockFx, MockProvider
from tests.conftest import Infra

EU_WINDOW = datetime(2026, 10, 13, 16, 30, tzinfo=UTC)  # 18:30 Europe/Amsterdam (CEST)
OFF_WINDOW = datetime(2026, 10, 13, 10, 0, tzinfo=UTC)  # 12:00 Europe/Amsterdam


class Ctx:
    aws_request_id = "req-123"


def mock_at(now: datetime) -> MockProvider:
    return MockProvider(now=lambda: now)


# --------------------------------------------------------------------------- scheduled_refresh


def test_scheduled_refresh_writes_exact_items_and_emits_event(infra: Infra) -> None:
    infra.track("AAPL", "ASML.AS", "BTC-EUR")
    with time_machine.travel(EU_WINDOW, tick=False):
        summary = handlers.scheduled_refresh({}, Ctx())

    assert summary["refreshed"] == 3 and summary["skipped"] == 0 and summary["failed"] == 0
    assert summary["fxUpdated"] and summary["eventPublished"] and summary["euWindow"]

    expected = mock_at(EU_WINDOW).get_quotes(["AAPL", "ASML.AS", "BTC-EUR"])
    quote = infra.get("TICKER#AAPL", "QUOTE#LATEST")
    assert quote == {
        "PK": "TICKER#AAPL",
        "SK": "QUOTE#LATEST",
        "entityType": "QUOTE",
        "symbol": "AAPL",
        "price": Decimal(repr(expected["AAPL"].price)),
        "previousClose": Decimal(repr(expected["AAPL"].previous_close)),
        "currency": "USD",
        "asOf": "2026-10-13T16:30:00.000Z",
        "source": "mock",
    }
    eod = infra.get("TICKER#ASML.AS", "EOD#2026-10-13")
    assert eod == {
        "PK": "TICKER#ASML.AS",
        "SK": "EOD#2026-10-13",
        "entityType": "EOD",
        "symbol": "ASML.AS",
        "date": "2026-10-13",
        "close": Decimal(repr(expected["ASML.AS"].price)),
        "currency": "EUR",
    }
    fx = infra.get("FX#EUR", "LATEST")
    assert fx is not None
    assert set(fx) == {"PK", "SK", "entityType", "base", "rates", "asOf"}
    latest_usd = MockFx(now=lambda: EU_WINDOW).get_latest("EUR").rates["USD"]
    assert (
        fx["entityType"] == "FX" and fx["base"] == "EUR" and fx["rates"]["USD"] == Decimal(repr(latest_usd))
    )
    assert all(isinstance(v, Decimal) for v in fx["rates"].values())
    day = infra.get("FX#EUR", "DAY#2026-10-13")
    assert day is not None and day["rates"] == fx["rates"]
    assert summary["fxHistoryOk"] is True and summary["fxDaysWritten"] == 9  # 2026-10-01..13, weekdays

    events = infra.events()
    assert len(events) == 1
    ev = events[0]
    assert ev["source"] == "portfolio.prices" and ev["detail-type"] == "PricesUpdated"
    assert ev["detail"] == {
        "symbols": ["AAPL", "ASML.AS", "BTC-EUR"],
        "asOf": "2026-10-13T16:30:00.000Z",
        "trigger": "scheduled",
    }


def test_eu_hour_gating(infra: Infra) -> None:
    infra.track("AAPL", "ASML.AS", "SAP.DE", "MC.PA", "BTC-EUR")
    fresh = Quote("ASML.AS", 700, 690, "EUR", "2026-10-12T16:00:00.000Z", "mock")  # 18h old
    stale = Quote("SAP.DE", 200, 199, "EUR", "2026-10-12T09:00:00.000Z", "mock")  # 25h old
    deps = handlers.get_deps()
    deps.repo.put_quote(fresh)
    deps.repo.put_quote(stale)

    with time_machine.travel(OFF_WINDOW, tick=False):
        summary = handlers.scheduled_refresh({}, Ctx())
    assert summary["euWindow"] is False
    assert summary["skippedSymbols"] == ["ASML.AS"]
    assert summary["refreshed"] == 4  # AAPL, BTC-EUR, stale SAP.DE, never-quoted MC.PA
    assert infra.get("TICKER#ASML.AS", "QUOTE#LATEST")["price"] == Decimal(700)
    assert infra.get("TICKER#SAP.DE", "QUOTE#LATEST")["asOf"] == "2026-10-13T10:00:00.000Z"
    assert infra.events()[0]["detail"]["symbols"] == ["AAPL", "BTC-EUR", "MC.PA", "SAP.DE"]


def test_eu_refresh_hours_env(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EU_REFRESH_HOURS", "9, 12")
    infra.track("ASML.AS")
    handlers.get_deps().repo.put_quote(Quote("ASML.AS", 1, 1, "EUR", "2026-10-13T09:00:00.000Z", "mock"))
    with time_machine.travel(OFF_WINDOW, tick=False):
        summary = handlers.scheduled_refresh({}, Ctx())
    assert summary["euWindow"] and summary["refreshed"] == 1


class FlakyProvider(MockProvider):
    """Mock provider whose quotes fail for selected symbols."""

    def __init__(self, failures: dict[str, Exception], now: datetime) -> None:
        super().__init__(now=lambda: now)
        self.failures = failures
        self.calls: list[tuple[str, Any]] = []

    def _check(self, symbol: str) -> None:
        if symbol in self.failures:
            raise self.failures[symbol]

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        self.calls.append(("quotes", list(symbols)))
        for s in symbols:
            if s in self.failures and isinstance(self.failures[s], RuntimeError):
                raise self.failures[s]
        return super().get_quotes([s for s in symbols if s not in self.failures])

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        self.calls.append(("eod", symbol))
        self._check(symbol)
        return super().get_eod_history(symbol, start, end)

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        self.calls.append(("profile", symbol))
        return None if symbol.startswith("NOPROF") else super().get_profile(symbol)

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        self.calls.append(("div", symbol))
        return super().get_dividends(symbol, start, end)


class BrokenFx:
    name = "broken"

    def get_latest(self, base: str) -> Any:
        raise RetryableProviderError("fx down")


def test_scheduled_refresh_counts_failures_without_raising(infra: Infra) -> None:
    infra.track("AAPL", "GONE", "MSFT")
    deps = handlers.get_deps()
    deps.provider = FlakyProvider({"GONE": SymbolNotFoundError("nope")}, EU_WINDOW)
    deps.fx = BrokenFx()
    summary = handlers.run_scheduled_refresh(deps, EU_WINDOW)
    assert (summary["refreshed"], summary["failed"], summary["fxUpdated"]) == (2, 1, False)
    assert summary["failedSymbols"] == ["GONE"]
    assert infra.get("FX#EUR", "LATEST") is None


def test_scheduled_refresh_provider_crash(infra: Infra) -> None:
    infra.track("AAPL")
    deps = handlers.get_deps()
    deps.provider = FlakyProvider({"AAPL": RuntimeError("bug")}, EU_WINDOW)
    summary = handlers.run_scheduled_refresh(deps, EU_WINDOW)
    assert summary["failed"] == 1 and summary["refreshed"] == 0 and summary["eventPublished"] is False
    assert infra.events() == []


def test_scheduled_refresh_nothing_tracked(infra: Infra) -> None:
    with time_machine.travel(EU_WINDOW, tick=False):
        summary = handlers.scheduled_refresh(None, Ctx())
    assert (summary["refreshed"], summary["skipped"], summary["failed"]) == (0, 0, 0)
    assert summary["fxUpdated"] is True and infra.events() == []


def test_publish_failure_is_logged_not_raised(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVENT_BUS_NAME", "does-not-exist")
    handlers.reset()
    infra.track("AAPL")
    with time_machine.travel(EU_WINDOW, tick=False):
        summary = handlers.scheduled_refresh({}, Ctx())
    assert summary["refreshed"] == 1 and summary["eventPublished"] is False


def test_unavailable_provider_counts_as_skipped(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "live")
    monkeypatch.setenv("FX_PROVIDER", "mock")
    infra.track("AAPL", "BTC-EUR")
    with time_machine.travel(EU_WINDOW, tick=False):
        summary = handlers.scheduled_refresh({}, Ctx())
    assert summary["skippedSymbols"] == ["AAPL", "BTC-EUR"] and summary["failed"] == 0


# --------------------------------------------------------------------------- on_transactions_changed


def envelope(symbols: list[str], **detail: Any) -> str:
    return json.dumps(
        {
            "version": "0",
            "id": "e1",
            "detail-type": "TransactionsChanged",
            "source": "portfolio.api",
            "detail": {"userId": "demo", "symbols": symbols, "reason": "CREATED", **detail},
        }
    )


def sqs(*bodies: str) -> dict[str, Any]:
    return {"Records": [{"messageId": f"m{i}", "body": b} for i, b in enumerate(bodies, 1)]}


def test_enrichment_only_for_missing_profiles(infra: Infra) -> None:
    deps = handlers.get_deps()
    deps.repo.put_profile(InstrumentProfile("ASML.AS", "ASML", "STOCK", "EUR"))
    spy = FlakyProvider({}, EU_WINDOW)
    deps.provider = spy

    event = sqs(
        envelope(["AAPL", "asml.as"]), envelope(["AAPL", "BTC-EUR"], reason="IMPORTED", importId="i1")
    )
    with time_machine.travel(EU_WINDOW, tick=False):
        result = handlers.on_transactions_changed(event, Ctx())
    assert result == {"batchItemFailures": []}
    assert ("profile", "ASML.AS") not in spy.calls
    assert sorted(c[1] for c in spy.calls if c[0] == "profile") == ["AAPL", "BTC-EUR"]

    profile = infra.get("TICKER#AAPL", "PROFILE")
    assert profile == {
        "PK": "TICKER#AAPL",
        "SK": "PROFILE",
        "entityType": "PROFILE",
        "symbol": "AAPL",
        "name": "Apple Inc.",
        "assetClass": "STOCK",
        "currency": "USD",
        "sector": "Technology",
        "country": "United States",
        "exchange": "NASDAQ",
    }
    eods = [i for i in infra.items("TICKER#AAPL") if i["SK"].startswith("EOD#")]
    assert 250 <= len(eods) <= 262
    assert all(
        i["entityType"] == "EOD"
        and set(i) == {"PK", "SK", "entityType", "symbol", "date", "close", "currency"}
        for i in eods
    )
    assert eods[-1]["SK"] == "EOD#2026-10-13"
    divs = [i for i in infra.items("TICKER#AAPL") if i["SK"].startswith("DIV#")]
    assert len(divs) == 12  # quarterly, 2y back + 1y ahead
    assert divs[0] == {
        "PK": "TICKER#AAPL",
        "SK": "DIV#2024-11-10",
        "entityType": "DIVIDEND_EVENT",
        "symbol": "AAPL",
        "exDate": "2024-11-10",
        "payDate": "2024-11-14",
        "amount": Decimal("0.26"),
        "currency": "USD",
    }
    assert any(d["exDate"] > "2026-10-13" for d in divs)
    assert infra.get("TICKER#AAPL", "QUOTE#LATEST")["entityType"] == "QUOTE"
    tracked = infra.get("TRACKED", "TICKER#BTC-EUR")
    assert tracked == {
        "PK": "TRACKED",
        "SK": "TICKER#BTC-EUR",
        "entityType": "TRACKED_TICKER",
        "symbol": "BTC-EUR",
        "createdAt": "2026-10-13T16:30:00.000Z",
        "updatedAt": "2026-10-13T16:30:00.000Z",
    }
    assert infra.get("TICKER#ASML.AS", "QUOTE#LATEST") is None

    events = infra.events()
    assert [e["detail"] for e in events] == [
        {"symbols": ["AAPL", "BTC-EUR"], "asOf": "2026-10-13T16:30:00.000Z", "trigger": "enrichment"}
    ]

    # Idempotent redelivery: nothing re-fetched, nothing re-emitted.
    spy.calls.clear()
    before = infra.items()
    with time_machine.travel(EU_WINDOW + timedelta(minutes=5), tick=False):
        assert handlers.on_transactions_changed(event, Ctx()) == {"batchItemFailures": []}
    assert spy.calls == [] and infra.events() == [] and infra.items() == before


def test_existing_tracked_item_preserved(infra: Infra) -> None:
    infra.track("AAPL")
    handlers.get_deps().provider = mock_at(EU_WINDOW)
    handlers.run_enrichment(handlers.get_deps(), sqs(envelope(["AAPL"])), EU_WINDOW)
    assert "createdAt" not in infra.get("TRACKED", "TICKER#AAPL")


def test_retryable_failure_reports_only_affected_messages(infra: Infra) -> None:
    deps = handlers.get_deps()
    deps.provider = FlakyProvider(
        {"SLOW": RateLimitError("429"), "GONE": SymbolNotFoundError("unknown")}, EU_WINDOW
    )
    event = sqs(envelope(["AAPL", "SLOW"]), envelope(["MSFT"]), envelope(["GONE"]), envelope(["SLOW"]))
    result = handlers.run_enrichment(deps, event, EU_WINDOW)
    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}, {"itemIdentifier": "m4"}]}
    assert infra.get("TICKER#SLOW", "PROFILE") is None
    assert infra.get("TICKER#GONE", "PROFILE") is None
    assert infra.get("TICKER#AAPL", "PROFILE") is not None and infra.get("TICKER#MSFT", "PROFILE") is not None
    assert infra.events()[0]["detail"]["symbols"] == ["AAPL", "MSFT"]


def test_retryable_quote_failure(infra: Infra) -> None:
    class QuoteThrottled(FlakyProvider):
        def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
            raise RetryableProviderError("503")

    deps = handlers.get_deps()
    deps.provider = QuoteThrottled({}, EU_WINDOW)
    result = handlers.run_enrichment(deps, sqs(envelope(["AAPL"])), EU_WINDOW)
    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}]}
    assert infra.get("TICKER#AAPL", "PROFILE") is None


def test_fallback_profile_and_quote_from_history(infra: Infra) -> None:
    class NoQuotes(FlakyProvider):
        def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
            return {}

    deps = handlers.get_deps()
    deps.provider = NoQuotes({}, EU_WINDOW)
    handlers.run_enrichment(deps, sqs(envelope(["NOPROF.AS"])), EU_WINDOW)
    profile = infra.get("TICKER#NOPROF.AS", "PROFILE")
    assert (
        profile["assetClass"] == "OTHER" and profile["currency"] == "EUR" and profile["name"] == "NOPROF.AS"
    )
    quote = infra.get("TICKER#NOPROF.AS", "QUOTE#LATEST")
    assert quote["source"] == "mock-eod" and quote["asOf"] == "2026-10-13T00:00:00.000Z"


def test_unavailable_provider_acks(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "live")
    result = handlers.on_transactions_changed(sqs(envelope(["AAPL", "BTC-EUR"])), Ctx())
    assert result == {"batchItemFailures": []}
    assert infra.items() == []


def test_unexpected_error_is_retried(infra: Infra) -> None:
    class Buggy(FlakyProvider):
        def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
            raise KeyError("bug")

    deps = handlers.get_deps()
    deps.provider = Buggy({}, EU_WINDOW)
    assert handlers.run_enrichment(deps, sqs(envelope(["AAPL"])), EU_WINDOW) == {
        "batchItemFailures": [{"itemIdentifier": "m1"}]
    }


def test_non_retryable_dividend_error_tolerated(infra: Infra) -> None:
    class NoDivs(FlakyProvider):
        def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
            raise ProviderUnavailableError("no eodhd")

    deps = handlers.get_deps()
    deps.provider = NoDivs({}, EU_WINDOW)
    assert handlers.run_enrichment(deps, sqs(envelope(["AAPL"])), EU_WINDOW) == {"batchItemFailures": []}
    assert infra.get("TICKER#AAPL", "PROFILE") is not None


def test_malformed_messages_are_acked(infra: Infra) -> None:
    event = {
        "Records": [
            {"messageId": "bad1", "body": "not json"},
            {"messageId": "bad2", "body": "[1]"},
            {"messageId": "bad3", "body": json.dumps({"detail": {"userId": "x"}})},
        ]
    }
    assert handlers.run_enrichment(handlers.get_deps(), event, EU_WINDOW) == {"batchItemFailures": []}
    assert handlers.run_enrichment(handlers.get_deps(), {}, EU_WINDOW) == {"batchItemFailures": []}


def test_parse_symbols_variants() -> None:
    assert parse_symbols(envelope([" aapl ", "", 3, "sap.de"])) == ["AAPL", "SAP.DE"]
    assert parse_symbols(json.dumps({"detail": json.dumps({"symbols": ["X"]})})) == ["X"]
    assert parse_symbols(json.dumps({"symbols": ["RAW"]})) == ["RAW"]


def test_profile_lookup_failure_retries_batch(infra: Infra) -> None:
    infra.table.delete()
    result = handlers.run_enrichment(handlers.get_deps(), sqs(envelope(["AAPL"]), "garbage"), EU_WINDOW)
    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}]}


# --------------------------------------------------------------------------- misc


@pytest.mark.parametrize(
    ("now", "hour"),
    [
        (datetime(2026, 10, 13, 16, 0, tzinfo=UTC), 18),  # CEST
        (datetime(2026, 12, 1, 17, 0, tzinfo=UTC), 18),  # CET
        (datetime(2026, 3, 29, 0, 59, tzinfo=UTC), 1),  # just before DST switch
        (datetime(2026, 3, 29, 1, 0, tzinfo=UTC), 3),
    ],
)
def test_amsterdam_hour(now: datetime, hour: int) -> None:
    assert amsterdam_hour(now) == hour


def test_last_sunday_rule() -> None:
    assert handlers._last_sunday(2026, 3) == date(2026, 3, 29)
    assert handlers._last_sunday(2026, 10) == date(2026, 10, 25)
    assert handlers._last_sunday(2026, 12) == date(2026, 12, 27)


def test_json_logging(capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    try:
        root.handlers = []
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        setup_logging()
        assert root.level == logging.DEBUG
        handlers.request_id.set("req-9")
        try:
            raise ValueError("boom")
        except ValueError:
            logging.getLogger("prices.test").exception("failed", extra={"symbol": "AAPL"})
        line = capsys.readouterr().err.strip().splitlines()[-1]
        payload = json.loads(line)
        assert payload["message"] == "failed" and payload["symbol"] == "AAPL" and payload["level"] == "ERROR"
        assert payload["requestId"] == "req-9" and "ValueError: boom" in payload["exception"]
    finally:
        root.handlers, root.level = saved
        handlers.request_id.set(None)


def test_formatter_handles_unserializable() -> None:
    record = logging.makeLogRecord({"msg": "x", "obj": object(), "levelname": "INFO", "name": "n"})
    assert json.loads(JsonFormatter().format(record))["obj"].startswith("<object")
