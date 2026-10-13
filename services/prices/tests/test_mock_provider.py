from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from prices.errors import SymbolNotFoundError
from prices.providers import MarketDataProvider
from prices.providers.mock import MockFx, MockProvider, symbol_seed

NOW = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)  # a Tuesday
SATURDAY = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)


def provider(now: datetime = NOW) -> MockProvider:
    return MockProvider(now=lambda: now)


def test_implements_protocol() -> None:
    assert isinstance(provider(), MarketDataProvider)


def test_deterministic_across_instances_and_ranges() -> None:
    a = provider().get_eod_history("AAPL", date(2025, 10, 1), date(2026, 10, 13))
    b = provider().get_eod_history("AAPL", date(2026, 9, 1), date(2026, 10, 13))
    assert a[-len(b) :] == b
    assert provider().get_quotes(["AAPL"]) == provider().get_quotes(["AAPL"])
    assert provider().price_on("AAPL", date(2026, 1, 5)) != provider().price_on("MSFT", date(2026, 1, 5))


def test_seed_stable_across_processes() -> None:
    code = (
        "from datetime import date; from prices.providers.mock import MockProvider, symbol_seed;"
        "print(symbol_seed('ASML.AS'), MockProvider().price_on('ASML.AS', date(2026, 1, 2)))"
    )
    root = Path(__file__).resolve().parents[1]
    outs = {
        subprocess.run(
            [sys.executable, "-c", code],
            cwd=root,
            env={**os.environ, "PYTHONHASHSEED": seed},
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        for seed in ("1", "2")
    }
    assert len(outs) == 1
    assert str(symbol_seed("ASML.AS")) in outs.pop()


def test_prices_stay_sensible() -> None:
    history = provider().get_eod_history("AAPL", date(2025, 10, 13), date(2026, 10, 13))
    closes = [p.close for p in history]
    assert min(closes) > 150 and max(closes) < 400
    assert all(date.fromisoformat(p.date).weekday() < 5 for p in history)
    assert 250 <= len(history) <= 262
    btc = provider().get_eod_history("BTC-EUR", date(2026, 10, 1), date(2026, 10, 31))
    assert len(btc) == 13 and btc[-1].date == "2026-10-13"  # crypto trades daily, capped at today


@pytest.mark.parametrize(
    ("symbol", "currency"),
    [("AAPL", "USD"), ("ASML.AS", "EUR"), ("SAP.DE", "EUR"), ("MC.PA", "EUR"), ("BTC-EUR", "EUR")],
)
def test_quote_currency(symbol: str, currency: str) -> None:
    q = provider().get_quotes([symbol])[symbol]
    assert q.currency == currency and q.source == "mock" and q.price > 0 and q.previousClose > 0


def test_weekend_quote_uses_last_trading_day() -> None:
    q = provider(SATURDAY).get_quotes(["AAPL"])["AAPL"]
    assert q.asOf == "2026-10-16T20:00:00.000Z"
    p = provider(SATURDAY)
    assert q.price == p.price_on("AAPL", date(2026, 10, 16))
    assert q.previousClose == p.price_on("AAPL", date(2026, 10, 15))
    crypto = provider(SATURDAY).get_quotes(["BTC-EUR"])["BTC-EUR"]
    assert crypto.asOf == "2026-10-17T12:00:00.000Z"


def test_profiles() -> None:
    p = provider()
    assert p.get_profile("VWRL.AS").assetClass == "ETF"
    assert p.get_profile("BTC-EUR").assetClass == "CRYPTO"
    assert p.get_profile("SAP.DE").country == "Germany"
    generic = p.get_profile("FOO.PA")
    assert (
        generic.assetClass == "STOCK" and generic.currency == "EUR" and generic.exchange == "Euronext Paris"
    )
    assert p.get_profile("DOGE-USD").assetClass == "CRYPTO"


def test_dividends() -> None:
    p = provider()
    aapl = p.get_dividends("AAPL", date(2024, 10, 13), date(2027, 10, 13))
    assert len(aapl) == 12 and all(d.amount == 0.26 and d.currency == "USD" for d in aapl)
    assert aapl[0].exDate == "2024-11-10" and aapl[0].payDate == "2024-11-14"
    assert len(p.get_dividends("SAP.DE", date(2025, 1, 1), date(2026, 12, 31))) == 2
    assert p.get_dividends("BTC-EUR", date(2024, 1, 1), date(2027, 1, 1)) == []
    assert p.get_dividends("IWDA.AS", date(2024, 1, 1), date(2027, 1, 1)) == []
    payers = [s for s in ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF") if symbol_seed(s) % 3 == 0]
    for s in payers:
        assert len(p.get_dividends(s, date(2025, 1, 1), date(2025, 12, 31))) == 4


def test_mock_fx() -> None:
    fx = MockFx(now=lambda: NOW).get_latest("EUR")
    assert fx.base == "EUR" and fx.rates["USD"] == 1.085 and "EUR" not in fx.rates
    assert fx.asOf == "2026-10-13T12:00:00.000Z"
    usd = MockFx(now=lambda: NOW).get_latest("USD")
    assert usd.rates["EUR"] == pytest.approx(1 / 1.085, rel=1e-5) and "USD" not in usd.rates
    with pytest.raises(SymbolNotFoundError):
        MockFx().get_latest("XXX")
    json.dumps(fx.rates)
