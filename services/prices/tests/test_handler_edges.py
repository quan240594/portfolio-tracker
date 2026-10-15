"""Edge cases for scheduled refresh and enrichment, driven through fakes (no AWS, no network)."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from prices import handlers
from prices.errors import ProviderError, RateLimitError, SymbolNotFoundError
from prices.models import EodPrice, FxRates, Quote
from prices.providers.base import QuoteBatch

NOW = datetime(2026, 10, 13, 10, 0, tzinfo=UTC)  # 12:00 Amsterdam, outside the default EU window


def throttled() -> ClientError:
    return ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "PutItem")


class FakeRepo:
    def __init__(self, tracked: list[str] | None = None, fail_put_quote: bool = False) -> None:
        self.tracked = tracked or []
        self.fail_put_quote = fail_put_quote
        self.quotes: list[Quote] = []
        self.eods: list[EodPrice] = []
        self.profiles: list[Any] = []

    def list_tracked(self) -> list[str]:
        return self.tracked

    def put_fx(self, fx: FxRates) -> None:
        pass

    def latest_fx_day(self, base: str) -> str | None:
        return "2026-10-13"

    def put_fx_days(self, days: list[Any]) -> int:
        return len(list(days))

    def latest_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        return {}

    def put_quote(self, quote: Quote) -> None:
        if self.fail_put_quote:
            raise throttled()
        self.quotes.append(quote)

    def put_eods(self, rows: list[EodPrice]) -> int:
        self.eods.extend(rows)
        return len(rows)

    def put_dividends(self, events: list[Any]) -> int:
        return 0

    def ensure_tracked(self, symbol: str, now: str) -> bool:
        return True

    def put_profile(self, profile: Any) -> None:
        self.profiles.append(profile)

    def stale_profile_details(self, symbols: list[str], cutoff: str) -> list[str]:
        return []


class FakeProvider:
    name = "fake"

    def __init__(self, **behaviour: Any) -> None:
        self.b = behaviour

    def _maybe(self, key: str, default: Any) -> Any:
        v = self.b.get(key, default)
        if isinstance(v, Exception):
            raise v
        return v

    def get_profile(self, symbol: str) -> Any:
        return self._maybe("profile", None)

    def get_eod_history(self, symbol: str, start: Any, end: Any) -> list[EodPrice]:
        return self._maybe("history", [])

    def get_dividends(self, symbol: str, start: Any, end: Any) -> list[Any]:
        return self._maybe("dividends", [])

    def get_quotes_detailed(self, symbols: list[str]) -> QuoteBatch:
        return self._maybe("quotes", QuoteBatch())


def deps(repo: FakeRepo, provider: FakeProvider) -> Any:
    fx = SimpleNamespace(
        get_latest=lambda base: FxRates(base=base, as_of="t", rates={"USD": 1.1}),
        get_history=lambda base, start, end: [],
    )
    publisher = SimpleNamespace(prices_updated=lambda *a: True)
    settings = SimpleNamespace(eu_refresh_hours={18}, base_currency="EUR", fx_history_start=NOW.date())
    return SimpleNamespace(settings=settings, repo=repo, provider=provider, fx=fx, publisher=publisher)


def quote(symbol: str = "AAPL") -> Quote:
    return Quote(symbol, 10.0, 9.0, "USD", "2026-10-13T10:00:00Z", "fake")


def test_refresh_with_only_us_symbols_outside_window_and_storage_failure() -> None:
    repo = FakeRepo(tracked=["AAPL"], fail_put_quote=True)
    provider = FakeProvider(quotes=QuoteBatch(quotes={"AAPL": quote()}))
    summary = handlers.run_scheduled_refresh(deps(repo, provider), NOW)
    assert summary["euWindow"] is False
    assert summary["failedSymbols"] == ["AAPL"] and summary["refreshed"] == 0
    assert summary["eventPublished"] is False


def test_quote_from_history_handles_empty_and_single_row() -> None:
    assert handlers._quote_from_history("A", [], "fake") is None
    q = handlers._quote_from_history("A", [EodPrice("A", "2026-10-12", 5.0, "EUR")], "fake")
    assert q is not None and (q.price, q.previous_close, q.source) == (5.0, 5.0, "fake-eod")


def test_enrich_unknown_profile_falls_back_and_no_quote_or_history_is_fine() -> None:
    repo = FakeRepo()
    provider = FakeProvider(profile=SymbolNotFoundError("nope"), history=[], quotes=QuoteBatch())
    assert handlers.enrich_symbol(deps(repo, provider), "ZZZ.AS", NOW) is True
    assert repo.quotes == [] and repo.profiles[0].symbol == "ZZZ.AS"


def test_enrich_retryable_dividend_error_is_raised_as_retryable() -> None:
    provider = FakeProvider(dividends=RateLimitError("429"))
    with pytest.raises(handlers._RetryableError):
        handlers.enrich_symbol(deps(FakeRepo(), provider), "AAPL", NOW)


def test_enrich_non_retryable_provider_error_skips_symbol() -> None:
    provider = FakeProvider(history=ProviderError("bad payload"))
    assert handlers.enrich_symbol(deps(FakeRepo(), provider), "AAPL", NOW) is False


def test_enrich_storage_error_is_retryable() -> None:
    repo = FakeRepo()
    repo.put_eods = lambda rows: (_ for _ in ()).throw(throttled())  # type: ignore[method-assign]
    with pytest.raises(handlers._RetryableError):
        handlers.enrich_symbol(deps(repo, FakeProvider()), "AAPL", NOW)
