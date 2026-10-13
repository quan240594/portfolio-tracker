"""Provider factory driven by MARKET_DATA_PROVIDER (`mock` | `live`) and FX_PROVIDER."""

from __future__ import annotations

import logging

from ..secrets import get_api_key
from .alphavantage import AlphaVantageProvider
from .base import FxProvider, MarketDataProvider, QuoteBatch, fetch_quotes
from .coingecko import CoinGeckoProvider
from .eodhd import EodhdProvider
from .frankfurter import FrankfurterFx
from .mock import MockFx, MockProvider
from .routing import RoutingProvider
from .twelvedata import TwelveDataProvider

log = logging.getLogger(__name__)

__all__ = [
    "FxProvider",
    "MarketDataProvider",
    "MockProvider",
    "QuoteBatch",
    "RoutingProvider",
    "build_fx_provider",
    "build_provider",
    "fetch_quotes",
]


def build_provider(kind: str) -> MarketDataProvider:
    if kind == "mock":
        return MockProvider()
    if kind not in ("live", "routing"):
        raise ValueError(f"unknown MARKET_DATA_PROVIDER {kind!r} (expected 'mock' or 'live')")
    keys = {name: get_api_key(name) for name in ("twelvedata", "eodhd", "coingecko", "alphavantage")}
    missing = sorted(k for k, v in keys.items() if not v)
    if missing:
        log.warning("market data providers without API key are disabled", extra={"providers": missing})
    return RoutingProvider(
        twelvedata=TwelveDataProvider(keys["twelvedata"]) if keys["twelvedata"] else None,
        eodhd=EodhdProvider(keys["eodhd"]) if keys["eodhd"] else None,
        coingecko=CoinGeckoProvider(keys["coingecko"]) if keys["coingecko"] else None,
        alphavantage=AlphaVantageProvider(keys["alphavantage"]) if keys["alphavantage"] else None,
    )


def build_fx_provider(kind: str) -> FxProvider:
    if kind == "mock":
        return MockFx()
    if kind == "frankfurter":
        return FrankfurterFx()
    raise ValueError(f"unknown FX_PROVIDER {kind!r} (expected 'mock' or 'frankfurter')")
