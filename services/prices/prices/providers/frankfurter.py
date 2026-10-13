"""Frankfurter (ECB reference rates) FX adapter — no API key required."""

from __future__ import annotations

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..errors import ProviderError
from ..httpclient import HttpClient
from ..models import FxRates, iso_datetime
from .base import as_float

BASE_URL = "https://api.frankfurter.dev/v1"


def _ecb_publication(day: str) -> datetime:
    """ECB reference rates are published around 16:00 CET on `day`."""
    d = datetime.fromisoformat(day).date()
    try:
        return datetime.combine(d, time(16, 0), ZoneInfo("Europe/Berlin")).astimezone(UTC)
    except ZoneInfoNotFoundError:  # pragma: no cover - runtime without tzdata
        return datetime.combine(d, time(15, 0), UTC)


class FrankfurterFx:
    name = "frankfurter"

    def __init__(self, *, http: HttpClient | None = None) -> None:
        self._http = http or HttpClient(self.name)

    def get_latest(self, base: str) -> FxRates:
        data = self._http.get_json(f"{BASE_URL}/latest", {"base": base}) or {}
        raw = data.get("rates") or {}
        rates = {str(c).upper(): f for c, v in raw.items() if (f := as_float(v)) is not None and f > 0}
        if not rates:
            raise ProviderError(f"{self.name}: empty rates for base {base}", provider=self.name)
        as_of = _ecb_publication(data["date"]) if data.get("date") else datetime.now(UTC)
        return FxRates(base=(data.get("base") or base).upper(), rates=rates, asOf=iso_datetime(as_of))
