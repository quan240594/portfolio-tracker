"""Optional company details (description, ISIN, market cap, EPS, beta, P/E) and their lazy TTL refresh."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from prices import handlers
from prices.errors import ProviderError, RateLimitError, SymbolNotFoundError
from prices.httpclient import TokenBucket
from prices.keys import profile_details, profile_item
from prices.models import InstrumentProfile
from prices.providers.alphavantage import AlphaVantageProvider
from prices.providers.base import clean_text, valid_isin
from prices.providers.eodhd import EodhdProvider
from prices.providers.twelvedata import TwelveDataProvider
from tests.conftest import FakeOpener, Infra

NOW = datetime(2026, 10, 13, 10, 0, tzinfo=UTC)
KEY = "k3y-should-never-leak"


def free_bucket() -> TokenBucket:
    return TokenBucket(100, 100, sleep=lambda _s: pytest.fail("unexpected throttle"))


# --------------------------------------------------------------------------- text helpers


def test_clean_text_trims_caps_and_drops_placeholders() -> None:
    assert clean_text("  Makes   chips \n and more ") == "Makes chips and more"
    assert clean_text("x" * 30, limit=10) == "x" * 9 + "…"
    for empty in (None, 5, "", "   ", "None", "n/a", "-"):
        assert clean_text(empty) is None


def test_valid_isin_is_twelve_ascii_alphanumerics() -> None:
    assert valid_isin(" nl0010273215 ") == "NL0010273215"
    for bad in (None, 12, "NL001027321", "NL0010273215X", "NL00102732-5", "ÑL0010273215"):
        assert valid_isin(bad) is None


# --------------------------------------------------------------------------- providers


def test_alphavantage_overview_carries_company_details(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add(
        "OVERVIEW",
        {
            "Symbol": "AAPL",
            "AssetType": "Common Stock",
            "Name": "Apple Inc",
            "Currency": "USD",
            "Country": "USA",
            "Description": "Designs phones.",
            "MarketCapitalization": "3500000000000",
            "EPS": "6.42",
            "Beta": "1.24",
            "PERatio": "34.9",
        },
    )
    profile = AlphaVantageProvider(KEY, http=http_factory("alphavantage"), bucket=free_bucket()).get_profile(
        "AAPL"
    )
    assert profile is not None
    assert (profile.description, profile.market_cap, profile.eps, profile.beta, profile.pe_ratio) == (
        "Designs phones.",
        3.5e12,
        6.42,
        1.24,
        34.9,
    )
    assert profile.isin is None


def test_alphavantage_ignores_placeholder_details(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add(
        "OVERVIEW",
        {
            "Symbol": "XYZ",
            "Name": "Loss Maker",
            "Description": "None",
            "MarketCapitalization": "0",
            "EPS": "-1.5",
            "Beta": "-",
            "PERatio": "None",
        },
    )
    profile = AlphaVantageProvider(KEY, http=http_factory("alphavantage"), bucket=free_bucket()).get_profile(
        "XYZ"
    )
    assert profile is not None
    assert (profile.description, profile.market_cap, profile.beta, profile.pe_ratio) == (
        None,
        None,
        None,
        None,
    )
    assert profile.eps == -1.5


def test_eodhd_search_result_carries_a_valid_isin(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    row = {
        "Code": "ASML",
        "Exchange": "AS",
        "Name": "ASML Holding NV",
        "Type": "Common Stock",
        "Currency": "EUR",
    }
    opener.add("/search/ASML", [[{**row, "ISIN": "NL0010273215"}], [{**row, "ISIN": "bad"}]])
    provider = EodhdProvider(KEY, http=http_factory("eodhd"), bucket=free_bucket())
    assert provider.get_profile("ASML.AS").isin == "NL0010273215"  # type: ignore[union-attr]
    assert provider.get_profile("ASML.AS").isin is None  # type: ignore[union-attr]


def test_twelvedata_profile_carries_the_description(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add(
        "/profile",
        {"symbol": "MSFT", "name": "Microsoft", "type": "Common Stock", "description": "Software maker."},
    )
    provider = TwelveDataProvider(KEY, http=http_factory("twelvedata"), now=lambda: NOW, bucket=free_bucket())
    assert provider.get_profile("MSFT").description == "Software maker."  # type: ignore[union-attr]


# --------------------------------------------------------------------------- storage


def test_profile_details_keep_only_present_optional_fields() -> None:
    p = InstrumentProfile("AAPL", "Apple", "STOCK", "USD", sector="Technology", eps=6.42, pe_ratio=34.9)
    assert set(profile_details(p)) == {"eps", "peRatio"}
    assert profile_details(None) == {}
    item = profile_item(
        InstrumentProfile("AAPL", "Apple", "STOCK", "USD", market_cap=3.5e12, details_as_of="2026-10-13")
    )
    assert item["marketCap"] == 3_500_000_000_000 and item["detailsAsOf"] == "2026-10-13"
    assert "description" not in item


def test_repository_finds_stale_details_and_updates_only_the_details(infra: Infra) -> None:
    repo = handlers.get_deps().repo
    repo.put_profile(InstrumentProfile("AAA", "Alpha", "STOCK", "USD", sector="Energy"))
    repo.put_profile(InstrumentProfile("BBB", "Beta", "STOCK", "USD", details_as_of="2026-09-01"))
    repo.put_profile(InstrumentProfile("CCC", "Gamma", "STOCK", "USD", details_as_of="2026-10-10"))
    assert repo.stale_profile_details([], "2026-09-13") == []
    assert repo.stale_profile_details(["AAA", "BBB", "CCC", "NOPROFILE"], "2026-08-01") == ["AAA"]
    assert repo.stale_profile_details(["AAA", "BBB", "CCC"], "2026-10-01") == ["AAA", "BBB"]

    repo.put_profile_details(
        "AAA", InstrumentProfile("AAA", "Changed", "ETF", "EUR", description="Hello", beta=1.1), "2026-10-13"
    )
    item = infra.get("TICKER#AAA", "PROFILE")
    assert item is not None
    assert (item["name"], item["sector"], item["assetClass"]) == ("Alpha", "Energy", "STOCK")
    assert (item["description"], item["detailsAsOf"]) == ("Hello", "2026-10-13")
    assert repo.stale_profile_details(["AAA"], "2026-09-13") == []

    repo.put_profile_details("BBB", None, "2026-10-13")
    assert infra.get("TICKER#BBB", "PROFILE")["detailsAsOf"] == "2026-10-13"  # type: ignore[index]
    with pytest.raises(ClientError):
        repo.put_profile_details("MISSING", None, "2026-10-13")


# --------------------------------------------------------------------------- lazy refresh


class Repo:
    def __init__(self, stale: list[str], fail_write: bool = False, fail_read: bool = False) -> None:
        self.stale = stale
        self.fail_write = fail_write
        self.fail_read = fail_read
        self.cutoffs: list[str] = []
        self.written: list[tuple[str, InstrumentProfile | None, str]] = []

    def stale_profile_details(self, symbols: list[str], cutoff: str) -> list[str]:
        if self.fail_read:
            raise ClientError({"Error": {"Code": "Throttling", "Message": "x"}}, "BatchGetItem")
        self.cutoffs.append(cutoff)
        return [s for s in self.stale if s in symbols]

    def put_profile_details(self, symbol: str, profile: InstrumentProfile | None, as_of: str) -> None:
        if self.fail_write:
            raise ClientError({"Error": {"Code": "Throttling", "Message": "x"}}, "UpdateItem")
        self.written.append((symbol, profile, as_of))


def deps(repo: Repo, profile: Any) -> Any:
    def get_profile(symbol: str) -> Any:
        if isinstance(profile, Exception):
            raise profile
        return profile

    return SimpleNamespace(repo=repo, provider=SimpleNamespace(get_profile=get_profile))


FETCHED = InstrumentProfile("AAA", "Alpha", "STOCK", "USD", description="About")


def test_refresh_fetches_one_stale_symbol_per_run_with_a_30_day_ttl() -> None:
    repo = Repo(["AAA", "BBB"])
    assert handlers.refresh_profile_details(deps(repo, FETCHED), ["AAA", "BBB"], NOW) == ["AAA"]
    assert repo.cutoffs == ["2026-09-13"]
    assert repo.written == [("AAA", FETCHED, "2026-10-13")]


def test_refresh_without_stale_symbols_does_nothing() -> None:
    repo = Repo([])
    assert handlers.refresh_profile_details(deps(repo, FETCHED), ["AAA"], NOW) == []
    assert repo.written == []


def test_refresh_marks_unknown_and_permanently_failing_symbols_as_fetched() -> None:
    for error in (SymbolNotFoundError("nope"), ProviderError("bad payload")):
        repo = Repo(["AAA"])
        assert handlers.refresh_profile_details(deps(repo, error), ["AAA"], NOW) == ["AAA"]
        assert repo.written == [("AAA", None, "2026-10-13")]


def test_refresh_retries_later_after_a_throttled_call() -> None:
    repo = Repo(["AAA"])
    assert handlers.refresh_profile_details(deps(repo, RateLimitError("429")), ["AAA"], NOW) == []
    assert repo.written == []


def test_refresh_survives_storage_errors() -> None:
    assert handlers.refresh_profile_details(deps(Repo(["AAA"], fail_read=True), FETCHED), ["AAA"], NOW) == []
    assert handlers.refresh_profile_details(deps(Repo(["AAA"], fail_write=True), FETCHED), ["AAA"], NOW) == []


def test_scheduled_refresh_reports_and_applies_the_lazy_refresh(infra: Infra) -> None:
    infra.track("AAPL")
    handlers.get_deps().repo.put_profile(
        InstrumentProfile("AAPL", "Apple", "STOCK", "USD", sector="Technology")
    )
    summary = handlers.run_scheduled_refresh(handlers.get_deps(), NOW)
    assert summary["profileDetailsRefreshed"] == ["AAPL"]
    item = infra.get("TICKER#AAPL", "PROFILE")
    assert item is not None and item["detailsAsOf"] == "2026-10-13" and item["sector"] == "Technology"
    assert handlers.run_scheduled_refresh(handlers.get_deps(), NOW)["profileDetailsRefreshed"] == []


def test_enrichment_stamps_the_fetch_date_but_not_the_fallback_profile(infra: Infra) -> None:
    d = handlers.get_deps()
    assert handlers.enrich_symbol(d, "AAPL", NOW) is True
    assert infra.get("TICKER#AAPL", "PROFILE")["detailsAsOf"] == "2026-10-13"  # type: ignore[index]
