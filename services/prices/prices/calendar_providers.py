"""Calendar data sources: earnings dates, splits and (re-checked) dividends.

Free-tier research (verified against the providers' documentation, see docs/architecture.md "Calendar"):

| Data                | Source                                  | Free-tier fit                           |
|---------------------|-----------------------------------------|-----------------------------------------|
| Earnings dates      | Alpha Vantage `EARNINGS_CALENDAR` (CSV) | one call lists all US companies, 3-12 m |
| Splits              | EODHD `/splits/{symbol}`                | 1 call per symbol of the 20 calls/day   |
| Dividends (refresh) | EODHD `/div/{symbol}` (existing)        | 1 call per symbol, same budget          |

Not used: EODHD's calendar endpoints (paid plans only), Twelve Data's splits/earnings endpoints (Grow plan
and above; a 40-credit call cannot fit the free 8 credits/minute), Finnhub (splits are premium, earnings
are US-only and would need a fourth API key). Mergers, spin-offs, symbol changes and rights issues have no
free source.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

from .calendar_config import CalendarSettings
from .calendar_models import EarningsEvent, SplitEvent
from .errors import ProviderError, RateLimitError, SymbolNotFoundError
from .httpclient import HttpClient, TokenBucket
from .models import DividendEvent
from .providers.base import as_float
from .providers.eodhd import BASE_URL as EODHD_URL
from .providers.eodhd import EodhdProvider, to_provider_symbol
from .providers.mock import BASE_PRICES, MockProvider, symbol_seed
from .secrets import get_api_key
from .symbols import currency_for, has_exchange_suffix, is_crypto

ALPHAVANTAGE_URL = "https://www.alphavantage.co/query"
TIME_OF_DAY = {"pre-market": "BMO", "post-market": "AMC"}


class EarningsSource(Protocol):
    name: str
    #: Whether the daily call budget applies (false for the offline mock).
    budgeted: bool

    def fetch(self, symbols: Sequence[str], today: date) -> list[EarningsEvent]:
        """Upcoming earnings of the tracked `symbols` (canonical form); at most one provider call."""


class CorporateActionsSource(Protocol):
    name: str
    #: Whether the daily call budget applies (false for the offline mock).
    budgeted: bool

    def get_splits(self, symbol: str, start: date) -> list[SplitEvent]: ...

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]: ...


# --------------------------------------------------------------------------- HTTP


class TextHttpClient(HttpClient):
    """HttpClient that returns the response body as text (CSV) instead of parsing JSON."""

    def _parse_body(self, body: bytes, safe_url: str, symbol: str | None) -> Any:
        return body.decode("utf-8-sig", errors="replace")

    def get_text(
        self,
        url: str,
        params: dict[str, Any] | None = None,
        *,
        symbol: str | None = None,
    ) -> str:
        return str(self.get_json(url, params, {"Accept": "text/csv, */*"}, symbol=symbol))


# --------------------------------------------------------------------------- earnings (Alpha Vantage)


def av_symbol(symbol: str) -> str | None:
    """Alpha Vantage symbol of a canonical one, or None when Alpha Vantage has no (US) listing for it.

    US share classes are `BRK-B` here and `BRK.B` there. Exchange-suffixed listings (`ASML.AS`) and
    crypto are not covered by the US-only earnings calendar."""
    if is_crypto(symbol) or has_exchange_suffix(symbol):
        return None
    return symbol.replace("-", ".")


def _iso_date(value: str | None) -> str | None:
    try:
        return date.fromisoformat((value or "").strip()).isoformat()
    except ValueError:
        return None


def _eps(value: str | None) -> float | None:
    return as_float((value or "").strip() or None)


def _raise_for_json_body(text: str) -> None:
    """Alpha Vantage answers throttling and bad requests with HTTP 200 and a JSON body instead of CSV."""
    try:
        payload = json.loads(text)
    except ValueError:
        return
    message = ""
    if isinstance(payload, dict):
        message = str(payload.get("Information") or payload.get("Note") or payload.get("Error Message") or "")
    if "call frequency" in message or "requests per day" in message or "rate limit" in message.lower():
        raise RateLimitError("alphavantage: rate limited", provider="alphavantage")
    raise ProviderError(
        "alphavantage: unexpected JSON response for EARNINGS_CALENDAR", provider="alphavantage"
    )


def parse_earnings_csv(text: str, mapping: dict[str, str]) -> list[EarningsEvent]:
    """Rows of the EARNINGS_CALENDAR CSV for the symbols in `mapping` (Alpha Vantage symbol -> canonical).

    Columns: symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay. Rows without a valid
    report date are skipped; an empty/"None"/malformed estimate becomes None; the time of day is
    `pre-market`, `post-market` or empty."""
    text = text.lstrip("\ufeff")
    if text.lstrip().startswith("{"):
        _raise_for_json_body(text)
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "symbol" not in reader.fieldnames or "reportDate" not in reader.fieldnames:
        raise ProviderError(
            "alphavantage: unexpected response for EARNINGS_CALENDAR", provider="alphavantage"
        )
    out: dict[tuple[str, str], EarningsEvent] = {}
    for row in reader:
        canonical = mapping.get((row.get("symbol") or "").strip().upper())
        report = _iso_date(row.get("reportDate"))
        if canonical is None or report is None:
            continue
        currency = (row.get("currency") or "").strip().upper()
        out[(canonical, report)] = EarningsEvent(
            symbol=canonical,
            date=report,
            name=(row.get("name") or "").strip() or None,
            fiscal_period_end=_iso_date(row.get("fiscalDateEnding")),
            eps_estimate=_eps(row.get("estimate")),
            currency=currency if len(currency) == 3 and currency.isalpha() else None,
            time_of_day=TIME_OF_DAY.get((row.get("timeOfTheDay") or "").strip().lower(), "unknown"),
            source="alphavantage",
        )
    return [out[k] for k in sorted(out)]


class AlphaVantageEarnings:
    name = "alphavantage"
    budgeted = True

    def __init__(
        self,
        api_key: str,
        *,
        horizon: str = "12month",
        http: TextHttpClient | None = None,
        bucket: TokenBucket | None = None,
    ) -> None:
        self._key = api_key
        self._horizon = horizon
        self._http = http or TextHttpClient(self.name, timeout=30.0)
        self._bucket = bucket or TokenBucket(1, 5 / 60.0)

    def fetch(self, symbols: Sequence[str], today: date) -> list[EarningsEvent]:
        mapping = {av: s for s in symbols if (av := av_symbol(s)) is not None}
        if not mapping:
            return []
        self._bucket.acquire(1)
        text = self._http.get_text(
            ALPHAVANTAGE_URL,
            {"function": "EARNINGS_CALENDAR", "horizon": self._horizon, "apikey": self._key},
        )
        return [e for e in parse_earnings_csv(text, mapping) if e.date >= today.isoformat()]


# --------------------------------------------------------------------------- splits (EODHD)


def parse_split_ratio(raw: Any) -> tuple[float, float] | None:
    """`"4.000000/1.000000"` (new / old shares) -> (from_factor=1, to_factor=4); None when malformed."""
    if not isinstance(raw, str) or raw.count("/") != 1:
        return None
    new_raw, old_raw = raw.split("/")
    new, old = as_float(new_raw.strip()), as_float(old_raw.strip())
    if new is None or old is None or new <= 0 or old <= 0:
        return None
    return old, new


def parse_splits(data: Any, symbol: str, start: date) -> list[SplitEvent]:
    out: dict[str, SplitEvent] = {}
    for row in data if isinstance(data, list) else []:
        if not isinstance(row, dict):
            continue
        day = _iso_date(str(row.get("date") or "")[:10])
        ratio = parse_split_ratio(row.get("split"))
        if day is None or ratio is None or day < start.isoformat():
            continue
        out[day] = SplitEvent(
            symbol=symbol, date=day, from_factor=ratio[0], to_factor=ratio[1], source="eodhd"
        )
    return [out[k] for k in sorted(out)]


class EodhdCorporateActions:
    """Splits from EODHD `/splits/{symbol}` and dividends through the existing EODHD adapter.

    Every call counts against EODHD's 20 free calls per day; the caller budgets them (calendar_handlers)."""

    name = "eodhd"
    budgeted = True

    def __init__(
        self,
        api_key: str,
        *,
        http: HttpClient | None = None,
        dividends: EodhdProvider | None = None,
        bucket: TokenBucket | None = None,
    ) -> None:
        self._key = api_key
        self._http = http or HttpClient(self.name)
        self._dividends = dividends or EodhdProvider(api_key, http=self._http)
        self._bucket = bucket or TokenBucket(5, 1.0)

    def get_splits(self, symbol: str, start: date) -> list[SplitEvent]:
        self._bucket.acquire(1)
        params = {"from": start.isoformat(), "fmt": "json", "api_token": self._key}
        try:
            data = self._http.get_json(
                f"{EODHD_URL}/splits/{to_provider_symbol(symbol)}", params, symbol=symbol
            )
        except SymbolNotFoundError:
            return []
        except ProviderError as exc:
            if exc.status == 402:  # EODHD signals an exhausted daily limit with 402 Payment Required
                raise RateLimitError(
                    f"{self.name}: daily API limit reached", provider=self.name, symbol=symbol
                ) from None
            raise
        return parse_splits(data, symbol, start)

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        return self._dividends.get_dividends(symbol, start, end)


# --------------------------------------------------------------------------- mock (MARKET_DATA_PROVIDER=mock)

#: symbol -> (from_factor, to_factor, days from today): deterministic upcoming splits for local development.
MOCK_SPLITS: dict[str, tuple[float, float, int]] = {"NVDA": (1, 10, 24), "AAPL": (1, 4, 40)}


def _next_weekday(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


class MockCalendarSource:
    """Deterministic earnings, splits and dividends relative to `now` (no network, no API keys)."""

    name = "mock"
    budgeted = False

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        self._now = now or (lambda: datetime.now(UTC))
        self._market = MockProvider(self._now)

    def fetch(self, symbols: Sequence[str], today: date) -> list[EarningsEvent]:
        out: list[EarningsEvent] = []
        for symbol in sorted(set(symbols)):
            if av_symbol(symbol) is None:
                continue
            seed = symbol_seed(symbol)
            report = _next_weekday(today + timedelta(days=5 + seed % 55))
            quarter_end = date(report.year, 3 * ((report.month - 1) // 3) + 1, 1) - timedelta(days=1)
            price = BASE_PRICES.get(symbol, 100.0)
            out.append(
                EarningsEvent(
                    symbol=symbol,
                    date=report.isoformat(),
                    name=symbol,
                    fiscal_period_end=quarter_end.isoformat(),
                    eps_estimate=round(price * 0.006, 2),
                    currency=currency_for(symbol),
                    time_of_day="BMO" if seed % 2 else "AMC",
                    source=self.name,
                )
            )
        return out

    def get_splits(self, symbol: str, start: date) -> list[SplitEvent]:
        spec = MOCK_SPLITS.get(symbol)
        if spec is None:
            return []
        when = _next_weekday(self._now().astimezone(UTC).date() + timedelta(days=spec[2]))
        if when < start:
            return []
        return [
            SplitEvent(
                symbol=symbol, date=when.isoformat(), from_factor=spec[0], to_factor=spec[1], source=self.name
            )
        ]

    def get_dividends(self, symbol: str, start: date, end: date) -> list[DividendEvent]:
        return self._market.get_dividends(symbol, start, end)


# --------------------------------------------------------------------------- factory


def build_calendar_sources(
    kind: str, settings: CalendarSettings
) -> tuple[EarningsSource | None, CorporateActionsSource | None]:
    """`mock` -> offline source for both; `live`/`routing` -> Alpha Vantage earnings and EODHD corporate
    actions, each only when its API key exists (a missing key disables that part; it never fails)."""
    if kind == "mock":
        mock = MockCalendarSource()
        return mock, mock
    if kind not in ("live", "routing"):
        raise ValueError(f"unknown MARKET_DATA_PROVIDER {kind!r} (expected 'mock' or 'live')")
    alphavantage_key = get_api_key("alphavantage")
    eodhd_key = get_api_key("eodhd")
    earnings = (
        AlphaVantageEarnings(alphavantage_key, horizon=settings.earnings_horizon)
        if alphavantage_key
        else None
    )
    actions = EodhdCorporateActions(eodhd_key) if eodhd_key else None
    return earnings, actions
