from __future__ import annotations

from decimal import Decimal

import pytest

from prices import keys
from prices.models import DividendEvent, EodPrice, FxRates, InstrumentProfile, Quote, iso_datetime
from prices.symbols import (
    base_ticker,
    country_for,
    currency_for,
    exchange_for,
    exchange_suffix,
    is_crypto,
    minimal_profile,
)


@pytest.mark.parametrize(
    ("symbol", "crypto", "suffix", "currency"),
    [
        ("AAPL", False, None, "USD"),
        ("BRK-B", False, None, "USD"),
        ("ASML.AS", False, "AS", "EUR"),
        ("SAP.DE", False, "DE", "EUR"),
        ("MC.PA", False, "PA", "EUR"),
        ("VWRL.AS", False, "AS", "EUR"),
        ("VOD.L", False, "L", "GBP"),
        ("BTC-EUR", True, None, "EUR"),
        ("ETH-USD", True, None, "USD"),
    ],
)
def test_symbol_classification(symbol: str, crypto: bool, suffix: str | None, currency: str) -> None:
    assert is_crypto(symbol) is crypto
    assert exchange_suffix(symbol) == suffix
    assert currency_for(symbol) == currency


def test_symbol_helpers() -> None:
    assert base_ticker("ASML.AS") == "ASML"
    assert base_ticker("AAPL") == "AAPL"
    assert exchange_for("SAP.DE") == "XETRA"
    assert country_for("ASML.AS") == "Netherlands"
    assert country_for("AAPL") == "United States"
    assert country_for("BTC-EUR") is None


def test_minimal_profile() -> None:
    assert minimal_profile("BTC-EUR") == InstrumentProfile("BTC-EUR", "BTC", "CRYPTO", "EUR")
    p = minimal_profile("XYZ.AS")
    assert (p.assetClass, p.currency, p.exchange, p.country) == (
        "OTHER",
        "EUR",
        "Euronext Amsterdam",
        "Netherlands",
    )


def test_invalid_asset_class() -> None:
    with pytest.raises(ValueError, match="assetClass"):
        InstrumentProfile("X", "X", "EQUITY", "USD")


def test_keys_match_shared_contract() -> None:
    assert keys.tracked_key("AAPL") == {"PK": "TRACKED", "SK": "TICKER#AAPL"}
    assert keys.quote_key("AAPL") == {"PK": "TICKER#AAPL", "SK": "QUOTE#LATEST"}
    assert keys.eod_key("AAPL", "2026-01-02") == {"PK": "TICKER#AAPL", "SK": "EOD#2026-01-02"}
    assert keys.profile_key("AAPL") == {"PK": "TICKER#AAPL", "SK": "PROFILE"}
    assert keys.dividend_key("AAPL", "2026-02-10") == {"PK": "TICKER#AAPL", "SK": "DIV#2026-02-10"}
    assert keys.fx_key("EUR") == {"PK": "FX#EUR", "SK": "LATEST"}


def test_item_shapes() -> None:
    q = Quote("AAPL", 230.12, 228.5, "USD", "2026-10-13T12:00:00.000Z", "mock")
    assert keys.quote_item(q) == {
        "PK": "TICKER#AAPL",
        "SK": "QUOTE#LATEST",
        "entityType": "QUOTE",
        "symbol": "AAPL",
        "price": Decimal("230.12"),
        "previousClose": Decimal("228.5"),
        "currency": "USD",
        "asOf": "2026-10-13T12:00:00.000Z",
        "source": "mock",
    }
    assert keys.eod_item(EodPrice("SAP.DE", "2026-10-12", 0.1 + 0.2, "EUR")) == {
        "PK": "TICKER#SAP.DE",
        "SK": "EOD#2026-10-12",
        "entityType": "EOD",
        "symbol": "SAP.DE",
        "date": "2026-10-12",
        "close": Decimal("0.30000000000000004"),
        "currency": "EUR",
    }
    profile = keys.profile_item(InstrumentProfile("BTC-EUR", "Bitcoin", "CRYPTO", "EUR"))
    assert profile == {
        "PK": "TICKER#BTC-EUR",
        "SK": "PROFILE",
        "entityType": "PROFILE",
        "symbol": "BTC-EUR",
        "name": "Bitcoin",
        "assetClass": "CRYPTO",
        "currency": "EUR",
    }
    div = keys.dividend_item(DividendEvent("AAPL", "2026-02-10", 0.26, "USD", payDate="2026-02-14"))
    assert div["entityType"] == "DIVIDEND_EVENT" and div["SK"] == "DIV#2026-02-10"
    assert (
        div["amount"] == Decimal("0.26") and div["payDate"] == "2026-02-14" and div["exDate"] == "2026-02-10"
    )
    fx = keys.fx_item(FxRates("EUR", "2026-10-13T14:00:00.000Z", {"USD": 1.085, "JPY": 162}))
    assert fx == {
        "PK": "FX#EUR",
        "SK": "LATEST",
        "entityType": "FX",
        "base": "EUR",
        "asOf": "2026-10-13T14:00:00.000Z",
        "rates": {"USD": Decimal("1.085"), "JPY": Decimal("162")},
    }
    assert keys.tracked_item("AAPL", "t") == {
        "PK": "TRACKED",
        "SK": "TICKER#AAPL",
        "entityType": "TRACKED_TICKER",
        "symbol": "AAPL",
        "createdAt": "t",
        "updatedAt": "t",
    }


def test_to_decimal_rejects_bad_values() -> None:
    assert keys.to_decimal(Decimal("1.5")) == Decimal("1.5")
    with pytest.raises(TypeError):
        keys.to_decimal(True)
    with pytest.raises(ValueError):
        keys.to_decimal(float("nan"))


def test_quote_roundtrip() -> None:
    q = Quote("AAPL", 1.5, 1.25, "USD", "2026-10-13T12:00:00.000Z", "x")
    assert keys.quote_from_item(keys.quote_item(q)) == q


def test_iso_datetime_matches_js() -> None:
    from datetime import datetime

    assert iso_datetime(datetime(2026, 10, 13, 12, 17, 24, 165432)) == "2026-10-13T12:17:24.165Z"


def test_minor_unit_prices_are_rescaled_to_major_currency() -> None:
    from prices.models import DividendEvent, EodPrice, Quote, normalize_currency
    from prices.symbols import price_currency_for

    q = Quote(symbol="VOD.L", price=7250.0, previousClose=7100.0, currency="GBp", asOf="t", source="x")
    assert (q.price, q.previousClose, q.currency) == (72.5, 71.0, "GBP")
    e = EodPrice(symbol="VOD.L", date="2026-01-02", close=7250.0, currency="GBX")
    assert (e.close, e.currency) == (72.5, "GBP")
    d = DividendEvent(symbol="VOD.L", exDate="2026-01-02", amount=4.5, currency="GBX")
    assert (d.amount, d.currency) == (0.045, "GBP")
    assert EodPrice(symbol="AAPL", date="2026-01-02", close=10.0, currency="USD").close == 10.0
    assert normalize_currency("GBp", "USD") == "GBp"
    assert normalize_currency("eur", "USD") == "EUR"
    assert normalize_currency(None, "USD") == "USD"
    assert price_currency_for("VOD.L") == "GBX"
    assert price_currency_for("ASML.AS") == "EUR"
