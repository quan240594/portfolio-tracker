"""CoinGecko demo-API adapter for crypto pairs like `BTC-EUR` (quotes + daily history; no dividends)."""

from __future__ import annotations

import logging
import os
from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from typing import Any

from ..errors import SymbolNotFoundError
from ..httpclient import HttpClient, TokenBucket
from ..models import DividendEvent, EodPrice, InstrumentProfile, Quote, iso_datetime
from ..symbols import crypto_parts
from .base import as_float, clamp_range

log = logging.getLogger(__name__)

BASE_URL = "https://api.coingecko.com/api/v3"

COIN_IDS: dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "ADA": "cardano",
    "XRP": "ripple",
    "DOT": "polkadot",
    "DOGE": "dogecoin",
    "LTC": "litecoin",
}
COIN_NAMES: dict[str, str] = {
    "bitcoin": "Bitcoin",
    "ethereum": "Ethereum",
    "solana": "Solana",
    "cardano": "Cardano",
    "ripple": "XRP",
    "polkadot": "Polkadot",
    "dogecoin": "Dogecoin",
    "litecoin": "Litecoin",
}


def coin_ids() -> dict[str, str]:
    """Built-in map extended by env COINGECKO_COIN_IDS, e.g. `AVAX=avalanche-2,LINK=chainlink`."""
    ids = dict(COIN_IDS)
    for pair in os.environ.get("COINGECKO_COIN_IDS", "").split(","):
        if "=" in pair:
            ticker, coin_id = pair.split("=", 1)
            ids[ticker.strip().upper()] = coin_id.strip().lower()
    return ids


class CoinGeckoProvider:
    name = "coingecko"

    def __init__(
        self,
        api_key: str,
        *,
        http: HttpClient | None = None,
        bucket: TokenBucket | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._key = api_key
        self._http = http or HttpClient(self.name)
        self._bucket = bucket or TokenBucket(30, 0.5)  # demo plan: 30 calls/minute
        self._now = now or (lambda: datetime.now(UTC))
        self._ids = coin_ids()

    def _coin(self, symbol: str) -> tuple[str, str]:
        ticker, vs = crypto_parts(symbol)
        coin_id = self._ids.get(ticker)
        if coin_id is None:
            raise SymbolNotFoundError(
                f"{self.name}: no coin id mapping for {ticker}", provider=self.name, symbol=symbol
            )
        return coin_id, vs.lower()

    def _get(self, path: str, params: dict[str, Any], symbol: str | None = None) -> Any:
        self._bucket.acquire(1)
        return self._http.get_json(
            f"{BASE_URL}{path}", params, headers={"x-cg-demo-api-key": self._key}, symbol=symbol
        )

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        wanted: dict[str, tuple[str, str]] = {}
        for s in symbols:
            try:
                wanted[s] = self._coin(s)
            except SymbolNotFoundError as exc:
                log.warning("coingecko unknown coin", extra={"symbol": s, "error": str(exc)})
        if not wanted:
            return {}
        ids = sorted({c for c, _ in wanted.values()})
        currencies = sorted({v for _, v in wanted.values()})
        data = self._get(
            "/simple/price",
            {
                "ids": ",".join(ids),
                "vs_currencies": ",".join(currencies),
                "include_24hr_change": "true",
                "include_last_updated_at": "true",
            },
        )
        out: dict[str, Quote] = {}
        for symbol, (coin_id, vs) in wanted.items():
            entry = (data or {}).get(coin_id) or {}
            price = as_float(entry.get(vs))
            if price is None:
                continue
            change = as_float(entry.get(f"{vs}_24h_change"))
            prev = price / (1 + change / 100) if change is not None and change > -100 else price
            updated = entry.get("last_updated_at")
            as_of = datetime.fromtimestamp(int(updated), UTC) if updated else self._now()
            out[symbol] = Quote(
                symbol=symbol,
                price=price,
                previousClose=round(prev, 8),
                currency=vs.upper(),
                asOf=iso_datetime(as_of),
                source=self.name,
            )
        return out

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        coin_id, vs = self._coin(symbol)
        days = max(1, min(365, (self._now().date() - start).days + 1))
        data = self._get(
            f"/coins/{coin_id}/market_chart",
            {"vs_currency": vs, "days": days, "interval": "daily"},
            symbol=symbol,
        )
        by_day: dict[str, list[float]] = defaultdict(list)
        for point in (data or {}).get("prices") or []:
            if isinstance(point, list | tuple) and len(point) == 2 and as_float(point[1]) is not None:
                day = datetime.fromtimestamp(int(point[0]) / 1000, UTC).date().isoformat()
                by_day[day].append(float(point[1]))
        rows = [EodPrice(symbol=symbol, date=d, close=v[-1], currency=vs.upper()) for d, v in by_day.items()]
        return clamp_range(rows, start, end)

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        coin_id, vs = self._coin(symbol)
        return InstrumentProfile(
            symbol=symbol,
            name=COIN_NAMES.get(coin_id, coin_id.replace("-", " ").title()),
            assetClass="CRYPTO",
            currency=vs.upper(),
        )

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        return []
