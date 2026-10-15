"""Calendar items in the single table (mirrors packages/shared/src/calendar.ts).

| Entity          | PK                | SK                      | entityType        |
|-----------------|-------------------|-------------------------|-------------------|
| Earnings event  | TICKER#{symbol}   | EARN#{date}             | EARNINGS_EVENT    |
| Split event     | TICKER#{symbol}   | SPLIT#{date}            | SPLIT_EVENT       |
| Symbol marker   | TICKER#{symbol}   | CAL#STATE               | CALENDAR_STATE    |
| Daily budget    | CALENDAR          | BUDGET#{provider}       | CALENDAR_BUDGET   |

Dividend events keep living in `DIV#{exDate}` items written by the enrichment (see keys.py).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .keys import ticker_pk, to_decimal

ENTITY_EARNINGS_EVENT = "EARNINGS_EVENT"
ENTITY_SPLIT_EVENT = "SPLIT_EVENT"
ENTITY_CALENDAR_STATE = "CALENDAR_STATE"
ENTITY_CALENDAR_BUDGET = "CALENDAR_BUDGET"

EARNINGS_PREFIX = "EARN#"
SPLIT_PREFIX = "SPLIT#"
STATE_SK = "CAL#STATE"
BUDGET_PK = "CALENDAR"
TIMES_OF_DAY = ("BMO", "AMC", "unknown")


@dataclass(frozen=True)
class EarningsEvent:
    symbol: str
    date: str
    name: str | None = None
    fiscal_period_end: str | None = None
    eps_estimate: float | None = None
    currency: str | None = None
    # BMO = before market open, AMC = after market close.
    time_of_day: str = "unknown"
    source: str = ""

    def __post_init__(self) -> None:
        if self.time_of_day not in TIMES_OF_DAY:
            raise ValueError(f"invalid timeOfDay {self.time_of_day!r}")


@dataclass(frozen=True)
class SplitEvent:
    """`to_factor` new shares for every `from_factor` old ones.

    A 4:1 split is from 1, to 4; a 1:10 reverse split is from 10, to 1."""

    symbol: str
    date: str
    from_factor: float
    to_factor: float
    source: str = ""


def earnings_key(symbol: str, date: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": f"{EARNINGS_PREFIX}{date}"}


def split_key(symbol: str, date: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": f"{SPLIT_PREFIX}{date}"}


def state_key(symbol: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": STATE_SK}


def budget_key(provider: str) -> dict[str, str]:
    return {"PK": BUDGET_PK, "SK": f"BUDGET#{provider}"}


def earnings_item(e: EarningsEvent, updated_at: str) -> dict[str, Any]:
    item: dict[str, Any] = {
        **earnings_key(e.symbol, e.date),
        "entityType": ENTITY_EARNINGS_EVENT,
        "symbol": e.symbol,
        "date": e.date,
        "timeOfDay": e.time_of_day,
        "source": e.source,
        "updatedAt": updated_at,
    }
    optional: dict[str, Any] = {
        "name": e.name,
        "fiscalPeriodEnd": e.fiscal_period_end,
        "currency": e.currency,
        "epsEstimate": None if e.eps_estimate is None else to_decimal(e.eps_estimate),
    }
    item.update({k: v for k, v in optional.items() if v is not None})
    return item


def split_item(e: SplitEvent, updated_at: str) -> dict[str, Any]:
    return {
        **split_key(e.symbol, e.date),
        "entityType": ENTITY_SPLIT_EVENT,
        "symbol": e.symbol,
        "date": e.date,
        "fromFactor": to_decimal(e.from_factor),
        "toFactor": to_decimal(e.to_factor),
        "source": e.source,
        "updatedAt": updated_at,
    }
