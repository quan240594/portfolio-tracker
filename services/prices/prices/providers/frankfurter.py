"""Frankfurter (ECB reference rates) FX adapter — no API key required.

- latest:      GET /v1/latest?base=EUR             -> {amount, base, date, rates: {CUR: rate}}
- time series: GET /v1/{start}..{end}?base=EUR     -> {amount, base, start_date, end_date,
                                                        rates: {YYYY-MM-DD: {CUR: rate}}}
The time series only contains ECB business days (no weekends / TARGET holidays).
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..errors import ProviderError, SymbolNotFoundError
from ..httpclient import HttpClient
from ..models import FxDay, FxRates, iso_datetime
from .base import as_float

BASE_URL = "https://api.frankfurter.dev/v1"


def _ecb_publication(day: str) -> datetime:
    """ECB reference rates are published around 16:00 CET on `day`."""
    d = datetime.fromisoformat(day).date()
    try:
        return datetime.combine(d, time(16, 0), ZoneInfo("Europe/Berlin")).astimezone(UTC)
    except ZoneInfoNotFoundError:  # pragma: no cover - runtime without tzdata
        return datetime.combine(d, time(15, 0), UTC)


def _parse_rates(raw: Any, base: str) -> dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    return {
        str(c).upper(): f
        for c, v in raw.items()
        if (f := as_float(v)) is not None and f > 0 and str(c).upper() != base
    }


def year_chunks(start: date, end: date) -> Iterator[tuple[date, date]]:
    """Split [start, end] into ranges that never cross a calendar-year boundary (≤ 1 year each)."""
    lo = start
    while lo <= end:
        hi = min(end, date(lo.year, 12, 31))
        yield lo, hi
        lo = hi + timedelta(days=1)


def has_weekday(start: date, end: date) -> bool:
    return any((start + timedelta(days=i)).weekday() < 5 for i in range(min((end - start).days + 1, 7)))


class FrankfurterFx:
    name = "frankfurter"

    def __init__(self, *, http: HttpClient | None = None) -> None:
        self._http = http or HttpClient(self.name)

    def get_latest(self, base: str) -> FxRates:
        data = self._http.get_json(f"{BASE_URL}/latest", {"base": base}) or {}
        resolved = str(data.get("base") or base).upper()
        rates = _parse_rates(data.get("rates"), resolved)
        if not rates:
            raise ProviderError(f"{self.name}: empty rates for base {base}", provider=self.name)
        day = str(data["date"]) if data.get("date") else None
        as_of = _ecb_publication(day) if day else datetime.now(UTC)
        return FxRates(base=resolved, rates=rates, as_of=iso_datetime(as_of), date=day)

    def _fetch_chunk(self, lo: date, hi: date, base: str) -> dict[str, FxDay]:
        """Fixings for one year-bounded range; empty when the provider has none."""
        try:
            data = self._http.get_json(f"{BASE_URL}/{lo.isoformat()}..{hi.isoformat()}", {"base": base})
        except SymbolNotFoundError:  # range without any fixing (e.g. only TARGET holidays)
            return {}
        if not isinstance(data, dict):
            raise ProviderError(f"{self.name}: malformed time series {lo}..{hi}", provider=self.name)
        if str(data.get("base") or base).upper() != base:
            raise ProviderError(f"{self.name}: unexpected base {data.get('base')!r}", provider=self.name)
        series = data.get("rates") or {}
        if not isinstance(series, dict):
            raise ProviderError(f"{self.name}: malformed time series {lo}..{hi}", provider=self.name)
        lo_s, hi_s = lo.isoformat(), hi.isoformat()
        out: dict[str, FxDay] = {}
        for day, raw in series.items():
            day = str(day)
            # Frankfurter snaps a non-business start date back to the previous fixing; drop it.
            if not lo_s <= day <= hi_s:
                continue
            rates = _parse_rates(raw, base)
            if rates:
                out[day] = FxDay(base=base, date=day, rates=rates)
        return out

    def get_history(self, base: str, start: date, end: date) -> list[FxDay]:
        """Daily fixings for ECB business days in [start, end], ascending, one request per calendar year."""
        base = base.upper()
        by_date: dict[str, FxDay] = {}
        for lo, hi in year_chunks(start, end):
            if has_weekday(lo, hi):
                by_date.update(self._fetch_chunk(lo, hi, base))
        return [by_date[d] for d in sorted(by_date)]
