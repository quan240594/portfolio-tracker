"""DynamoDB single-table layout — mirrors packages/shared/src/keys.ts exactly.

Every item carries PK, SK, `entityType` and the entity's fields stored flat (numbers as Decimal / N).
"""

from __future__ import annotations

from dataclasses import asdict
from decimal import Decimal
from typing import Any

from .models import WIRE_NAMES, DividendEvent, EodPrice, FxDay, FxRates, InstrumentProfile, Quote

ENTITY_TRACKED_TICKER = "TRACKED_TICKER"
ENTITY_QUOTE = "QUOTE"
ENTITY_EOD = "EOD"
ENTITY_PROFILE = "PROFILE"
ENTITY_DIVIDEND_EVENT = "DIVIDEND_EVENT"
ENTITY_FX = "FX"
ENTITY_FX_DAY = "FX_DAY"

TRACKED_PK = "TRACKED"
TICKER_SK_PREFIX = "TICKER#"
EOD_PREFIX = "EOD#"
DIVIDEND_PREFIX = "DIV#"
FX_DAY_PREFIX = "DAY#"


def ticker_pk(symbol: str) -> str:
    return f"TICKER#{symbol}"


def tracked_key(symbol: str) -> dict[str, str]:
    return {"PK": TRACKED_PK, "SK": f"{TICKER_SK_PREFIX}{symbol}"}


def quote_key(symbol: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": "QUOTE#LATEST"}


def eod_key(symbol: str, date: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": f"{EOD_PREFIX}{date}"}


def profile_key(symbol: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": "PROFILE"}


def dividend_key(symbol: str, ex_date: str) -> dict[str, str]:
    return {"PK": ticker_pk(symbol), "SK": f"{DIVIDEND_PREFIX}{ex_date}"}


def fx_pk(base: str) -> str:
    return f"FX#{base}"


def fx_key(base: str) -> dict[str, str]:
    return {"PK": fx_pk(base), "SK": "LATEST"}


def fx_day_key(base: str, date: str) -> dict[str, str]:
    return {"PK": fx_pk(base), "SK": f"{FX_DAY_PREFIX}{date}"}


def to_decimal(value: float | int | Decimal) -> Decimal:
    """Float → Decimal via its shortest repr (avoids binary noise like 0.1000000000000000055)."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise TypeError("bool is not a number")
    d = Decimal(repr(float(value))) if isinstance(value, float) else Decimal(value)
    if not d.is_finite():
        raise ValueError(f"non-finite number {value!r}")
    return d


def _flat(obj: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for attr, v in asdict(obj).items():
        k = WIRE_NAMES.get(attr, attr)
        if v is None:
            continue
        if isinstance(v, bool):
            out[k] = v
        elif isinstance(v, int | float | Decimal):
            out[k] = to_decimal(v)
        elif isinstance(v, dict):
            out[k] = {kk: to_decimal(vv) for kk, vv in v.items()}
        else:
            out[k] = v
    return out


def tracked_item(symbol: str, now: str) -> dict[str, Any]:
    """Same shape the api/ingest services write: {symbol, currency?, createdAt, updatedAt}."""
    return {
        **tracked_key(symbol),
        "entityType": ENTITY_TRACKED_TICKER,
        "symbol": symbol,
        "createdAt": now,
        "updatedAt": now,
    }


def quote_item(q: Quote) -> dict[str, Any]:
    return {**quote_key(q.symbol), "entityType": ENTITY_QUOTE, **_flat(q)}


def eod_item(e: EodPrice) -> dict[str, Any]:
    return {**eod_key(e.symbol, e.date), "entityType": ENTITY_EOD, **_flat(e)}


def profile_item(p: InstrumentProfile) -> dict[str, Any]:
    return {**profile_key(p.symbol), "entityType": ENTITY_PROFILE, **_flat(p)}


def dividend_item(d: DividendEvent) -> dict[str, Any]:
    return {**dividend_key(d.symbol, d.ex_date), "entityType": ENTITY_DIVIDEND_EVENT, **_flat(d)}


def fx_item(fx: FxRates) -> dict[str, Any]:
    """`FxRates` shape only ({base, rates, asOf}); the fixing date lives on the FX_DAY items."""
    flat = _flat(fx)
    flat.pop("date", None)
    return {**fx_key(fx.base), "entityType": ENTITY_FX, **flat}


def fx_day_item(day: FxDay) -> dict[str, Any]:
    """{PK:'FX#EUR', SK:'DAY#2026-10-13', entityType:'FX_DAY', base, date, rates:{USD: Decimal, ...}}."""
    rates = {c: to_decimal(r) for c, r in sorted(day.rates.items()) if c != day.base}
    return {
        **fx_day_key(day.base, day.date),
        "entityType": ENTITY_FX_DAY,
        "base": day.base,
        "date": day.date,
        "rates": rates,
    }


def quote_from_item(item: dict[str, Any]) -> Quote:
    return Quote(
        symbol=item["symbol"],
        price=float(item["price"]),
        previous_close=float(item["previousClose"]),
        currency=item["currency"],
        as_of=item["asOf"],
        source=item.get("source", ""),
    )
