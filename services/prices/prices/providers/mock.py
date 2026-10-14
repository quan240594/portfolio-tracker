"""Deterministic offline provider (MARKET_DATA_PROVIDER=mock).

Prices follow a seeded, mean-reverting log random walk per symbol (seed = SHA-256 of the symbol, so
results are stable across processes and runs) around a slowly drifting target price.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, time, timedelta

from ..errors import SymbolNotFoundError
from ..models import DividendEvent, EodPrice, FxDay, FxRates, InstrumentProfile, Quote, iso_datetime
from ..symbols import currency_for, is_crypto, minimal_profile

ANCHOR = date(2015, 1, 1)
REFERENCE = date(2025, 1, 1)
ANNUAL_DRIFT = 0.06
MEAN_REVERSION = 0.02
EQUITY_VOL = 0.012
CRYPTO_VOL = 0.03

ASML = "ASML.AS"
VWRL = "VWRL.AS"
IWDA = "IWDA.AS"
SAP = "SAP.DE"
EURONEXT_AMSTERDAM = "Euronext Amsterdam"

BASE_PRICES: dict[str, float] = {
    "AAPL": 230.0,
    "MSFT": 420.0,
    ASML: 700.0,
    VWRL: 120.0,
    IWDA: 95.0,
    SAP: 230.0,
    "BTC-EUR": 60000.0,
    "BTC-USD": 65000.0,
    "ETH-EUR": 3000.0,
    "SOL-EUR": 150.0,
}

PROFILES: dict[str, InstrumentProfile] = {
    p.symbol: p
    for p in (
        InstrumentProfile("AAPL", "Apple Inc.", "STOCK", "USD", "Technology", "United States", "NASDAQ"),
        InstrumentProfile(
            "MSFT", "Microsoft Corporation", "STOCK", "USD", "Technology", "United States", "NASDAQ"
        ),
        InstrumentProfile(
            ASML, "ASML Holding N.V.", "STOCK", "EUR", "Technology", "Netherlands", EURONEXT_AMSTERDAM
        ),
        InstrumentProfile(
            VWRL,
            "Vanguard FTSE All-World UCITS ETF",
            "ETF",
            "EUR",
            "Diversified",
            "Global",
            EURONEXT_AMSTERDAM,
        ),
        InstrumentProfile(
            IWDA,
            "iShares Core MSCI World UCITS ETF",
            "ETF",
            "EUR",
            "Diversified",
            "Global",
            EURONEXT_AMSTERDAM,
        ),
        InstrumentProfile(SAP, "SAP SE", "STOCK", "EUR", "Technology", "Germany", "XETRA"),
        InstrumentProfile("BTC-EUR", "Bitcoin", "CRYPTO", "EUR"),
    )
}

# symbol -> (ex-date months, ex-date day, amount per share, pay delay in days)
DIVIDEND_SCHEDULES: dict[str, tuple[tuple[int, ...], int, float, int]] = {
    "AAPL": ((2, 5, 8, 11), 10, 0.26, 4),
    "MSFT": ((2, 5, 8, 11), 15, 0.83, 28),
    ASML: ((2, 4, 7, 10), 28, 1.60, 7),
    VWRL: ((3, 6, 9, 12), 18, 0.45, 14),
    SAP: ((5,), 15, 2.35, 4),
}
NON_PAYERS = frozenset({IWDA})

MOCK_FX_RATES: dict[str, float] = {
    "USD": 1.085,
    "GBP": 0.845,
    "CHF": 0.94,
    "SEK": 11.45,
    "DKK": 7.46,
    "NOK": 11.6,
    "CAD": 1.49,
    "JPY": 162.5,
}


def symbol_seed(symbol: str) -> int:
    return int.from_bytes(hashlib.sha256(symbol.encode("utf-8")).digest()[:8], "big")


def _is_trading_day(symbol: str, d: date) -> bool:
    return is_crypto(symbol) or d.weekday() < 5


class MockProvider:
    name = "mock"

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(UTC))
        self._series: dict[str, list[float]] = {}

    def _base_price(self, symbol: str) -> float:
        if symbol in BASE_PRICES:
            return BASE_PRICES[symbol]
        seed = symbol_seed(symbol)
        return float(20 + seed % 480) if not is_crypto(symbol) else float(1 + seed % 200)

    def _log_prices(self, symbol: str, upto: date) -> list[float]:
        """Log price per calendar day from ANCHOR through `upto`, extended lazily and memoised."""
        series = self._series.setdefault(symbol, [])
        n = (upto - ANCHOR).days + 1
        if len(series) >= n:
            return series
        rng = random.Random(symbol_seed(symbol))  # noqa: S311 - deterministic mock data
        vol = CRYPTO_VOL if is_crypto(symbol) else EQUITY_VOL
        log_base = math.log(self._base_price(symbol))
        ref = (REFERENCE - ANCHOR).days
        series.clear()
        value = log_base - ANNUAL_DRIFT * ref / 365
        for t in range(max(n, 1)):
            target = log_base + ANNUAL_DRIFT * (t - ref) / 365
            value += MEAN_REVERSION * (target - value) + rng.gauss(0.0, vol)
            series.append(value)
        return series

    def price_on(self, symbol: str, d: date) -> float:
        if d < ANCHOR:
            d = ANCHOR
        value = math.exp(self._log_prices(symbol, d)[(d - ANCHOR).days])
        return round(value, 4 if value < 1 else 2)

    def _last_trading_day(self, symbol: str, d: date) -> date:
        while not _is_trading_day(symbol, d):
            d -= timedelta(days=1)
        return d

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        now = self._now()
        today = now.astimezone(UTC).date()
        out: dict[str, Quote] = {}
        for symbol in symbols:
            last = self._last_trading_day(symbol, today)
            prev = self._last_trading_day(symbol, last - timedelta(days=1))
            as_of = now if last == today else datetime.combine(last, time(20, 0), UTC)
            out[symbol] = Quote(
                symbol=symbol,
                price=self.price_on(symbol, last),
                previous_close=self.price_on(symbol, prev),
                currency=currency_for(symbol),
                as_of=iso_datetime(as_of),
                source=self.name,
            )
        return out

    def get_eod_history(self, symbol: str, start: date, end: date) -> list[EodPrice]:
        today = self._now().astimezone(UTC).date()
        end = min(end, today)
        currency = currency_for(symbol)
        out: list[EodPrice] = []
        d = max(start, ANCHOR)
        while d <= end:
            if _is_trading_day(symbol, d):
                out.append(
                    EodPrice(
                        symbol=symbol, date=d.isoformat(), close=self.price_on(symbol, d), currency=currency
                    )
                )
            d += timedelta(days=1)
        return out

    def get_profile(self, symbol: str) -> InstrumentProfile | None:
        if symbol in PROFILES:
            return PROFILES[symbol]
        profile = minimal_profile(symbol)
        if profile.asset_class == "OTHER":
            return InstrumentProfile(
                symbol=symbol,
                name=f"{symbol} (mock)",
                asset_class="STOCK",
                currency=profile.currency,
                sector="Unknown",
                country=profile.country,
                exchange=profile.exchange,
            )
        return profile

    def _schedule(self, symbol: str) -> tuple[tuple[int, ...], int, float, int] | None:
        if symbol in DIVIDEND_SCHEDULES:
            return DIVIDEND_SCHEDULES[symbol]
        if is_crypto(symbol) or symbol in NON_PAYERS or symbol in BASE_PRICES:
            return None
        seed = symbol_seed(symbol)
        if seed % 3 != 0:
            return None
        return (3, 6, 9, 12), 1 + seed % 20, round(self._base_price(symbol) * 0.005, 2), 14

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        schedule = self._schedule(symbol)
        if schedule is None:
            return []
        months, day, amount, pay_delay = schedule
        currency = currency_for(symbol)
        out: list[DividendEvent] = []
        for year in range(start.year, end.year + 1):
            for month in months:
                ex = date(year, month, day)
                if start <= ex <= end:
                    out.append(
                        DividendEvent(
                            symbol=symbol,
                            ex_date=ex.isoformat(),
                            pay_date=(ex + timedelta(days=pay_delay)).isoformat(),
                            amount=amount,
                            currency=currency,
                        )
                    )
        return out


FX_AMPLITUDE: dict[str, float] = {"DKK": 0.002}  # DKK is pegged to the EUR (ERM II)


def mock_eur_rate(currency: str, d: date) -> float:
    """Smooth deterministic EUR→`currency` fixing: MOCK_FX_RATES level x two seeded sine waves (±~6%)."""
    seed = symbol_seed(f"FX:{currency}")
    amplitude = FX_AMPLITUDE.get(currency, 0.05)
    t = (d - ANCHOR).days
    slow = 2 * math.pi * t / (700 + seed % 500) + (seed % 628) / 100
    fast = 2 * math.pi * t / (60 + (seed >> 16) % 60) + ((seed >> 32) % 628) / 100
    wave = amplitude * (math.sin(slow) + 0.2 * math.sin(fast))
    return round(MOCK_FX_RATES[currency] * math.exp(wave), 6)


def _last_business_day(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


class MockFx:
    """Offline FX: ECB-like fixings on weekdays only, consistent between `get_latest` and `get_history`."""

    name = "mock-fx"

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(UTC))

    def _rates(self, base: str, d: date) -> dict[str, float]:
        eur = {c: mock_eur_rate(c, d) for c in MOCK_FX_RATES}
        if base == "EUR":
            return eur
        if base not in eur:
            raise SymbolNotFoundError(f"mock-fx: unsupported base {base}", provider=self.name)
        per_eur = eur[base]
        rates = {c: round(r / per_eur, 6) for c, r in eur.items() if c != base}
        rates["EUR"] = round(1 / per_eur, 6)
        return rates

    def get_latest(self, base: str) -> FxRates:
        now = self._now()
        day = _last_business_day(now.astimezone(UTC).date())
        return FxRates(base=base, rates=self._rates(base, day), as_of=iso_datetime(now), date=day.isoformat())

    def get_history(self, base: str, start: date, end: date) -> list[FxDay]:
        end = min(end, self._now().astimezone(UTC).date())
        out: list[FxDay] = []
        d = start
        while d <= end:
            if d.weekday() < 5:
                out.append(FxDay(base=base, date=d.isoformat(), rates=self._rates(base, d)))
            d += timedelta(days=1)
        return out
