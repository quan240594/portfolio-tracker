"""EODHD adapter: EU (exchange-suffixed) listings for quotes/EOD/profile, and dividends for all equities.

Free tier is ~20 API calls/day (each ticker in a batched real-time request counts), so this adapter
is deliberately frugal and enforces a client-side daily budget (env EODHD_DAILY_LIMIT, default 20).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from typing import Any

from ..errors import ProviderError, RateLimitError, SymbolNotFoundError
from ..httpclient import DailyQuota, HttpClient, TokenBucket
from ..models import DividendEvent, EodPrice, InstrumentProfile, Quote, iso_datetime, normalize_currency
from ..symbols import (
    EXCHANGES,
    base_ticker,
    country_for,
    currency_for,
    exchange_for,
    exchange_suffix,
    price_currency_for,
)
from .base import as_float, chunks, clamp_range
from .twelvedata import asset_class_from_type

log = logging.getLogger(__name__)

BASE_URL = "https://eodhd.com/api"
MAX_BATCH = 15


def to_provider_symbol(symbol: str) -> str:
    """`ASML.AS` -> `ASML.AS`, `SAP.DE` -> `SAP.XETRA`, `VOD.L` -> `VOD.LSE`, `AAPL` -> `AAPL.US`."""
    suffix = exchange_suffix(symbol)
    if suffix is None:
        return f"{symbol}.US"
    code = EXCHANGES[suffix][3] if suffix in EXCHANGES else suffix
    return f"{base_ticker(symbol)}.{code}"


class EodhdProvider:
    name = "eodhd"

    def __init__(
        self,
        api_key: str,
        *,
        http: HttpClient | None = None,
        quota: DailyQuota | None = None,
        bucket: TokenBucket | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._key = api_key
        self._http = http or HttpClient(self.name)
        self._quota = quota or DailyQuota(int(os.environ.get("EODHD_DAILY_LIMIT", "20")), self.name)
        self._bucket = bucket or TokenBucket(5, 1.0)
        self._now = now or (lambda: datetime.now(UTC))

    def _get(
        self, path: str, params: dict[str, Any] | None = None, *, calls: int = 1, symbol: str | None = None
    ) -> Any:
        self._quota.consume(calls)
        self._bucket.acquire(1)
        query = {**(params or {}), "fmt": "json", "api_token": self._key}
        try:
            return self._http.get_json(f"{BASE_URL}{path}", query, symbol=symbol)
        except ProviderError as exc:
            if exc.status == 402:  # EODHD signals exhausted daily limit with 402 Payment Required
                raise RateLimitError(
                    f"{self.name}: daily API limit reached", provider=self.name, symbol=symbol
                ) from None
            raise

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        out: dict[str, Quote] = {}
        for batch in chunks(list(symbols), MAX_BATCH):
            mapping = {to_provider_symbol(s): s for s in batch}
            codes = list(mapping)
            params = {"s": ",".join(codes[1:])} if len(codes) > 1 else {}
            try:
                data = self._get(f"/real-time/{codes[0]}", params, calls=len(codes))
            except SymbolNotFoundError as exc:
                log.warning("eodhd quote not found", extra={"symbols": batch, "error": str(exc)})
                continue
            for raw in data if isinstance(data, list) else [data]:
                if not isinstance(raw, dict):
                    continue
                canonical = mapping.get(str(raw.get("code", "")))
                price = as_float(raw.get("close"))
                if canonical is None or price is None:
                    continue
                prev = as_float(raw.get("previousClose"))
                ts = as_float(raw.get("timestamp"))
                as_of = datetime.fromtimestamp(int(ts), UTC) if ts else self._now()
                out[canonical] = Quote(
                    symbol=canonical,
                    price=price,
                    previousClose=prev if prev is not None else price,
                    currency=price_currency_for(canonical),
                    asOf=iso_datetime(as_of),
                    source=self.name,
                )
        return out

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        data = self._get(
            f"/eod/{to_provider_symbol(symbol)}",
            {"from": start.isoformat(), "to": end.isoformat(), "period": "d"},
            symbol=symbol,
        )
        currency = price_currency_for(symbol)
        rows = []
        for row in data if isinstance(data, list) else []:
            if not isinstance(row, dict):
                continue
            close = as_float(row.get("close"))
            if close is not None and row.get("date"):
                rows.append(
                    EodPrice(symbol=symbol, date=str(row["date"])[:10], close=close, currency=currency)
                )
        return clamp_range(rows, start, end)

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        provider_symbol = to_provider_symbol(symbol)
        code, exchange = provider_symbol.rsplit(".", 1)
        data = self._get(f"/search/{code}", {"exchange": exchange, "limit": 10}, symbol=symbol)
        match = next(
            (
                r
                for r in data or []
                if isinstance(r, dict)
                and str(r.get("Code", "")).upper() == code
                and str(r.get("Exchange", "")).upper() == exchange.upper()
            ),
            None,
        )
        if match is None:
            return None
        return InstrumentProfile(
            symbol=symbol,
            name=match.get("Name") or symbol,
            assetClass=asset_class_from_type(match.get("Type")),
            currency=(match.get("Currency") or currency_for(symbol)).upper(),
            country=match.get("Country")
            if match.get("Country") not in (None, "", "USA")
            else country_for(symbol),
            exchange=exchange_for(symbol) or match.get("Exchange"),
        )

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        try:
            data = self._get(f"/div/{to_provider_symbol(symbol)}", {"from": start.isoformat()}, symbol=symbol)
        except SymbolNotFoundError:
            return []
        out: dict[str, DividendEvent] = {}
        hi = end.isoformat()
        for row in data if isinstance(data, list) else []:
            if not isinstance(row, dict):
                continue
            ex = str(row.get("date") or "")[:10]
            amount = as_float(row.get("value"))
            if not ex or amount is None or ex > hi or ex < start.isoformat():
                continue
            pay = str(row.get("paymentDate") or "")[:10] or None
            out[ex] = DividendEvent(
                symbol=symbol,
                exDate=ex,
                payDate=pay,
                amount=amount,
                currency=normalize_currency(row.get("currency"), price_currency_for(symbol)),
            )
        return [out[k] for k in sorted(out)]
