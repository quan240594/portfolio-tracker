"""Domain models mirroring packages/shared/src/types.ts (snake_case attrs; `WIRE_NAMES` maps TS names)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime

# snake_case attribute -> camelCase name used in DynamoDB items / TS types.
WIRE_NAMES = {
    "previous_close": "previousClose",
    "as_of": "asOf",
    "asset_class": "assetClass",
    "ex_date": "exDate",
    "pay_date": "payDate",
}

ASSET_CLASSES = ("STOCK", "ETF", "CRYPTO", "BOND", "CASH", "OTHER")


def iso_datetime(dt: datetime) -> str:
    """ISO-8601 UTC with millisecond precision and `Z`, identical to JS `Date#toISOString()`."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    dt = dt.astimezone(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_iso_datetime(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def iso_date(d: date) -> str:
    return d.isoformat()


MINOR_UNIT_CURRENCIES = {"GBX": "GBP", "GBp": "GBP", "ZAc": "ZAR", "ILA": "ILS"}


def normalize_currency(code: str | None, default: str) -> str:
    """Upper-cases ISO codes but preserves minor-unit codes (e.g. "GBp") so models can rescale them."""
    if not code:
        return default
    return code if code in MINOR_UNIT_CURRENCIES else code.upper()


def _rescale_minor_units(obj: object, *fields: str) -> None:
    """Converts prices quoted in minor units (pence) to the major currency so FX lookups work."""
    major = MINOR_UNIT_CURRENCIES.get(obj.currency)  # type: ignore[attr-defined]
    if major is None:
        return
    for f in fields:
        object.__setattr__(obj, f, getattr(obj, f) / 100)
    object.__setattr__(obj, "currency", major)


@dataclass(frozen=True)
class Quote:
    symbol: str
    price: float
    previous_close: float
    currency: str
    as_of: str
    source: str

    def __post_init__(self) -> None:
        _rescale_minor_units(self, "price", "previous_close")


@dataclass(frozen=True)
class InstrumentProfile:
    symbol: str
    name: str
    asset_class: str
    currency: str
    sector: str | None = None
    country: str | None = None
    exchange: str | None = None

    def __post_init__(self) -> None:
        if self.asset_class not in ASSET_CLASSES:
            raise ValueError(f"invalid assetClass {self.asset_class!r}")


@dataclass(frozen=True)
class EodPrice:
    symbol: str
    date: str
    close: float
    currency: str

    def __post_init__(self) -> None:
        _rescale_minor_units(self, "close")


@dataclass(frozen=True)
class DividendEvent:
    symbol: str
    ex_date: str
    amount: float
    currency: str
    pay_date: str | None = None

    def __post_init__(self) -> None:
        _rescale_minor_units(self, "amount")


@dataclass(frozen=True)
class FxRates:
    base: str
    as_of: str
    rates: dict[str, float] = field(default_factory=dict)
    # ECB fixing date (YYYY-MM-DD) the rates belong to; not part of the `FX#{base}`/`LATEST` item.
    date: str | None = None


@dataclass(frozen=True)
class FxDay:
    """Daily ECB reference rates (business days only): `rates[C]` = units of C per 1 `base`."""

    base: str
    date: str
    rates: dict[str, float] = field(default_factory=dict)
