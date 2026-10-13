from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

import pytest

from prices.errors import ProviderError, RateLimitError, SymbolNotFoundError
from prices.httpclient import DailyQuota, TokenBucket
from prices.providers.alphavantage import AlphaVantageProvider
from prices.providers.coingecko import CoinGeckoProvider
from prices.providers.eodhd import EodhdProvider, to_provider_symbol
from prices.providers.frankfurter import FrankfurterFx
from prices.providers.twelvedata import TwelveDataProvider, asset_class_from_type
from tests.conftest import FakeOpener

KEY = "k3y-should-never-leak"
NOW = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)


def free_bucket() -> TokenBucket:
    return TokenBucket(100, 100, sleep=lambda _s: pytest.fail("unexpected throttle"))


def td(http_factory: Callable[[str], Any], **kw: Any) -> TwelveDataProvider:
    return TwelveDataProvider(KEY, http=http_factory("twelvedata"), now=lambda: NOW, **kw)


# --------------------------------------------------------------------------- Twelve Data


def td_quote(symbol: str, close: str, prev: str) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "currency": "USD",
        "close": close,
        "previous_close": prev,
        "timestamp": 1792000000,
    }


def test_twelvedata_batches_quotes_by_8(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    symbols = [f"S{i}" for i in range(10)]
    second = {
        "S8": td_quote("S8", "1", "1"),
        "BRK.B": {"code": 400, "status": "error", "message": "not found"},
    }
    opener.add("/quote", [{s: td_quote(s, "10.5", "10") for s in symbols[:8]}, second])
    slept: list[float] = []
    clock = [0.0]

    def sleep(s: float) -> None:
        slept.append(s)
        clock[0] += s

    provider = td(http_factory, bucket=TokenBucket(8, 8 / 60, clock=lambda: clock[0], sleep=sleep))
    quotes = provider.get_quotes([*symbols[:9], "BRK-B"])
    assert len(opener.requests) == 2
    assert "symbol=S0,S1,S2,S3,S4,S5,S6,S7" in opener.urls[0]
    assert "symbol=S8,BRK.B" in opener.urls[1]
    assert all(KEY not in u for u in opener.urls)
    assert opener.requests[0].get_header("Authorization") == f"apikey {KEY}"
    assert slept, "token bucket should throttle after 8 credits"
    q = quotes["S0"]
    assert (q.price, q.previousClose, q.currency, q.source) == (10.5, 10.0, "USD", "twelvedata")
    assert q.asOf == datetime.fromtimestamp(1792000000, UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert "BRK-B" not in quotes and quotes["S8"].price == 1.0


def test_twelvedata_per_symbol_errors_and_429(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add("/quote", [{"AAPL": td_quote("AAPL", "1", "1"), "NOPE": {"code": 404, "status": "error"}}])
    opener.add("/quote", [{"code": 429, "status": "error", "message": "out of credits"}])
    provider = td(http_factory, bucket=free_bucket())
    assert list(provider.get_quotes(["AAPL", "NOPE"])) == ["AAPL"]
    with pytest.raises(RateLimitError):
        provider.get_quotes(["MSFT"])


def test_twelvedata_batch_entry_429(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add("/quote", {"AAPL": td_quote("AAPL", "1", "1"), "MSFT": {"code": 429, "status": "error"}})
    with pytest.raises(RateLimitError):
        td(http_factory, bucket=free_bucket()).get_quotes(["AAPL", "MSFT"])


def test_twelvedata_daily_quota(http_factory: Callable[[str], Any]) -> None:
    provider = td(http_factory, bucket=free_bucket(), quota=DailyQuota(1, "twelvedata"))
    with pytest.raises(RateLimitError):
        provider.get_quotes(["A", "B"])


def test_twelvedata_time_series(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "/time_series",
        {
            "meta": {"symbol": "AAPL", "currency": "USD"},
            "values": [
                {"datetime": "2026-10-09", "close": "101.5"},
                {"datetime": "2026-10-08", "close": "100"},
                {"datetime": "2020-01-01", "close": "1"},
                {"datetime": "2026-10-10", "close": None},
            ],
            "status": "ok",
        },
    )
    rows = td(http_factory, bucket=free_bucket()).get_eod_history(
        "AAPL", date(2026, 1, 1), date(2026, 10, 13)
    )
    assert [(r.date, r.close) for r in rows] == [("2026-10-08", 100.0), ("2026-10-09", 101.5)]
    assert "interval=1day" in opener.urls[0] and "start_date=2026-01-01" in opener.urls[0]


def test_twelvedata_profile_falls_back_to_reference(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("/profile", {"code": 403, "status": "error", "message": "available on Grow plan"})
    opener.add(
        "/stocks",
        [
            {"data": []},
            {
                "data": [
                    {
                        "name": "Apple Inc",
                        "currency": "USD",
                        "country": "United States",
                        "exchange": "NASDAQ",
                        "type": "Common Stock",
                    }
                ]
            },
        ],
    )
    opener.add(
        "/etfs",
        {
            "data": [
                {
                    "symbol": "SPY",
                    "name": "SPDR S&P 500",
                    "currency": "USD",
                    "country": "USA",
                    "exchange": "NYSE",
                }
            ]
        },
    )
    provider = td(http_factory, bucket=free_bucket())
    spy = provider.get_profile("SPY")
    assert (spy.assetClass, spy.country, spy.name) == ("ETF", "United States", "SPDR S&P 500")
    aapl = provider.get_profile("AAPL")
    assert (aapl.assetClass, aapl.exchange, aapl.currency) == ("STOCK", "NASDAQ", "USD")
    assert sum("/profile" in u for u in opener.urls) == 1, "unsupported /profile is not retried"


def test_twelvedata_profile_endpoint(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "/profile",
        {
            "symbol": "MSFT",
            "name": "Microsoft",
            "sector": "Technology",
            "country": "United States",
            "exchange": "NASDAQ",
            "type": "Common Stock",
        },
    )
    p = td(http_factory, bucket=free_bucket()).get_profile("MSFT")
    assert (p.sector, p.assetClass) == ("Technology", "STOCK")


def test_twelvedata_profile_unknown(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add("/profile", {"code": 404, "status": "error"}).add("/stocks", {"data": []}).add(
        "/etfs", {"data": []}
    )
    provider = td(http_factory, bucket=free_bucket())
    assert provider.get_profile("ZZZZ") is None
    with pytest.raises(ProviderError):
        provider.get_dividends("AAPL", date(2026, 1, 1), date(2026, 2, 1))


def test_twelvedata_5xx_in_body(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add("/profile", {"code": 500, "status": "error"})
    with pytest.raises(ProviderError) as info:
        td(http_factory, bucket=free_bucket()).get_profile("AAPL")
    assert info.value.retryable


@pytest.mark.parametrize(
    ("kind", "expected"),
    [("Common Stock", "STOCK"), ("ETF", "ETF"), ("Mutual Fund", "ETF"), ("Bond", "BOND"), (None, "OTHER")],
)
def test_asset_class_from_type(kind: str | None, expected: str) -> None:
    assert asset_class_from_type(kind) == expected


# --------------------------------------------------------------------------- EODHD


@pytest.mark.parametrize(
    ("canonical", "provider_symbol"),
    [
        ("ASML.AS", "ASML.AS"),
        ("SAP.DE", "SAP.XETRA"),
        ("AAPL", "AAPL.US"),
        ("VOD.L", "VOD.LSE"),
        ("MC.PA", "MC.PA"),
    ],
)
def test_eodhd_symbol_mapping(canonical: str, provider_symbol: str) -> None:
    assert to_provider_symbol(canonical) == provider_symbol


def eod(http_factory: Callable[[str], Any], limit: int = 20) -> EodhdProvider:
    return EodhdProvider(
        KEY,
        http=http_factory("eodhd"),
        quota=DailyQuota(limit, "eodhd"),
        bucket=free_bucket(),
        now=lambda: NOW,
    )


def test_eodhd_realtime_batch(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "/real-time/ASML.AS",
        [
            [
                {"code": "ASML.AS", "timestamp": 1792000000, "close": 701.2, "previousClose": 690},
                {"code": "SAP.XETRA", "timestamp": "NA", "close": "NA", "previousClose": "NA"},
                "garbage",
            ]
        ],
    )
    quotes = eod(http_factory).get_quotes(["ASML.AS", "SAP.DE"])
    url = opener.urls[0]
    assert "s=SAP.XETRA" in url and f"api_token={KEY}" in url and "fmt=json" in url
    assert list(quotes) == ["ASML.AS"]
    q = quotes["ASML.AS"]
    assert (q.price, q.previousClose, q.currency, q.source) == (701.2, 690.0, "EUR", "eodhd")


def test_eodhd_single_and_not_found(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add("/real-time/SAP.XETRA", {"code": "SAP.XETRA", "close": 230, "previousClose": None})
    opener.add("/real-time/NOPE.AS", 404)
    p = eod(http_factory)
    q = p.get_quotes(["SAP.DE"])["SAP.DE"]
    assert q.previousClose == 230 and q.asOf == "2026-10-13T12:00:00.000Z"
    assert p.get_quotes(["NOPE.AS"]) == {}


def test_eodhd_quota_and_402(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    with pytest.raises(RateLimitError):
        eod(http_factory, limit=1).get_quotes(["ASML.AS", "SAP.DE"])
    opener.add("/eod/", 402)
    with pytest.raises(RateLimitError):
        eod(http_factory).get_eod_history("ASML.AS", date(2026, 1, 1), date(2026, 2, 1))


def test_eodhd_eod_and_dividends(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "/eod/SAP.XETRA",
        [[{"date": "2026-10-09", "close": 231.5}, {"date": "2026-10-08", "close": 230}, "x"]],
    )
    opener.add(
        "/div/AAPL.US",
        [
            [
                {"date": "2026-08-11", "paymentDate": "2026-08-14", "value": 0.26, "currency": "USD"},
                {"date": "2027-11-10", "value": 0.27},
                {"date": "2026-11-10", "value": 0.27, "paymentDate": ""},
            ]
        ],
    )
    opener.add("/div/NOPE.US", 404)
    p = eod(http_factory)
    rows = p.get_eod_history("SAP.DE", date(2026, 1, 1), date(2026, 10, 13))
    assert [(r.date, r.close, r.currency) for r in rows] == [
        ("2026-10-08", 230.0, "EUR"),
        ("2026-10-09", 231.5, "EUR"),
    ]
    assert "from=2026-01-01" in opener.urls[0] and "to=2026-10-13" in opener.urls[0]
    divs = p.get_dividends("AAPL", date(2024, 10, 13), date(2027, 10, 13))
    assert [(d.exDate, d.payDate, d.amount, d.currency) for d in divs] == [
        ("2026-08-11", "2026-08-14", 0.26, "USD"),
        ("2026-11-10", None, 0.27, "USD"),
    ]
    assert p.get_dividends("NOPE", date(2024, 1, 1), date(2027, 1, 1)) == []


def test_eodhd_profile_search(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "/search/ASML",
        [
            [
                {"Code": "ASML", "Exchange": "US", "Name": "ASML ADR", "Type": "Common Stock"},
                {
                    "Code": "ASML",
                    "Exchange": "AS",
                    "Name": "ASML Holding NV",
                    "Type": "Common Stock",
                    "Country": "Netherlands",
                    "Currency": "EUR",
                },
            ],
            [],
        ],
    )
    p = eod(http_factory)
    profile = p.get_profile("ASML.AS")
    assert (profile.name, profile.assetClass, profile.exchange, profile.country) == (
        "ASML Holding NV",
        "STOCK",
        "Euronext Amsterdam",
        "Netherlands",
    )
    assert "exchange=AS" in opener.urls[0]
    assert p.get_profile("ASML.AS") is None


# --------------------------------------------------------------------------- CoinGecko


def cg(http_factory: Callable[[str], Any]) -> CoinGeckoProvider:
    return CoinGeckoProvider(KEY, http=http_factory("coingecko"), bucket=free_bucket(), now=lambda: NOW)


def test_coingecko_quotes(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "/simple/price",
        {
            "bitcoin": {"eur": 60600.0, "eur_24h_change": 1.0, "last_updated_at": 1792000000},
            "ethereum": {"usd": 3000},
        },
    )
    quotes = cg(http_factory).get_quotes(["BTC-EUR", "ETH-USD", "WAT-EUR"])
    req = opener.requests[0]
    assert req.get_header("X-cg-demo-api-key") == KEY and KEY not in req.full_url
    assert "ids=bitcoin,ethereum" in req.full_url and "vs_currencies=eur,usd" in req.full_url
    assert quotes["BTC-EUR"].previousClose == pytest.approx(60000.0)
    assert quotes["BTC-EUR"].currency == "EUR"
    assert quotes["ETH-USD"].previousClose == 3000 and quotes["ETH-USD"].asOf == "2026-10-13T12:00:00.000Z"
    assert "WAT-EUR" not in quotes


def test_coingecko_unknown_only(http_factory: Callable[[str], Any]) -> None:
    assert cg(http_factory).get_quotes(["WAT-EUR"]) == {}


def test_coingecko_history_and_profile(
    opener: FakeOpener, http_factory: Callable[[str], Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    day = 86_400_000
    base = int(datetime(2026, 10, 11, tzinfo=UTC).timestamp() * 1000)
    opener.add(
        "/coins/bitcoin/market_chart",
        {
            "prices": [
                [base, 1.0],
                [base + day, 2.0],
                [base + 2 * day, 3.0],
                [base + 2 * day + 3600_000, 3.5],
                ["bad"],
            ]
        },
    )
    p = cg(http_factory)
    rows = p.get_eod_history("BTC-EUR", date(2025, 10, 13), date(2026, 10, 13))
    assert [(r.date, r.close) for r in rows] == [
        ("2026-10-11", 1.0),
        ("2026-10-12", 2.0),
        ("2026-10-13", 3.5),
    ]
    assert (
        "vs_currency=eur" in opener.urls[0]
        and "days=365" in opener.urls[0]
        and "interval=daily" in opener.urls[0]
    )
    assert p.get_profile("BTC-EUR").name == "Bitcoin"
    assert p.get_dividends("BTC-EUR", date(2020, 1, 1), date(2030, 1, 1)) == []
    with pytest.raises(SymbolNotFoundError):
        p.get_eod_history("WAT-EUR", date(2026, 1, 1), date(2026, 2, 1))
    monkeypatch.setenv("COINGECKO_COIN_IDS", "WAT=wat-coin, bad")
    assert cg(http_factory).get_profile("WAT-EUR").name == "Wat Coin"


# --------------------------------------------------------------------------- Alpha Vantage


def av(http_factory: Callable[[str], Any]) -> AlphaVantageProvider:
    return AlphaVantageProvider(KEY, http=http_factory("alphavantage"), bucket=free_bucket())


def test_alphavantage_overview(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "OVERVIEW",
        [
            {
                "Symbol": "AAPL",
                "AssetType": "Common Stock",
                "Name": "Apple Inc",
                "Exchange": "NASDAQ",
                "Currency": "USD",
                "Country": "USA",
                "Sector": "TECHNOLOGY",
            },
            {},
            {"Information": "rate limit is 25 requests per day"},
        ],
    )
    p = av(http_factory)
    profile = p.get_profile("AAPL")
    assert (profile.name, profile.sector, profile.country, profile.assetClass) == (
        "Apple Inc",
        "Technology",
        "United States",
        "STOCK",
    )
    assert p.get_profile("SPY") is None
    with pytest.raises(RateLimitError):
        p.get_profile("MSFT")
    for call in (
        lambda: p.get_quotes(["AAPL"]),
        lambda: p.get_eod_history("AAPL", NOW.date(), NOW.date()),
        lambda: p.get_dividends("AAPL", NOW.date(), NOW.date()),
    ):
        with pytest.raises(ProviderError):
            call()


# --------------------------------------------------------------------------- Frankfurter


def test_frankfurter(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add(
        "frankfurter",
        [
            {"base": "EUR", "date": "2026-10-13", "rates": {"USD": 1.0841, "JPY": 162, "BAD": "x"}},
            {"base": "EUR", "rates": {}},
        ],
    )
    fx = FrankfurterFx(http=http_factory("frankfurter")).get_latest("EUR")
    assert fx.base == "EUR" and fx.rates == {"USD": 1.0841, "JPY": 162.0}
    assert fx.asOf == "2026-10-13T14:00:00.000Z"  # 16:00 CEST
    assert opener.urls[0] == "https://api.frankfurter.dev/v1/latest?base=EUR"
    with pytest.raises(ProviderError):
        FrankfurterFx(http=http_factory("frankfurter")).get_latest("EUR")
