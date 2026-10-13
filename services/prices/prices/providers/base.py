"""Provider protocol and shared helpers."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol, runtime_checkable

from ..errors import ProviderError, SymbolNotFoundError
from ..models import DividendEvent, EodPrice, FxRates, InstrumentProfile, Quote

log = logging.getLogger(__name__)


@runtime_checkable
class MarketDataProvider(Protocol):
    name: str

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]: ...

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]: ...

    def get_profile(self, symbol: str) -> InstrumentProfile | None: ...

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]: ...


class FxProvider(Protocol):
    name: str

    def get_latest(self, base: str) -> FxRates: ...


@dataclass
class QuoteBatch:
    """Outcome of a multi-symbol quote fetch, so callers can count refreshed / skipped / failed."""

    quotes: dict[str, Quote] = field(default_factory=dict)
    failed: dict[str, ProviderError] = field(default_factory=dict)
    unavailable: list[str] = field(default_factory=list)


def fetch_quotes(provider: MarketDataProvider, symbols: Sequence[str]) -> QuoteBatch:
    """Use the provider's detailed batch API when available; otherwise treat gaps as not found."""
    detailed = getattr(provider, "get_quotes_detailed", None)
    if callable(detailed):
        return detailed(symbols)
    batch = QuoteBatch()
    try:
        batch.quotes = provider.get_quotes(symbols)
    except ProviderError as exc:
        batch.failed = dict.fromkeys(symbols, exc)
        return batch
    for s in symbols:
        if s not in batch.quotes:
            batch.failed[s] = SymbolNotFoundError(
                f"{provider.name}: no quote for {s}", provider=provider.name, symbol=s
            )
    return batch


def chunks(items: Sequence[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield list(items[i : i + size])


def clamp_range(rows: Iterable[EodPrice], start: date, end: date) -> list[EodPrice]:
    """Filter to [start, end], dedupe by date (last wins) and sort ascending."""
    lo, hi = start.isoformat(), end.isoformat()
    by_date = {r.date: r for r in rows if lo <= r.date <= hi}
    return [by_date[d] for d in sorted(by_date)]


def as_float(value: object) -> float | None:
    if value is None or value == "" or value == "NA":
        return None
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None
