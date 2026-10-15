"""Settings of the calendar refresh (env vars, read lazily so tests can monkeypatch them)."""

from __future__ import annotations

import os
from dataclasses import dataclass

EARNINGS_HORIZONS = ("3month", "6month", "12month")
DEFAULT_EARNINGS_HORIZON = "12month"


def _int_env(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return max(minimum, int(raw)) if raw else default
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class CalendarSettings:
    """Budgets are per UTC day and persisted in DynamoDB, so re-runs and retries cannot overspend them.

    - `alphavantage_daily_calls`: Alpha Vantage's free tier is 25 calls/day in total (the enrichment
      Lambda also uses it for profiles); one EARNINGS_CALENDAR call serves every tracked ticker, so
      the default is one call a day.
    - `eodhd_daily_calls`: EODHD's free tier is 20 calls/day in total (shared with the quote refresh
      and the enrichment); each symbol check costs one call for splits plus one for dividends.
    """

    earnings_horizon: str = DEFAULT_EARNINGS_HORIZON
    alphavantage_daily_calls: int = 1
    eodhd_daily_calls: int = 8
    recheck_days: int = 7
    refresh_dividends: bool = True
    split_lookback_days: int = 90

    @classmethod
    def from_env(cls) -> CalendarSettings:
        horizon = os.environ.get("CALENDAR_EARNINGS_HORIZON", "").strip().lower()
        return cls(
            earnings_horizon=horizon if horizon in EARNINGS_HORIZONS else DEFAULT_EARNINGS_HORIZON,
            alphavantage_daily_calls=_int_env("CALENDAR_ALPHAVANTAGE_DAILY_CALLS", 1),
            eodhd_daily_calls=_int_env("CALENDAR_EODHD_DAILY_CALLS", 8),
            recheck_days=_int_env("CALENDAR_RECHECK_DAYS", 7, minimum=1),
            refresh_dividends=_bool_env("CALENDAR_REFRESH_DIVIDENDS", True),
            split_lookback_days=_int_env("CALENDAR_SPLIT_LOOKBACK_DAYS", 90),
        )
