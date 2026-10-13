"""RoutingProvider (MARKET_DATA_PROVIDER=live): dispatches each symbol to the right free-tier provider.

| Symbol kind                  | quotes / EOD | profile                     | dividends |
|------------------------------|--------------|-----------------------------|-----------|
| crypto `BTC-EUR`             | CoinGecko    | CoinGecko (static)          | none      |
| exchange suffix `ASML.AS`    | EODHD        | EODHD search                | EODHD     |
| bare US ticker `AAPL`        | Twelve Data  | Alpha Vantage → Twelve Data | EODHD     |

Sub-providers are optional (constructed only when their API key exists). Symbols whose provider is
missing raise ProviderUnavailableError / are reported as `unavailable` — never crashing the run.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date
from enum import Enum

from ..errors import ProviderError, ProviderUnavailableError, SymbolNotFoundError
from ..models import DividendEvent, EodPrice, InstrumentProfile, Quote
from ..symbols import has_exchange_suffix, is_crypto
from .base import MarketDataProvider, QuoteBatch

log = logging.getLogger(__name__)


class Route(Enum):
    CRYPTO = "crypto"
    LISTED = "listed"  # exchange-suffixed (EU etc.)
    US = "us"


def route_of(symbol: str) -> Route:
    if is_crypto(symbol):
        return Route.CRYPTO
    if has_exchange_suffix(symbol):
        return Route.LISTED
    return Route.US


class RoutingProvider:
    name = "live"

    def __init__(
        self,
        *,
        twelvedata: MarketDataProvider | None = None,
        eodhd: MarketDataProvider | None = None,
        coingecko: MarketDataProvider | None = None,
        alphavantage: MarketDataProvider | None = None,
    ) -> None:
        self.twelvedata = twelvedata
        self.eodhd = eodhd
        self.coingecko = coingecko
        self.alphavantage = alphavantage
        self._warned: set[str] = set()

    def _price_provider(self, route: Route) -> MarketDataProvider | None:
        return {Route.CRYPTO: self.coingecko, Route.LISTED: self.eodhd, Route.US: self.twelvedata}[route]

    @staticmethod
    def _required(route: Route) -> str:
        return {Route.CRYPTO: "coingecko", Route.LISTED: "eodhd", Route.US: "twelvedata"}[route]

    def _unavailable(self, symbol: str, needed: str) -> ProviderUnavailableError:
        if needed not in self._warned:
            log.warning(
                "provider not configured (missing API key); skipping symbols", extra={"provider": needed}
            )
            self._warned.add(needed)
        return ProviderUnavailableError(f"no {needed} API key configured", provider=needed, symbol=symbol)

    def _for(self, symbol: str) -> MarketDataProvider:
        route = route_of(symbol)
        provider = self._price_provider(route)
        if provider is None:
            raise self._unavailable(symbol, self._required(route))
        return provider

    def get_quotes_detailed(self, symbols: Sequence[str]) -> QuoteBatch:
        result = QuoteBatch()
        groups: dict[Route, list[str]] = {}
        for s in symbols:
            groups.setdefault(route_of(s), []).append(s)
        for route, group in groups.items():
            provider = self._price_provider(route)
            if provider is None:
                self._unavailable(group[0], self._required(route))
                result.unavailable.extend(group)
                continue
            try:
                quotes = provider.get_quotes(group)
            except ProviderError as exc:
                log.warning(
                    "quote batch failed",
                    extra={"provider": provider.name, "symbols": group, "error": str(exc)},
                )
                result.failed.update(dict.fromkeys(group, exc))
                continue
            for s in group:
                if s in quotes:
                    result.quotes[s] = quotes[s]
                else:
                    result.failed[s] = SymbolNotFoundError(
                        f"{provider.name}: no quote for {s}", provider=provider.name, symbol=s
                    )
        return result

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        return self.get_quotes_detailed(symbols).quotes

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        return self._for(symbol).get_eod_history(symbol, start, end)

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        route = route_of(symbol)
        if route is not Route.US:
            return self._for(symbol).get_profile(symbol)
        if self.alphavantage is None and self.twelvedata is None:
            raise self._unavailable(symbol, "twelvedata")
        if self.alphavantage is not None:
            try:
                profile = self.alphavantage.get_profile(symbol)
                if profile is not None:
                    return profile
            except ProviderError as exc:
                if self.twelvedata is None:
                    raise
                log.info(
                    "alphavantage profile failed; falling back", extra={"symbol": symbol, "error": str(exc)}
                )
        return self.twelvedata.get_profile(symbol) if self.twelvedata is not None else None

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        if is_crypto(symbol):
            return []
        if self.eodhd is None:
            self._unavailable(symbol, "eodhd")
            return []
        return self.eodhd.get_dividends(symbol, start, end)
