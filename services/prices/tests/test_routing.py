from __future__ import annotations

from collections.abc import Sequence
from datetime import date

import boto3
import pytest
from moto import mock_aws

from prices import secrets
from prices.errors import (
    ProviderUnavailableError,
    RateLimitError,
    RetryableProviderError,
    SymbolNotFoundError,
)
from prices.models import DividendEvent, EodPrice, InstrumentProfile, Quote
from prices.providers import MockProvider, build_fx_provider, build_provider, fetch_quotes
from prices.providers.coingecko import CoinGeckoProvider
from prices.providers.eodhd import EodhdProvider
from prices.providers.frankfurter import FrankfurterFx
from prices.providers.mock import MockFx
from prices.providers.routing import Route, RoutingProvider, route_of
from prices.providers.twelvedata import TwelveDataProvider

D = date(2026, 10, 13)


class Fake:
    def __init__(
        self, name: str, *, fail: Exception | None = None, profile: InstrumentProfile | None = None
    ) -> None:
        self.name = name
        self.calls: list[tuple[str, object]] = []
        self.fail = fail
        self.profile = profile

    def _maybe_fail(self) -> None:
        if self.fail:
            raise self.fail

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        self.calls.append(("quotes", list(symbols)))
        self._maybe_fail()
        return {
            s: Quote(s, 1.0, 1.0, "USD", "2026-10-13T00:00:00.000Z", self.name)
            for s in symbols
            if s != "GONE"
        }

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        self.calls.append(("eod", symbol))
        self._maybe_fail()
        return [EodPrice(symbol, end.isoformat(), 1.0, "USD")]

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        self.calls.append(("profile", symbol))
        self._maybe_fail()
        return self.profile

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        self.calls.append(("div", symbol))
        self._maybe_fail()
        return [DividendEvent(symbol, end.isoformat(), 0.1, "USD")]


@pytest.mark.parametrize(
    ("symbol", "route"),
    [("BTC-EUR", Route.CRYPTO), ("ASML.AS", Route.LISTED), ("SAP.DE", Route.LISTED), ("AAPL", Route.US)],
)
def test_route_of(symbol: str, route: Route) -> None:
    assert route_of(symbol) is route


def test_dispatch_by_symbol_type() -> None:
    td, eod, cg = Fake("twelvedata"), Fake("eodhd"), Fake("coingecko")
    av = Fake("alphavantage", profile=InstrumentProfile("AAPL", "Apple", "STOCK", "USD"))
    r = RoutingProvider(twelvedata=td, eodhd=eod, coingecko=cg, alphavantage=av)

    batch = r.get_quotes_detailed(["AAPL", "ASML.AS", "BTC-EUR", "MSFT", "GONE"])
    assert set(batch.quotes) == {"AAPL", "ASML.AS", "BTC-EUR", "MSFT"}
    assert isinstance(batch.failed["GONE"], SymbolNotFoundError)
    assert td.calls == [("quotes", ["AAPL", "MSFT", "GONE"])]
    assert eod.calls == [("quotes", ["ASML.AS"])] and cg.calls == [("quotes", ["BTC-EUR"])]
    assert set(r.get_quotes(["AAPL"])) == {"AAPL"}

    r.get_eod_history("SAP.DE", D, D)
    r.get_eod_history("AAPL", D, D)
    r.get_eod_history("ETH-EUR", D, D)
    assert ("eod", "SAP.DE") in eod.calls and ("eod", "AAPL") in td.calls and ("eod", "ETH-EUR") in cg.calls

    assert r.get_profile("AAPL").name == "Apple"
    assert ("profile", "AAPL") not in td.calls
    r.get_profile("ASML.AS")
    r.get_profile("BTC-EUR")
    assert ("profile", "ASML.AS") in eod.calls and ("profile", "BTC-EUR") in cg.calls

    assert r.get_dividends("AAPL", D, D)[0].symbol == "AAPL"
    assert ("div", "AAPL") in eod.calls
    assert r.get_dividends("BTC-EUR", D, D) == []


def test_profile_fallback_to_twelvedata() -> None:
    td = Fake("twelvedata", profile=InstrumentProfile("SPY", "SPDR", "ETF", "USD"))
    r = RoutingProvider(twelvedata=td, alphavantage=Fake("alphavantage", profile=None))
    assert r.get_profile("SPY").asset_class == "ETF"
    r2 = RoutingProvider(twelvedata=td, alphavantage=Fake("alphavantage", fail=RateLimitError("x")))
    assert r2.get_profile("SPY").name == "SPDR"
    r3 = RoutingProvider(alphavantage=Fake("alphavantage", fail=RateLimitError("x")))
    with pytest.raises(RateLimitError):
        r3.get_profile("SPY")
    assert RoutingProvider(twelvedata=Fake("twelvedata")).get_profile("SPY") is None


def test_missing_keys_skip_symbols(caplog: pytest.LogCaptureFixture) -> None:
    r = RoutingProvider(twelvedata=Fake("twelvedata"))
    batch = r.get_quotes_detailed(["AAPL", "ASML.AS", "BTC-EUR"])
    assert set(batch.quotes) == {"AAPL"}
    assert sorted(batch.unavailable) == ["ASML.AS", "BTC-EUR"]
    assert not batch.failed
    with pytest.raises(ProviderUnavailableError):
        r.get_eod_history("ASML.AS", D, D)
    with pytest.raises(ProviderUnavailableError):
        RoutingProvider().get_profile("AAPL")
    assert r.get_dividends("AAPL", D, D) == []  # no EODHD key: no dividends, but no crash
    assert "missing API key" in caplog.text


def test_batch_errors_mark_group_failed() -> None:
    err = RetryableProviderError("503")
    r = RoutingProvider(twelvedata=Fake("twelvedata", fail=err), eodhd=Fake("eodhd"))
    batch = r.get_quotes_detailed(["AAPL", "MSFT", "ASML.AS"])
    assert batch.failed == {"AAPL": err, "MSFT": err}
    assert set(batch.quotes) == {"ASML.AS"}


def test_fetch_quotes_generic_provider() -> None:
    batch = fetch_quotes(Fake("x"), ["A", "GONE"])
    assert set(batch.quotes) == {"A"} and isinstance(batch.failed["GONE"], SymbolNotFoundError)
    err = RetryableProviderError("boom")
    assert fetch_quotes(Fake("x", fail=err), ["A"]).failed == {"A": err}


def test_build_provider_mock_and_errors() -> None:
    assert isinstance(build_provider("mock"), MockProvider)
    with pytest.raises(ValueError):
        build_provider("yahoo")
    assert isinstance(build_fx_provider("mock"), MockFx)
    assert isinstance(build_fx_provider("frankfurter"), FrankfurterFx)
    with pytest.raises(ValueError):
        build_fx_provider("ecb")


def test_build_live_provider_from_env_and_ssm(monkeypatch: pytest.MonkeyPatch) -> None:
    with mock_aws():
        ssm = boto3.client("ssm", region_name="eu-west-1")
        ssm.put_parameter(Name="/portfolio-tracker/test/eodhd-api-key", Value="eod-key", Type="SecureString")
        monkeypatch.setenv("EODHD_API_KEY_PARAM", "/portfolio-tracker/test/eodhd-api-key")
        monkeypatch.setenv("COINGECKO_API_KEY_PARAM", "/portfolio-tracker/test/missing")
        monkeypatch.setenv("TWELVEDATA_API_KEY", "td-direct")
        provider = build_provider("live")
        assert isinstance(provider, RoutingProvider)
        assert isinstance(provider.twelvedata, TwelveDataProvider)
        assert isinstance(provider.eodhd, EodhdProvider)
        assert provider.coingecko is None and provider.alphavantage is None
        assert provider.eodhd._key == "eod-key"
        # cached per container: no second SSM call needed
        ssm.delete_parameter(Name="/portfolio-tracker/test/eodhd-api-key")
        assert secrets.get_api_key("eodhd") == "eod-key"
        assert secrets.get_api_key("coingecko") is None
        monkeypatch.setenv("COINGECKO_API_KEY", "cg")
        assert isinstance(build_provider("live").coingecko, CoinGeckoProvider)
