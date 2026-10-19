"""Generates `parity-cases.json`: provider payloads (taken from the Python tests of services/prices) together with the
normalised results the PYTHON implementation produces for them. The TypeScript port (`packages/prices`) must produce the
same results from the same payloads (`src/parity.test.ts`).

The payloads are synthetic (no personal data, no recorded provider responses). Re-generate after changing a case:

    PYTHONPATH=services/prices services/prices/.venv/bin/python packages/prices/test-fixtures/generate_parity_cases.py

It only imports the Python service; it never modifies it.
"""

from __future__ import annotations

import io
import json
import os
import re
import urllib.error
from datetime import UTC, date, datetime
from decimal import Decimal
from email.message import Message
from pathlib import Path
from typing import Any

from prices import calendar_providers as cp
from prices import keys
from prices import calendar_models as cm
from prices.errors import (
    ProviderError,
    ProviderUnavailableError,
    RateLimitError,
    RetryableProviderError,
    SymbolNotFoundError,
)
from prices.handlers import amsterdam_hour
from prices.httpclient import DailyQuota, HttpClient, TokenBucket
from prices.models import (
    DividendEvent,
    EodPrice,
    FxDay,
    FxRates,
    InstrumentProfile,
    Quote,
    normalize_currency,
)
from prices.providers import fetch_quotes
from prices.providers.alphavantage import AlphaVantageProvider
from prices.providers.base import as_float, clean_text, valid_isin
from prices.providers.coingecko import CoinGeckoProvider
from prices.providers.eodhd import EodhdProvider, to_provider_symbol
from prices.providers.frankfurter import FrankfurterFx, has_weekday, year_chunks
from prices.providers.twelvedata import TwelveDataProvider, asset_class_from_type
from prices import symbols as sym

KEY = "k3y-should-never-leak"
OUT = Path(__file__).with_name("parity-cases.json")


# --------------------------------------------------------------------------- fake transport


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeOpener:
    """Routes are {match, responses}: the next response of the first route whose substring is in the URL.
    A response is a JSON body, {"status": n} (HTTP error) or {"text": "..."} (raw body)."""

    def __init__(self, routes: list[dict[str, Any]]) -> None:
        self.routes = [{"match": r["match"], "responses": list(r["responses"])} for r in routes]
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        for route in self.routes:
            if route["match"] in request.full_url and route["responses"]:
                response = route["responses"].pop(0) if len(route["responses"]) > 1 else route["responses"][0]
                return self._emit(request, response)
        raise AssertionError(f"unexpected request {request.full_url}")

    @staticmethod
    def _emit(request: Any, response: Any) -> FakeResponse:
        if isinstance(response, dict) and set(response) == {"status"}:
            headers = Message()
            headers["Retry-After"] = "0"
            raise urllib.error.HTTPError(request.full_url, response["status"], "err", headers, io.BytesIO(b"error"))
        if isinstance(response, dict) and set(response) == {"text"}:
            return FakeResponse(response["text"].encode())
        return FakeResponse(json.dumps(response).encode())


# --------------------------------------------------------------------------- normalisation


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p.capitalize() for p in rest)


def snake(name: str) -> str:
    return re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), name)


def norm(value: Any) -> Any:
    if hasattr(value, "__dataclass_fields__"):
        return {camel(k): norm(v) for k, v in vars(value).items() if v is not None}
    if isinstance(value, dict):
        return {str(k): norm(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [norm(v) for v in value]
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    return value


def error_kind(exc: BaseException) -> str:
    if isinstance(exc, RateLimitError):
        return "rate-limited"
    if isinstance(exc, RetryableProviderError):
        return "retryable"
    if isinstance(exc, SymbolNotFoundError):
        return "not-found"
    if isinstance(exc, ProviderUnavailableError):
        return "unavailable"
    return "error"


def error_result(exc: ProviderError) -> dict[str, Any]:
    return {"error": {"kind": error_kind(exc), "retryable": exc.retryable, **({"status": exc.status} if exc.status else {})}}


def model(cls: type, data: dict[str, Any]) -> Any:
    return cls(**{snake(k): v for k, v in data.items()})


# --------------------------------------------------------------------------- providers


def free_bucket() -> TokenBucket:
    return TokenBucket(100, 100, sleep=lambda _s: (_ for _ in ()).throw(AssertionError("throttled")))


def build_provider(case: dict[str, Any], opener: FakeOpener) -> Any:
    now = datetime.fromisoformat(case["now"].replace("Z", "+00:00"))
    name = case["provider"]
    http = HttpClient(name.split("-")[0], opener=opener, sleep=lambda _s: None, max_retries=2)
    os.environ["COINGECKO_COIN_IDS"] = case.get("env", {}).get("COINGECKO_COIN_IDS", "")
    if name == "twelvedata":
        return TwelveDataProvider(KEY, http=http, bucket=free_bucket(), quota=DailyQuota(10_000, name), now=lambda: now)
    if name == "eodhd":
        return EodhdProvider(KEY, http=http, quota=DailyQuota(10_000, name), bucket=free_bucket(), now=lambda: now)
    if name == "coingecko":
        return CoinGeckoProvider(KEY, http=http, bucket=free_bucket(), now=lambda: now)
    if name == "alphavantage":
        return AlphaVantageProvider(KEY, http=http, bucket=free_bucket(), now=lambda: now)
    if name == "frankfurter":
        return FrankfurterFx(http=http)
    if name == "alphavantage-earnings":
        text_http = cp.TextHttpClient("alphavantage", opener=opener, sleep=lambda _s: None, max_retries=2)
        return cp.AlphaVantageEarnings(KEY, horizon=case.get("horizon", "12month"), http=text_http, bucket=free_bucket())
    if name == "eodhd-actions":
        dividends = EodhdProvider(KEY, http=http, quota=DailyQuota(10_000, "eodhd"), bucket=free_bucket(), now=lambda: now)
        return cp.EodhdCorporateActions(KEY, http=http, dividends=dividends, bucket=free_bucket())
    raise AssertionError(name)


def quote_batch(provider: Any, symbols: list[str]) -> dict[str, Any]:
    batch = fetch_quotes(provider, symbols)
    return {
        "quotes": norm(batch.quotes),
        "failed": {s: {"kind": error_kind(e), "retryable": e.retryable} for s, e in batch.failed.items()},
    }


def invoke(provider: Any, call: dict[str, Any]) -> Any:
    method, args = call["method"], call.get("args", [])
    if method == "get_quotes":
        return quote_batch(provider, args[0])
    if method in ("get_eod_history", "get_dividends"):
        symbol, start, end = args
        return provider.__getattribute__(method)(symbol, date.fromisoformat(start), date.fromisoformat(end))
    if method == "get_history":
        base, start, end = args
        return provider.get_history(base, date.fromisoformat(start), date.fromisoformat(end))
    if method == "fetch":
        return provider.fetch(args[0], date.fromisoformat(args[1]))
    if method == "get_splits":
        return provider.get_splits(args[0], date.fromisoformat(args[1]))
    return getattr(provider, method)(*args)


def run_provider_case(case: dict[str, Any]) -> dict[str, Any]:
    opener = FakeOpener(case["routes"])
    provider = build_provider(case, opener)
    results = []
    for call in case["calls"]:
        try:
            result = norm(invoke(provider, call))
        except ProviderError as exc:
            result = error_result(exc)
        # Without a fixing date Frankfurter stamps the (non-deterministic) current time.
        if call["method"] == "get_latest" and "date" not in result and "asOf" in result:
            result["asOf"] = "<now>"
        results.append(result)
    headers = {k.lower(): v for r in opener.requests[:1] for k, v in r.header_items() if k.lower() in ("authorization", "x-cg-demo-api-key", "accept")}
    return {"results": results, "urls": [r.full_url for r in opener.requests], "headers": headers}


# --------------------------------------------------------------------------- pure cases


def run_pure_case(case: dict[str, Any]) -> Any:
    fn, args = case["fn"], case["args"]
    if fn == "as_float":
        return [as_float(v) for v in args]
    if fn == "clean_text":
        return [clean_text(*a) for a in args]
    if fn == "valid_isin":
        return [valid_isin(v) for v in args]
    if fn == "asset_class_from_type":
        return [asset_class_from_type(v) for v in args]
    if fn == "to_provider_symbol":
        return [to_provider_symbol(v) for v in args]
    if fn == "year_chunks":
        return [[a.isoformat(), b.isoformat()] for a, b in year_chunks(date.fromisoformat(args[0]), date.fromisoformat(args[1]))]
    if fn == "has_weekday":
        return has_weekday(date.fromisoformat(args[0]), date.fromisoformat(args[1]))
    if fn == "amsterdam_hour":
        return [amsterdam_hour(datetime.fromisoformat(v.replace("Z", "+00:00"))) for v in args]
    if fn == "classify":
        return [
            {
                "symbol": s,
                "crypto": sym.is_crypto(s),
                "suffix": sym.exchange_suffix(s),
                "currency": sym.currency_for(s),
                "priceCurrency": sym.price_currency_for(s),
                "base": sym.base_ticker(s),
                "exchange": sym.exchange_for(s),
                "country": sym.country_for(s),
                "minimal": norm(sym.minimal_profile(s)),
            }
            for s in args
        ]
    if fn == "normalize_currency":
        return [normalize_currency(*a) for a in args]
    if fn == "av_symbol":
        return [cp.av_symbol(s) for s in args]
    if fn == "parse_split_ratio":
        return [list(r) if (r := cp.parse_split_ratio(v)) else None for v in args]
    if fn == "parse_splits":
        return norm(cp.parse_splits(args[0], args[1], date.fromisoformat(args[2])))
    if fn == "parse_earnings_csv":
        mapping = args[1]
        try:
            return {"events": norm(cp.parse_earnings_csv(args[0], mapping))}
        except ProviderError as exc:
            return error_result(exc)
    if fn == "minor_units":
        return [
            norm(model(Quote, {"symbol": "VOD.L", "price": 7250.0, "previousClose": 7100.0, "currency": "GBp", "asOf": "t", "source": "x"})),
            norm(model(EodPrice, {"symbol": "VOD.L", "date": "2026-01-02", "close": 7250.0, "currency": "GBX"})),
            norm(model(DividendEvent, {"symbol": "VOD.L", "exDate": "2026-01-02", "amount": 4.5, "currency": "GBX"})),
            norm(model(EodPrice, {"symbol": "AAPL", "date": "2026-01-02", "close": 10.0, "currency": "USD"})),
        ]
    if fn == "items":
        return run_items(args)
    raise AssertionError(fn)


def run_items(specs: list[dict[str, Any]]) -> list[Any]:
    out = []
    for spec in specs:
        kind, data = spec["item"], spec["model"]
        if kind == "quote":
            out.append(norm(keys.quote_item(model(Quote, data))))
        elif kind == "eod":
            out.append(norm(keys.eod_item(model(EodPrice, data))))
        elif kind == "profile":
            out.append(norm(keys.profile_item(model(InstrumentProfile, data))))
        elif kind == "dividend":
            out.append(norm(keys.dividend_item(model(DividendEvent, data))))
        elif kind == "fx":
            out.append(norm(keys.fx_item(model(FxRates, data))))
        elif kind == "fxDay":
            out.append(norm(keys.fx_day_item(model(FxDay, data))))
        elif kind == "tracked":
            out.append(norm(keys.tracked_item(data["symbol"], data["now"])))
        elif kind == "earnings":
            out.append(norm(cm.earnings_item(model(cm.EarningsEvent, data["event"]), data["updatedAt"])))
        elif kind == "split":
            out.append(norm(cm.split_item(model(cm.SplitEvent, data["event"]), data["updatedAt"])))
        elif kind == "profileDetails":
            out.append(norm(keys.profile_details(model(InstrumentProfile, data))))
        else:
            raise AssertionError(kind)
    return out


# --------------------------------------------------------------------------- cases

NOW = "2026-10-13T12:00:00Z"


def td_quote(symbol: str, close: str, prev: str) -> dict[str, Any]:
    return {"symbol": symbol, "currency": "USD", "close": close, "previous_close": prev, "timestamp": 1792000000}


SYMBOLS = [f"S{i}" for i in range(10)]

PROVIDER_CASES: list[dict[str, Any]] = [
    {
        "id": "twelvedata-quotes-batches-of-8",
        "python": "test_providers_http.py::test_twelvedata_batches_quotes_by_8",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {
                "match": "/quote",
                "responses": [
                    {s: td_quote(s, "10.5", "10") for s in SYMBOLS[:8]},
                    {"S8": td_quote("S8", "1", "1"), "BRK.B": {"code": 400, "status": "error", "message": "not found"}},
                ],
            }
        ],
        "calls": [{"method": "get_quotes", "args": [[*SYMBOLS[:9], "BRK-B"]]}],
    },
    {
        "id": "twelvedata-quote-errors-and-429",
        "python": "test_providers_http.py::test_twelvedata_per_symbol_errors_and_429 + test_twelvedata_batch_entry_429",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {
                "match": "symbol=AAPL,NOPE",
                "responses": [{"AAPL": td_quote("AAPL", "1", "1"), "NOPE": {"code": 404, "status": "error"}}],
            },
            {"match": "symbol=MSFT", "responses": [{"code": 429, "status": "error", "message": "out of credits"}]},
            {
                "match": "symbol=AAPL,MSFT",
                "responses": [{"AAPL": td_quote("AAPL", "1", "1"), "MSFT": {"code": 429, "status": "error"}}],
            },
        ],
        "calls": [
            {"method": "get_quotes", "args": [["AAPL", "NOPE"]]},
            {"method": "get_quotes", "args": [["MSFT"]]},
            {"method": "get_quotes", "args": [["AAPL", "MSFT"]]},
        ],
    },
    {
        "id": "twelvedata-single-symbol-quote",
        "python": "test_providers_http.py (single-symbol response shape of get_quotes)",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {
                "match": "/quote",
                "responses": [
                    {"symbol": "AAPL", "currency": "usd", "close": "230.12", "previous_close": "228.5", "last_quote_at": 1792000000},
                    {"symbol": "XYZ", "currency": "GBp", "close": "7250", "timestamp": 1792000000},
                    {"symbol": "NOCLOSE", "close": None},
                    {"code": 404, "status": "error", "message": "unknown"},
                ],
            }
        ],
        "calls": [
            {"method": "get_quotes", "args": [["AAPL"]]},
            {"method": "get_quotes", "args": [["XYZ"]]},
            {"method": "get_quotes", "args": [["NOCLOSE"]]},
            {"method": "get_quotes", "args": [["NOPE"]]},
        ],
    },
    {
        "id": "twelvedata-time-series",
        "python": "test_providers_http.py::test_twelvedata_time_series",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {
                "match": "/time_series",
                "responses": [
                    {
                        "meta": {"symbol": "AAPL", "currency": "USD"},
                        "values": [
                            {"datetime": "2026-10-09", "close": "101.5"},
                            {"datetime": "2026-10-08", "close": "100"},
                            {"datetime": "2020-01-01", "close": "1"},
                            {"datetime": "2026-10-10", "close": None},
                        ],
                        "status": "ok",
                    }
                ],
            }
        ],
        "calls": [{"method": "get_eod_history", "args": ["AAPL", "2026-01-01", "2026-10-13"]}],
    },
    {
        "id": "twelvedata-profile-reference-fallback",
        "python": "test_providers_http.py::test_twelvedata_profile_falls_back_to_reference",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {"match": "/profile", "responses": [{"code": 403, "status": "error", "message": "available on Grow plan"}]},
            {
                "match": "/stocks",
                "responses": [
                    {"data": []},
                    {"data": [{"name": "Apple Inc", "currency": "USD", "country": "United States", "exchange": "NASDAQ", "type": "Common Stock"}]},
                ],
            },
            {
                "match": "/etfs",
                "responses": [{"data": [{"symbol": "SPY", "name": "SPDR S&P 500", "currency": "USD", "country": "USA", "exchange": "NYSE"}]}],
            },
        ],
        "calls": [{"method": "get_profile", "args": ["SPY"]}, {"method": "get_profile", "args": ["AAPL"]}],
    },
    {
        "id": "twelvedata-profile-endpoint",
        "python": "test_providers_http.py::test_twelvedata_profile_endpoint + test_profile_details.py::test_twelvedata_profile_carries_the_description",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {
                "match": "/profile",
                "responses": [
                    {"symbol": "MSFT", "name": "Microsoft", "sector": "Technology", "country": "United States", "exchange": "NASDAQ", "type": "Common Stock"},
                    {"symbol": "MSFT", "name": "Microsoft", "type": "Common Stock", "description": "  Software   maker. "},
                ],
            }
        ],
        "calls": [{"method": "get_profile", "args": ["MSFT"]}, {"method": "get_profile", "args": ["MSFT"]}],
    },
    {
        "id": "twelvedata-profile-unknown-and-dividends",
        "python": "test_providers_http.py::test_twelvedata_profile_unknown + test_twelvedata_5xx_in_body",
        "provider": "twelvedata",
        "now": NOW,
        "routes": [
            {"match": "symbol=ZZZZ", "responses": [{"code": 404, "status": "error"}, {"data": []}, {"data": []}]},
            {"match": "symbol=BOOM", "responses": [{"code": 500, "status": "error"}]},
        ],
        "calls": [
            {"method": "get_profile", "args": ["ZZZZ"]},
            {"method": "get_dividends", "args": ["AAPL", "2026-01-01", "2026-02-01"]},
            {"method": "get_profile", "args": ["BOOM"]},
        ],
    },
    {
        "id": "eodhd-realtime-batch",
        "python": "test_providers_http.py::test_eodhd_realtime_batch",
        "provider": "eodhd",
        "now": NOW,
        "routes": [
            {
                "match": "/real-time/ASML.AS",
                "responses": [
                    [
                        {"code": "ASML.AS", "timestamp": 1792000000, "close": 701.2, "previousClose": 690},
                        {"code": "SAP.XETRA", "timestamp": "NA", "close": "NA", "previousClose": "NA"},
                        "garbage",
                    ]
                ],
            }
        ],
        "calls": [{"method": "get_quotes", "args": [["ASML.AS", "SAP.DE"]]}],
    },
    {
        "id": "eodhd-single-quote-not-found-and-pence",
        "python": "test_providers_http.py::test_eodhd_single_and_not_found + test_symbols_keys.py::test_minor_unit_prices_are_rescaled_to_major_currency",
        "provider": "eodhd",
        "now": NOW,
        "routes": [
            {"match": "/real-time/SAP.XETRA", "responses": [{"code": "SAP.XETRA", "close": 230, "previousClose": None}]},
            {"match": "/real-time/NOPE.AS", "responses": [{"status": 404}]},
            {"match": "/real-time/VOD.LSE", "responses": [{"code": "VOD.LSE", "close": 7250, "previousClose": 7100, "timestamp": 1792000000}]},
        ],
        "calls": [
            {"method": "get_quotes", "args": [["SAP.DE"]]},
            {"method": "get_quotes", "args": [["NOPE.AS"]]},
            {"method": "get_quotes", "args": [["VOD.L"]]},
        ],
    },
    {
        "id": "eodhd-402-is-a-rate-limit",
        "python": "test_providers_http.py::test_eodhd_quota_and_402",
        "provider": "eodhd",
        "now": NOW,
        "routes": [{"match": "/eod/", "responses": [{"status": 402}]}],
        "calls": [{"method": "get_eod_history", "args": ["ASML.AS", "2026-01-01", "2026-02-01"]}],
    },
    {
        "id": "eodhd-eod-and-dividends",
        "python": "test_providers_http.py::test_eodhd_eod_and_dividends",
        "provider": "eodhd",
        "now": NOW,
        "routes": [
            {"match": "/eod/SAP.XETRA", "responses": [[{"date": "2026-10-09", "close": 231.5}, {"date": "2026-10-08", "close": 230}, "x", {"date": "2026-10-10", "close": "NA"}]]},
            {
                "match": "/div/AAPL.US",
                "responses": [
                    [
                        {"date": "2026-08-11", "paymentDate": "2026-08-14", "value": 0.26, "currency": "USD"},
                        {"date": "2027-11-10", "value": 0.27},
                        {"date": "2026-11-10", "value": 0.27, "paymentDate": ""},
                        {"date": "2026-11-10", "value": 0.28},
                    ]
                ],
            },
            {"match": "/div/NOPE.US", "responses": [{"status": 404}]},
            {"match": "/div/VOD.LSE", "responses": [[{"date": "2026-08-01", "value": 4.5}]]},
        ],
        "calls": [
            {"method": "get_eod_history", "args": ["SAP.DE", "2026-01-01", "2026-10-13"]},
            {"method": "get_dividends", "args": ["AAPL", "2024-10-13", "2027-10-13"]},
            {"method": "get_dividends", "args": ["NOPE", "2024-01-01", "2027-01-01"]},
            {"method": "get_dividends", "args": ["VOD.L", "2024-01-01", "2027-01-01"]},
        ],
    },
    {
        "id": "eodhd-profile-search",
        "python": "test_providers_http.py::test_eodhd_profile_search + test_profile_details.py::test_eodhd_search_result_carries_a_valid_isin",
        "provider": "eodhd",
        "now": NOW,
        "routes": [
            {
                "match": "/search/ASML",
                "responses": [
                    [
                        {"Code": "ASML", "Exchange": "US", "Name": "ASML ADR", "Type": "Common Stock"},
                        {"Code": "ASML", "Exchange": "AS", "Name": "ASML Holding NV", "Type": "Common Stock", "Country": "Netherlands", "Currency": "EUR", "ISIN": " nl0010273215 "},
                    ],
                    [],
                    [{"Code": "ASML", "Exchange": "AS", "Name": "ASML Holding NV", "Type": "ETF", "ISIN": "bad", "Country": "USA"}],
                ],
            }
        ],
        "calls": [{"method": "get_profile", "args": ["ASML.AS"]}, {"method": "get_profile", "args": ["ASML.AS"]}, {"method": "get_profile", "args": ["ASML.AS"]}],
    },
    {
        "id": "coingecko-quotes",
        "python": "test_providers_http.py::test_coingecko_quotes + test_coingecko_unknown_only",
        "provider": "coingecko",
        "now": NOW,
        "routes": [
            {
                "match": "/simple/price",
                "responses": [
                    {
                        "bitcoin": {"eur": 60600.0, "eur_24h_change": 1.0, "last_updated_at": 1792000000},
                        "ethereum": {"usd": 3000},
                        "solana": {"usd": 150.123456789, "usd_24h_change": -100},
                        "cardano": {"usd": 0.5, "usd_24h_change": 33.333333333},
                    }
                ],
            }
        ],
        "calls": [
            {"method": "get_quotes", "args": [["BTC-EUR", "ETH-USD", "WAT-EUR", "SOL-USD", "ADA-USD"]]},
            {"method": "get_quotes", "args": [["WAT-EUR"]]},
        ],
    },
    {
        "id": "coingecko-history-and-profile",
        "python": "test_providers_http.py::test_coingecko_history_and_profile",
        "provider": "coingecko",
        "now": NOW,
        "env": {"COINGECKO_COIN_IDS": "WAT=wat-coin, bad"},
        "routes": [
            {
                "match": "/coins/bitcoin/market_chart",
                "responses": [
                    {
                        "prices": [
                            [1791676800000, 1.0],
                            [1791763200000, 2.0],
                            [1791849600000, 3.0],
                            [1791853200000, 3.5],
                            ["bad"],
                            [1791849600001, "NA"],
                        ]
                    }
                ],
            }
        ],
        "calls": [
            {"method": "get_eod_history", "args": ["BTC-EUR", "2025-10-13", "2026-10-13"]},
            {"method": "get_profile", "args": ["BTC-EUR"]},
            {"method": "get_dividends", "args": ["BTC-EUR", "2020-01-01", "2030-01-01"]},
            {"method": "get_eod_history", "args": ["NOPE-EUR", "2026-01-01", "2026-02-01"]},
            {"method": "get_profile", "args": ["WAT-EUR"]},
        ],
    },
    {
        "id": "alphavantage-overview",
        "python": "test_providers_http.py::test_alphavantage_overview + test_profile_details.py::test_alphavantage_overview_carries_company_details/ignores_placeholder_details",
        "provider": "alphavantage",
        "now": NOW,
        "routes": [
            {
                "match": "OVERVIEW",
                "responses": [
                    {"Symbol": "AAPL", "AssetType": "Common Stock", "Name": "Apple Inc", "Exchange": "NASDAQ", "Currency": "USD", "Country": "USA", "Sector": "TECHNOLOGY"},
                    {},
                    {"Information": "rate limit is 25 requests per day"},
                    {
                        "Symbol": "AAPL",
                        "AssetType": "Common Stock",
                        "Name": "Apple Inc",
                        "Currency": "USD",
                        "Country": "USA",
                        "Description": "Designs phones.",
                        "MarketCapitalization": "3500000000000",
                        "EPS": "6.42",
                        "Beta": "1.24",
                        "PERatio": "34.9",
                    },
                    {"Symbol": "XYZ", "Name": "Loss Maker", "Description": "None", "MarketCapitalization": "0", "EPS": "-1.5", "Beta": "-", "PERatio": "None"},
                    {"Symbol": "CCC", "Name": "Consumer", "Sector": "CONSUMER CYCLICAL", "AssetType": "ETF"},
                    {"Symbol": "DDD", "Name": "Mixed", "Sector": "Real Estate & Land", "AssetType": "Mutual Fund", "Country": "Netherlands"},
                    {"Symbol": "EEE", "Sector": "None", "Country": ""},
                    {"Error Message": "Invalid API call"},
                ],
            }
        ],
        "calls": [{"method": "get_profile", "args": [s]} for s in ["AAPL", "SPY", "MSFT", "AAPL", "XYZ", "CCC", "DDD", "EEE", "ERR"]]
        + [{"method": "get_quotes", "args": [["AAPL"]]}],
    },
    {
        "id": "alphavantage-pe-ratio",
        "python": "test_providers_http.py::test_alphavantage_overview_pe_ratio + test_alphavantage_overview_without_pe_field",
        "provider": "alphavantage",
        "now": NOW,
        "routes": [
            {
                "match": "OVERVIEW",
                "responses": [
                    {"Symbol": "AAPL", "AssetType": "Common Stock", "Name": "Apple Inc", "PERatio": v}
                    for v in ["34.21", "None", "-", "0", "-12.5", "abc", "inf", "", 25]
                ]
                + [{"Symbol": "SPY", "AssetType": "ETF", "Name": "SPDR"}],
            }
        ],
        "calls": [{"method": "get_profile", "args": ["AAPL"]}] * 9 + [{"method": "get_profile", "args": ["SPY"]}],
    },
    {
        "id": "frankfurter-latest",
        "python": "test_providers_http.py::test_frankfurter + test_fx_history.py::test_frankfurter_latest_records_fixing_date",
        "provider": "frankfurter",
        "now": NOW,
        "routes": [
            {
                "match": "frankfurter",
                "responses": [
                    {"base": "EUR", "date": "2026-10-13", "rates": {"USD": 1.0841, "JPY": 162, "BAD": "x", "eur": 1, "NEG": -1}},
                    {"base": "EUR", "rates": {}},
                    {"base": "EUR", "date": "2026-12-01", "rates": {"usd": 1.16, "EUR": 1}},
                    {"rates": {"USD": 1.16}},
                    {"status": 404},
                ],
            }
        ],
        "calls": [{"method": "get_latest", "args": ["EUR"]}] * 4 + [{"method": "get_latest", "args": ["EUR"]}],
    },
    {
        "id": "frankfurter-history-chunks",
        "python": "test_fx_history.py::test_frankfurter_history_chunks_requests_per_year_and_parses + skips_weekend_and_holiday_chunks",
        "provider": "frankfurter",
        "now": NOW,
        "routes": [
            {
                "match": "2024-12-30..2024-12-31",
                "responses": [
                    {
                        "amount": 1.0,
                        "base": "EUR",
                        "rates": {
                            "2024-12-31": {"USD": 1.0389, "GBP": "0.82918", "EUR": 1, "BAD": "x", "NEG": -1},
                            "2024-12-30": {"usd": 1.0444, "JPY": 163.65},
                        },
                    }
                ],
            },
            {
                "match": "2025-01-01..2025-12-31",
                "responses": [
                    {
                        "base": "EUR",
                        "rates": {
                            "2024-12-31": {"USD": 9.9},
                            "2025-01-02": {"USD": 1.0321},
                            "2025-01-03": {},
                            "2025-01-06": "garbage",
                            "2025-12-31": {"USD": 1.1750},
                        },
                    }
                ],
            },
            {"match": "2026-01-01..2026-01-05", "responses": [{"base": "EUR", "rates": {"2026-01-02": {"USD": 1.17}}}]},
            {"match": "2025-12-25..2025-12-26", "responses": [{"status": 404}]},
            {"match": "2026-01-01..2026-01-01", "responses": [{"base": "EUR"}]},
        ],
        "calls": [
            {"method": "get_history", "args": ["eur", "2024-12-30", "2026-01-05"]},
            {"method": "get_history", "args": ["EUR", "2026-10-17", "2026-10-18"]},
            {"method": "get_history", "args": ["EUR", "2025-12-25", "2025-12-26"]},
            {"method": "get_history", "args": ["EUR", "2026-01-01", "2026-01-01"]},
        ],
    },
    {
        "id": "frankfurter-history-malformed-and-errors",
        "python": "test_fx_history.py::test_frankfurter_history_rejects_malformed_payloads + propagates_retryable_errors",
        "provider": "frankfurter",
        "now": NOW,
        "routes": [
            {
                "match": "2026-10-13..2026-10-13",
                "responses": [None, ["not", "a", "dict"], {"base": "USD", "rates": {}}, {"base": "EUR", "rates": ["x"]}, {"status": 503}],
            }
        ],
        "calls": [{"method": "get_history", "args": ["EUR", "2026-10-13", "2026-10-13"]}] * 5,
    },
]

EARNINGS_CSV = """symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
AAPL,APPLE INC,2026-10-29,2026-09-30,1.85,USD,post-market
MSFT,MICROSOFT CORP,2026-10-28,2026-09-30,,USD,pre-market
BRK.B,BERKSHIRE HATHAWAY INC,2026-11-01,2026-09-30,None,usd,
KO,COCA COLA CO,2026-10-21,2026-09-30,abc,US,during-market
NVDA,NVIDIA CORP,not-a-date,2026-09-30,1.0,USD,pre-market
TSLA,TESLA INC,2026-10-22,2026-09-30,0.5,USD,pre-market
AAPL,APPLE INC,2026-10-29,2026-09-30,1.9,USD,post-market
,,,,,,
"""
MAPPING = {"AAPL": "AAPL", "MSFT": "MSFT", "BRK.B": "BRK-B", "KO": "KO", "NVDA": "NVDA"}
QUOTED_CSV = 'symbol,name,reportDate,estimate\r\nAAPL,"Apple, ""the"" Inc",2026-10-29,"1.5"\r\n\r\nMSFT,"Micro\nsoft",2026-10-28,2\r\n'

CALENDAR_CASES: list[dict[str, Any]] = [
    {
        "id": "alphavantage-earnings-one-call",
        "python": "test_calendar_providers.py::test_alphavantage_earnings_makes_one_call_for_all_symbols/skips_the_call_without_us_symbols/drops_dates_in_the_past",
        "provider": "alphavantage-earnings",
        "now": NOW,
        "horizon": "6month",
        "routes": [{"match": "EARNINGS_CALENDAR", "responses": [{"text": EARNINGS_CSV}]}],
        "calls": [
            {"method": "fetch", "args": [["AAPL", "MSFT", "BRK-B", "ASML.AS", "BTC-EUR"], "2026-10-15"]},
            {"method": "fetch", "args": [["ASML.AS", "BTC-EUR"], "2026-10-15"]},
            {"method": "fetch", "args": [["AAPL", "MSFT"], "2026-10-29"]},
        ],
    },
    {
        "id": "alphavantage-earnings-http-429",
        "python": "test_calendar_providers.py::test_alphavantage_earnings_reports_http_failures",
        "provider": "alphavantage-earnings",
        "now": NOW,
        "routes": [{"match": "EARNINGS_CALENDAR", "responses": [{"status": 429}]}],
        "calls": [{"method": "fetch", "args": [["AAPL"], "2026-10-15"]}],
    },
    {
        "id": "alphavantage-earnings-json-and-non-csv-bodies",
        "python": "test_calendar_providers.py::test_parse_earnings_csv_rejects_non_csv_bodies (through the HTTP client)",
        "provider": "alphavantage-earnings",
        "now": NOW,
        "routes": [
            {
                "match": "EARNINGS_CALENDAR",
                "responses": [{"text": '{"Information": "Thank you! Our standard API rate limit is 25 requests per day."}'}, {"text": "a,b\n1,2\n"}],
            }
        ],
        "calls": [{"method": "fetch", "args": [["AAPL"], "2026-10-15"]}] * 2,
    },
    {
        "id": "eodhd-splits-and-dividends",
        "python": "test_calendar_providers.py::test_eodhd_splits_* + test_eodhd_dividends_go_through_the_existing_adapter",
        "provider": "eodhd-actions",
        "now": NOW,
        "routes": [
            {"match": "/splits/AAPL.US", "responses": [[{"date": "2026-11-02", "split": "4.000000/1.000000"}], {"status": 402}, {"status": 403}]},
            {"match": "/splits/SAP.XETRA", "responses": [[]]},
            {"match": "/splits/ZZZZ.US", "responses": [{"status": 404}]},
            {"match": "/div/AAPL.US", "responses": [[{"date": "2026-11-09", "paymentDate": "2026-11-12", "value": 0.26, "currency": "USD"}]]},
        ],
        "calls": [
            {"method": "get_splits", "args": ["AAPL", "2026-07-17"]},
            {"method": "get_splits", "args": ["SAP.DE", "2026-07-17"]},
            {"method": "get_splits", "args": ["ZZZZ", "2026-07-17"]},
            {"method": "get_splits", "args": ["AAPL", "2026-07-17"]},
            {"method": "get_splits", "args": ["AAPL", "2026-07-17"]},
            {"method": "get_dividends", "args": ["AAPL", "2025-01-01", "2027-01-01"]},
        ],
    },
]

PURE_CASES: list[dict[str, Any]] = [
    {"id": "as-float", "python": "providers/base.py::as_float", "fn": "as_float", "args": ["12.5", " 7 ", "1e3", ".5", "5.", "", "NA", "None", "-", "abc", "inf", "nan", "-0.25", 3, 2.5, None]},
    {"id": "clean-text", "python": "test_profile_details.py::test_clean_text_trims_caps_and_drops_placeholders", "fn": "clean_text", "args": [["  Makes   chips \n and more "], ["x" * 30, 10], [None], [5], [""], ["   "], ["None"], ["n/a"], ["-"], ["NA"]]},
    {"id": "valid-isin", "python": "test_profile_details.py::test_valid_isin_is_twelve_ascii_alphanumerics", "fn": "valid_isin", "args": [" nl0010273215 ", None, 12, "NL001027321", "NL0010273215X", "NL00102732-5", "ÑL0010273215"]},
    {"id": "asset-class", "python": "test_providers_http.py::test_asset_class_from_type", "fn": "asset_class_from_type", "args": ["Common Stock", "ETF", "Mutual Fund", "Bond", None, "Depositary Receipt", "Share", "Equity", "REIT"]},
    {"id": "eodhd-symbol-mapping", "python": "test_providers_http.py::test_eodhd_symbol_mapping", "fn": "to_provider_symbol", "args": ["ASML.AS", "SAP.DE", "AAPL", "VOD.L", "MC.PA", "BRK-B", "XYZ.TO"]},
    {"id": "year-chunks", "python": "test_fx_history.py::test_year_chunks_never_cross_a_calendar_year", "fn": "year_chunks", "args": ["2014-06-15", "2016-02-10"]},
    {"id": "year-chunks-single-day", "python": "test_fx_history.py::test_year_chunks_never_cross_a_calendar_year", "fn": "year_chunks", "args": ["2026-10-13", "2026-10-13"]},
    {"id": "year-chunks-empty", "python": "test_fx_history.py::test_year_chunks_never_cross_a_calendar_year", "fn": "year_chunks", "args": ["2026-10-14", "2026-10-13"]},
    {"id": "has-weekday-friday", "python": "test_fx_history.py::test_year_chunks_never_cross_a_calendar_year", "fn": "has_weekday", "args": ["2026-10-16", "2026-10-16"]},
    {"id": "has-weekday-weekend", "python": "test_fx_history.py::test_year_chunks_never_cross_a_calendar_year", "fn": "has_weekday", "args": ["2026-10-17", "2026-10-18"]},
    {"id": "has-weekday-long-range", "python": "test_fx_history.py::test_year_chunks_never_cross_a_calendar_year", "fn": "has_weekday", "args": ["2026-10-17", "2027-03-01"]},
    {
        "id": "amsterdam-hour",
        "python": "test_handlers.py::test_amsterdam_hour",
        "fn": "amsterdam_hour",
        "args": ["2026-10-13T16:00:00Z", "2026-12-01T17:00:00Z", "2026-03-29T00:59:00Z", "2026-03-29T01:00:00Z", "2026-10-25T00:59:00Z", "2026-10-25T01:00:00Z", "2026-10-25T02:30:00Z"],
    },
    {
        "id": "symbol-classification",
        "python": "test_symbols_keys.py::test_symbol_classification + test_symbol_helpers + test_minimal_profile",
        "fn": "classify",
        "args": ["AAPL", "BRK-B", "ASML.AS", "SAP.DE", "MC.PA", "VWRL.AS", "VOD.L", "BTC-EUR", "ETH-USD", "XYZ.AS", "FOO.ZZ", "A&B.DE", "XYZ.TO", "SPY"],
    },
    {"id": "normalize-currency", "python": "test_symbols_keys.py::test_minor_unit_prices_are_rescaled_to_major_currency", "fn": "normalize_currency", "args": [["GBp", "USD"], ["eur", "USD"], [None, "USD"], ["", "EUR"], ["GBX", "USD"], ["ZAc", "USD"], ["ila", "USD"]]},
    {"id": "minor-units", "python": "test_symbols_keys.py::test_minor_unit_prices_are_rescaled_to_major_currency", "fn": "minor_units", "args": []},
    {"id": "av-symbol", "python": "test_calendar_providers.py::test_av_symbol_maps_us_tickers_only", "fn": "av_symbol", "args": ["AAPL", "BRK-B", "ASML.AS", "SAP.DE", "BTC-EUR"]},
    {
        "id": "parse-split-ratio",
        "python": "test_calendar_providers.py::test_parse_split_ratio",
        "fn": "parse_split_ratio",
        "args": ["4.000000/1.000000", "1.000000/10.000000", "3/2", "104.000000/100.000000", "1281/1000", "4", "4/1/2", "a/b", "0/1", "1/0", "-2/1", "nan/1", "inf/1", None, 2],
    },
    {
        "id": "parse-splits",
        "python": "test_calendar_providers.py::test_parse_splits_keeps_valid_rows_from_the_start_date",
        "fn": "parse_splits",
        "args": [
            [
                {"date": "2024-06-10", "split": "10.000000/1.000000"},
                {"date": "2026-09-01", "split": "104/100"},
                {"date": "2026-10-20", "split": "1.000000/8.000000"},
                {"date": "2026-10-20", "split": "1/9"},
                {"date": "garbage", "split": "2/1"},
                {"date": "2026-11-01", "split": "oops"},
                {"date": "2026-11-02"},
                "row",
                None,
            ],
            "NVDA",
            "2026-07-01",
        ],
    },
    {"id": "earnings-csv", "python": "test_calendar_providers.py::test_parse_earnings_csv_maps_rows_and_tolerates_bad_ones", "fn": "parse_earnings_csv", "args": [EARNINGS_CSV, MAPPING]},
    {
        "id": "earnings-csv-bom-blank-values",
        "python": "test_calendar_providers.py::test_parse_earnings_csv_ignores_bom_and_blank_values",
        "fn": "parse_earnings_csv",
        "args": ["\ufeffsymbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nAAPL,,2026-10-29,,,,\n", {"AAPL": "AAPL"}],
    },
    {"id": "earnings-csv-header-only", "python": "test_calendar_providers.py::test_parse_earnings_csv_header_only_is_empty", "fn": "parse_earnings_csv", "args": ["symbol,name,reportDate\n", MAPPING]},
    {"id": "earnings-csv-quoted", "python": "csv.DictReader behaviour (quoted fields, CRLF, blank lines)", "fn": "parse_earnings_csv", "args": [QUOTED_CSV, {"AAPL": "AAPL", "MSFT": "MSFT"}]},
]
for index, body in enumerate(
    [
        '{"Information": "Thank you! Our standard API rate limit is 25 requests per day."}',
        '{"Note": "Our standard API call frequency is 5 calls per minute."}',
        '{"Error Message": "Invalid API call."}',
        "{}",
        "[]",
        "{not json",
        "",
        "<html>nope</html>",
        "a,b\n1,2\n",
    ]
):
    PURE_CASES.append(
        {"id": f"earnings-csv-rejects-{index}", "python": "test_calendar_providers.py::test_parse_earnings_csv_rejects_non_csv_bodies", "fn": "parse_earnings_csv", "args": [body, MAPPING]}
    )

ITEM_CASES: list[dict[str, Any]] = [
    {
        "id": "stored-item-shapes",
        "python": "test_symbols_keys.py::test_item_shapes + test_fx_history.py::test_fx_day_item_shape + test_calendar_models.py::test_earnings_item_shape/test_split_item_shape",
        "fn": "items",
        "args": [
            {"item": "quote", "model": {"symbol": "AAPL", "price": 230.12, "previousClose": 228.5, "currency": "USD", "asOf": "2026-10-13T12:00:00.000Z", "source": "mock"}},
            {"item": "quote", "model": {"symbol": "VOD.L", "price": 7250.0, "previousClose": 7100.0, "currency": "GBp", "asOf": "2026-10-13T12:00:00.000Z", "source": "eodhd"}},
            {"item": "eod", "model": {"symbol": "SAP.DE", "date": "2026-10-12", "close": 0.30000000000000004, "currency": "EUR"}},
            {"item": "profile", "model": {"symbol": "BTC-EUR", "name": "Bitcoin", "assetClass": "CRYPTO", "currency": "EUR"}},
            {
                "item": "profile",
                "model": {"symbol": "AAPL", "name": "Apple Inc.", "assetClass": "STOCK", "currency": "USD", "sector": "Technology", "country": "United States", "exchange": "NASDAQ", "peRatio": 34.2, "fundamentalsAsOf": "2026-10-13"},
            },
            {
                "item": "profile",
                "model": {"symbol": "AAPL", "name": "Apple", "assetClass": "STOCK", "currency": "USD", "description": "Designs phones.", "isin": "US0378331005", "marketCap": 3.5e12, "eps": 6.42, "beta": 1.24, "detailsAsOf": "2026-10-13"},
            },
            {"item": "dividend", "model": {"symbol": "AAPL", "exDate": "2026-02-10", "amount": 0.26, "currency": "USD", "payDate": "2026-02-14"}},
            {"item": "dividend", "model": {"symbol": "VOD.L", "exDate": "2026-02-10", "amount": 4.5, "currency": "GBX"}},
            {"item": "fx", "model": {"base": "EUR", "asOf": "2026-10-13T14:00:00.000Z", "rates": {"USD": 1.085, "JPY": 162}, "date": "2026-10-13"}},
            {"item": "fxDay", "model": {"base": "EUR", "date": "2026-10-13", "rates": {"USD": 1.1612, "JPY": 175, "EUR": 1.0, "GBP": 0.8693}}},
            {"item": "tracked", "model": {"symbol": "AAPL", "now": "2026-10-13T12:00:00.000Z"}},
            {
                "item": "earnings",
                "model": {
                    "event": {"symbol": "AAPL", "date": "2026-10-29", "name": "APPLE INC", "fiscalPeriodEnd": "2026-09-30", "epsEstimate": 1.85, "currency": "USD", "timeOfDay": "AMC", "source": "alphavantage"},
                    "updatedAt": "2026-10-15T05:30:00.000Z",
                },
            },
            {"item": "earnings", "model": {"event": {"symbol": "MSFT", "date": "2026-10-28", "source": "alphavantage"}, "updatedAt": "2026-10-15T05:30:00.000Z"}},
            {"item": "split", "model": {"event": {"symbol": "NVDA", "date": "2026-11-02", "fromFactor": 1, "toFactor": 4, "source": "eodhd"}, "updatedAt": "2026-10-15T05:30:00.000Z"}},
            {"item": "profileDetails", "model": {"symbol": "AAPL", "name": "Apple", "assetClass": "STOCK", "currency": "USD", "sector": "Technology", "eps": 6.42, "peRatio": 34.9}},
        ],
    }
]


def main() -> None:
    cases: list[dict[str, Any]] = []
    for case in [*PROVIDER_CASES, *CALENDAR_CASES]:
        cases.append({"kind": "provider", **case, "expected": run_provider_case(case)})
    for case in [*PURE_CASES, *ITEM_CASES]:
        cases.append({"kind": "pure", **case, "expected": run_pure_case(case)})
    OUT.write_text(json.dumps(cases, indent=2, ensure_ascii=False, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
