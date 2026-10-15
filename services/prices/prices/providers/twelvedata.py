"""Twelve Data adapter (US equities / ETFs): quotes, daily time series, profile (+ reference fallback).

Free tier: 8 credits/minute, 800/day. Each symbol in a batch /quote costs one credit, so batches are
capped at 8 symbols and gated by a client-side token bucket plus a daily counter.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from typing import Any

from ..errors import ProviderError, RateLimitError, RetryableProviderError, SymbolNotFoundError
from ..httpclient import DailyQuota, HttpClient, TokenBucket
from ..models import DividendEvent, EodPrice, InstrumentProfile, Quote, iso_datetime, normalize_currency
from ..symbols import country_for
from .base import as_float, chunks, clamp_range, clean_text

log = logging.getLogger(__name__)

BASE_URL = "https://api.twelvedata.com"
MAX_BATCH = 8
CREDITS_PER_MINUTE = 8
CREDITS_PER_DAY = 800

UNITED_STATES = "United States"
COUNTRY_NAMES = {"USA": UNITED_STATES, "US": UNITED_STATES, "United States of America": UNITED_STATES}


def to_provider_symbol(symbol: str) -> str:
    return symbol.replace("-", ".")  # Yahoo class shares BRK-B -> Twelve Data BRK.B


def asset_class_from_type(kind: str | None) -> str:
    k = (kind or "").lower()
    if "etf" in k or "fund" in k:
        return "ETF"
    if "bond" in k:
        return "BOND"
    if "stock" in k or "share" in k or "equity" in k or "depositary" in k:
        return "STOCK"
    return "OTHER"


class TwelveDataProvider:
    name = "twelvedata"

    def __init__(
        self,
        api_key: str,
        *,
        http: HttpClient | None = None,
        bucket: TokenBucket | None = None,
        quota: DailyQuota | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._key = api_key
        self._http = http or HttpClient(self.name)
        self._bucket = bucket or TokenBucket(CREDITS_PER_MINUTE, CREDITS_PER_MINUTE / 60.0)
        self._quota = quota or DailyQuota(CREDITS_PER_DAY, self.name)
        self._now = now or (lambda: datetime.now(UTC))
        self._profile_endpoint_supported = True

    def _get(self, path: str, params: dict[str, Any], *, credits: int = 1, symbol: str | None = None) -> Any:
        self._quota.consume(credits)
        self._bucket.acquire(credits)
        data = self._http.get_json(
            f"{BASE_URL}{path}", params, headers={"Authorization": f"apikey {self._key}"}, symbol=symbol
        )
        self._raise_for_error(data, symbol)
        return data

    def _raise_for_error(self, data: Any, symbol: str | None) -> None:
        if not isinstance(data, dict) or data.get("status") != "error":
            return
        code = int(data.get("code") or 0)
        message = f"{self.name}: {code} {data.get('message', '')}".strip()
        if code == 429:
            raise RateLimitError(message, provider=self.name, symbol=symbol)
        if code >= 500:
            raise RetryableProviderError(message, provider=self.name, symbol=symbol)
        if code in (400, 404):
            raise SymbolNotFoundError(message, provider=self.name, symbol=symbol)
        raise ProviderError(message, provider=self.name, symbol=symbol)

    def _parse_quote(self, symbol: str, raw: dict[str, Any]) -> Quote | None:
        price = as_float(raw.get("close"))
        if price is None:
            return None
        prev = as_float(raw.get("previous_close"))
        ts = raw.get("last_quote_at") or raw.get("timestamp")
        as_of = datetime.fromtimestamp(int(ts), UTC) if ts else self._now()
        return Quote(
            symbol=symbol,
            price=price,
            previous_close=prev if prev is not None else price,
            currency=normalize_currency(raw.get("currency"), "USD"),
            as_of=iso_datetime(as_of),
            source=self.name,
        )

    def _quote_from_entry(self, canonical: str, raw: dict[str, Any]) -> Quote | None:
        """Parse one batch entry; per-symbol errors are logged and skipped, except rate limiting."""
        if raw.get("status") != "error":
            return self._parse_quote(canonical, raw)
        log.warning(
            "twelvedata quote error",
            extra={"symbol": canonical, "code": raw.get("code"), "error": raw.get("message")},
        )
        if int(raw.get("code") or 0) == 429:
            raise RateLimitError(f"{self.name}: 429 in batch", provider=self.name, symbol=canonical)
        return None

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        out: dict[str, Quote] = {}
        for batch in chunks(list(symbols), MAX_BATCH):
            mapping = {to_provider_symbol(s): s for s in batch}
            try:
                data = self._get("/quote", {"symbol": ",".join(mapping)}, credits=len(batch))
            except SymbolNotFoundError as exc:
                log.warning("twelvedata quote not found", extra={"symbols": batch, "error": str(exc)})
                continue
            entries: dict[str, Any] = {next(iter(mapping)): data} if len(batch) == 1 else data or {}
            for provider_symbol, raw in entries.items():
                canonical = mapping.get(provider_symbol)
                if canonical is None or not isinstance(raw, dict):
                    continue
                quote = self._quote_from_entry(canonical, raw)
                if quote:
                    out[canonical] = quote
        return out

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        data = self._get(
            "/time_series",
            {
                "symbol": to_provider_symbol(symbol),
                "interval": "1day",
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "outputsize": 5000,
                "order": "asc",
            },
            symbol=symbol,
        )
        currency = normalize_currency((data.get("meta") or {}).get("currency"), "USD")
        rows = []
        for v in data.get("values") or []:
            close = as_float(v.get("close"))
            day = str(v.get("datetime", ""))[:10]
            if close is not None and day:
                rows.append(EodPrice(symbol=symbol, date=day, close=close, currency=currency))
        return clamp_range(rows, start, end)

    def _reference(self, symbol: str) -> dict[str, Any] | None:
        for path in ("/stocks", "/etfs"):
            data = self._get(path, {"symbol": to_provider_symbol(symbol)}, symbol=symbol)
            items = [d for d in (data.get("data") or []) if isinstance(d, dict)]
            if not items:
                continue
            us = [d for d in items if d.get("country") in (UNITED_STATES, "USA")]
            chosen = dict((us or items)[0])
            chosen.setdefault("type", "ETF" if path == "/etfs" else "Common Stock")
            return chosen
        return None

    def _profile_raw(self, symbol: str) -> dict[str, Any] | None:
        if not self._profile_endpoint_supported:
            return None
        try:
            return self._get("/profile", {"symbol": to_provider_symbol(symbol)}, symbol=symbol)
        except SymbolNotFoundError:
            return None
        except ProviderError as exc:
            if exc.retryable:
                raise
            log.info("twelvedata /profile unavailable, using reference data", extra={"error": str(exc)})
            self._profile_endpoint_supported = False
            return None

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        raw = self._profile_raw(symbol)
        if not raw or not raw.get("name"):
            raw = self._reference(symbol)
        if not raw:
            return None
        country = raw.get("country") or country_for(symbol)
        return InstrumentProfile(
            symbol=symbol,
            name=raw.get("name") or symbol,
            asset_class=asset_class_from_type(raw.get("type")),
            currency=normalize_currency(raw.get("currency"), "USD"),
            sector=raw.get("sector") or None,
            country=COUNTRY_NAMES.get(country, country) if country else None,
            exchange=raw.get("exchange") or None,
            description=clean_text(raw.get("description")),
        )

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        raise ProviderError(
            f"{self.name}: dividends not supported (use EODHD)", provider=self.name, symbol=symbol
        )
