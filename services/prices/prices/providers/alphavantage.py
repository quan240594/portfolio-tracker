"""Alpha Vantage adapter — used ONLY for US instrument profiles (OVERVIEW); free tier is 25 calls/day."""

from __future__ import annotations

import logging
import math
import os
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

from ..errors import ProviderError, RateLimitError
from ..httpclient import DailyQuota, HttpClient, TokenBucket
from ..models import DividendEvent, EodPrice, InstrumentProfile, Quote
from .base import as_float, clean_text
from .twelvedata import COUNTRY_NAMES, asset_class_from_type

log = logging.getLogger(__name__)

BASE_URL = "https://www.alphavantage.co/query"


def _title(value: str | None) -> str | None:
    if not value or value.upper() in ("NONE", "N/A", "-"):
        return None
    return value.title() if value.isupper() else value


def _positive_ratio(value: object) -> float | None:
    """OVERVIEW numbers are strings; "None", "-", "0", negatives and garbage all mean "no usable value"."""
    try:
        number = float(str(value))
    except ValueError:
        return None
    return number if math.isfinite(number) and number > 0 else None


class AlphaVantageProvider:
    name = "alphavantage"

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
        self._now = now or (lambda: datetime.now(UTC))
        self._http = http or HttpClient(self.name)
        self._quota = quota or DailyQuota(int(os.environ.get("ALPHAVANTAGE_DAILY_LIMIT", "25")), self.name)
        self._bucket = bucket or TokenBucket(5, 5 / 60.0)

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        self._quota.consume(1)
        self._bucket.acquire(1)
        data: dict[str, Any] = (
            self._http.get_json(
                BASE_URL,
                {"function": "OVERVIEW", "symbol": symbol.replace("-", "."), "apikey": self._key},
                symbol=symbol,
            )
            or {}
        )
        if "Note" in data or "Information" in data:
            # Alpha Vantage reports throttling/quota as HTTP 200 with a Note/Information message.
            raise RateLimitError(f"{self.name}: rate limited", provider=self.name, symbol=symbol)
        if "Error Message" in data or not data.get("Symbol"):
            return None
        country = data.get("Country") or None
        # Trailing-twelve-month P/E from the same OVERVIEW call: no extra provider traffic.
        pe_ratio = _positive_ratio(data.get("PERatio"))
        return InstrumentProfile(
            symbol=symbol,
            name=data.get("Name") or symbol,
            asset_class=asset_class_from_type(data.get("AssetType")),
            currency=(data.get("Currency") or "USD").upper(),
            sector=_title(data.get("Sector")),
            country=COUNTRY_NAMES.get(country, country) if country else None,
            exchange=data.get("Exchange") or None,
            pe_ratio=pe_ratio,
            fundamentals_as_of=self._now().astimezone(UTC).date().isoformat() if pe_ratio else None,
            # Company details come from the same OVERVIEW call: no extra provider traffic.
            description=clean_text(data.get("Description")),
            market_cap=_positive_ratio(data.get("MarketCapitalization")),
            eps=as_float(data.get("EPS")),
            beta=as_float(data.get("Beta")),
        )

    def _unsupported(self, what: str, symbol: str) -> ProviderError:
        return ProviderError(
            f"{self.name}: {what} not used (profiles only)", provider=self.name, symbol=symbol
        )

    def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        raise self._unsupported("quotes", ",".join(symbols))

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        raise self._unsupported("EOD history", symbol)

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        raise self._unsupported("dividends", symbol)
