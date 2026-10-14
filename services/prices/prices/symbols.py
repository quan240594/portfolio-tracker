"""Canonical (Yahoo-style) symbol helpers: classification, currency/exchange/country by suffix."""

from __future__ import annotations

import re

from .models import InstrumentProfile

CRYPTO_RE = re.compile(r"^[A-Z0-9]+-[A-Z]{3}$")
SUFFIX_RE = re.compile(r"^[A-Z0-9][A-Z0-9&\-]*\.([A-Z]{1,4})$")

# suffix -> (currency, exchange name, country, EODHD exchange code)
EXCHANGES: dict[str, tuple[str, str, str, str]] = {
    "AS": ("EUR", "Euronext Amsterdam", "Netherlands", "AS"),
    "DE": ("EUR", "XETRA", "Germany", "XETRA"),
    "F": ("EUR", "Frankfurt", "Germany", "F"),
    "PA": ("EUR", "Euronext Paris", "France", "PA"),
    "BR": ("EUR", "Euronext Brussels", "Belgium", "BR"),
    "LS": ("EUR", "Euronext Lisbon", "Portugal", "LS"),
    "IR": ("EUR", "Euronext Dublin", "Ireland", "IR"),
    "MI": ("EUR", "Borsa Italiana", "Italy", "MI"),
    "MC": ("EUR", "BME Madrid", "Spain", "MC"),
    "HE": ("EUR", "Nasdaq Helsinki", "Finland", "HE"),
    "VI": ("EUR", "Vienna", "Austria", "VI"),
    "L": ("GBP", "London Stock Exchange", "United Kingdom", "LSE"),
    "SW": ("CHF", "SIX Swiss", "Switzerland", "SW"),
    "ST": ("SEK", "Nasdaq Stockholm", "Sweden", "ST"),
    "CO": ("DKK", "Nasdaq Copenhagen", "Denmark", "CO"),
    "OL": ("NOK", "Oslo Bors", "Norway", "OL"),
    "TO": ("CAD", "Toronto", "Canada", "TO"),
}


def normalize(symbol: str) -> str:
    return symbol.strip().upper()


def is_crypto(symbol: str) -> bool:
    return bool(CRYPTO_RE.match(symbol))


def exchange_suffix(symbol: str) -> str | None:
    """Return the exchange suffix (`AS` for `ASML.AS`) or None for bare US tickers / crypto."""
    if is_crypto(symbol):
        return None
    m = SUFFIX_RE.match(symbol)
    return m.group(1) if m else None


def has_exchange_suffix(symbol: str) -> bool:
    return exchange_suffix(symbol) is not None


def base_ticker(symbol: str) -> str:
    suffix = exchange_suffix(symbol)
    return symbol[: -(len(suffix) + 1)] if suffix else symbol


def crypto_parts(symbol: str) -> tuple[str, str]:
    """`BTC-EUR` -> ("BTC", "EUR")."""
    coin, quote = symbol.rsplit("-", 1)
    return coin, quote


def currency_for(symbol: str) -> str:
    if is_crypto(symbol):
        return crypto_parts(symbol)[1]
    suffix = exchange_suffix(symbol)
    if suffix is None:
        return "USD"
    return EXCHANGES.get(suffix, ("EUR", "", "", ""))[0]


def price_currency_for(symbol: str) -> str:
    """Currency raw provider prices are quoted in when the API omits it (LSE quotes in pence)."""
    return "GBX" if exchange_suffix(symbol) == "L" else currency_for(symbol)


def exchange_for(symbol: str) -> str | None:
    suffix = exchange_suffix(symbol)
    if suffix and suffix in EXCHANGES:
        return EXCHANGES[suffix][1]
    return None


def country_for(symbol: str) -> str | None:
    suffix = exchange_suffix(symbol)
    if suffix is None:
        return None if is_crypto(symbol) else "United States"
    return EXCHANGES[suffix][2] if suffix in EXCHANGES else None


def minimal_profile(symbol: str) -> InstrumentProfile:
    """Fallback profile derived only from the symbol, used when providers return nothing."""
    if is_crypto(symbol):
        return InstrumentProfile(
            symbol=symbol,
            name=crypto_parts(symbol)[0],
            asset_class="CRYPTO",
            currency=currency_for(symbol),
        )
    return InstrumentProfile(
        symbol=symbol,
        name=symbol,
        asset_class="OTHER",
        currency=currency_for(symbol),
        country=country_for(symbol),
        exchange=exchange_for(symbol),
    )
