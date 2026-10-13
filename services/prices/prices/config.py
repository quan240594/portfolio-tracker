"""Environment configuration (read lazily so tests can monkeypatch env vars)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date

DEFAULT_REGION = "eu-west-1"
DEFAULT_FX_HISTORY_START = date(2015, 1, 1)


def _parse_date(raw: str | None, default: date) -> date:
    return date.fromisoformat(raw.strip()) if raw and raw.strip() else default


@dataclass(frozen=True)
class Settings:
    table_name: str
    event_bus_name: str
    base_currency: str
    provider: str
    fx_provider: str
    eu_refresh_hours: frozenset[int]
    region: str
    endpoint_url: str | None
    fx_history_start: date = DEFAULT_FX_HISTORY_START

    @classmethod
    def from_env(cls) -> Settings:
        provider = os.environ.get("MARKET_DATA_PROVIDER", "mock").strip().lower() or "mock"
        hours_raw = os.environ.get("EU_REFRESH_HOURS", "18")
        hours = frozenset(int(h) for h in hours_raw.split(",") if h.strip())
        return cls(
            table_name=os.environ.get("TABLE_NAME", "portfolio-tracker-local"),
            event_bus_name=os.environ.get("EVENT_BUS_NAME", "portfolio-tracker-local"),
            base_currency=os.environ.get("BASE_CURRENCY", "EUR").strip().upper() or "EUR",
            provider=provider,
            fx_provider=(
                os.environ.get("FX_PROVIDER", "mock" if provider == "mock" else "frankfurter").strip().lower()
            ),
            eu_refresh_hours=hours,
            region=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or DEFAULT_REGION,
            endpoint_url=os.environ.get("AWS_ENDPOINT_URL") or None,
            fx_history_start=_parse_date(os.environ.get("FX_HISTORY_START"), DEFAULT_FX_HISTORY_START),
        )
