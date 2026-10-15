from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

import pytest

from prices import calendar_providers as cp
from prices import secrets
from prices.calendar_config import CalendarSettings
from prices.calendar_models import EarningsEvent, SplitEvent
from prices.errors import ProviderError, RateLimitError
from prices.httpclient import HttpClient, TokenBucket
from prices.providers.eodhd import EodhdProvider
from prices.providers.mock import MockProvider
from tests.conftest import FakeOpener, FakeResponse

KEY = "k3y-should-never-leak"
TODAY = date(2026, 10, 15)
NOW = datetime(2026, 10, 15, 5, 30, tzinfo=UTC)

CSV = """symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
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


class TextOpener(FakeOpener):
    """FakeOpener whose responses are served verbatim when they are str/bytes (CSV bodies)."""

    @staticmethod
    def _emit(request: Any, response: Any) -> FakeResponse:
        if isinstance(response, str):
            return FakeResponse(response.encode())
        if isinstance(response, bytes):
            return FakeResponse(response)
        return FakeOpener._emit(request, response)


@pytest.fixture
def text_opener() -> TextOpener:
    return TextOpener()


def text_client(opener: TextOpener, sleeps: list[float]) -> cp.TextHttpClient:
    return cp.TextHttpClient("alphavantage", opener=opener, sleep=sleeps.append, max_retries=2)


def free_bucket() -> TokenBucket:
    return TokenBucket(100, 100, sleep=lambda _s: pytest.fail("unexpected throttle"))


# --------------------------------------------------------------------------- symbols


def test_av_symbol_maps_us_tickers_only() -> None:
    assert cp.av_symbol("AAPL") == "AAPL"
    assert cp.av_symbol("BRK-B") == "BRK.B"
    assert cp.av_symbol("ASML.AS") is None
    assert cp.av_symbol("SAP.DE") is None
    assert cp.av_symbol("BTC-EUR") is None


# --------------------------------------------------------------------------- earnings CSV


def test_parse_earnings_csv_maps_rows_and_tolerates_bad_ones() -> None:
    events = cp.parse_earnings_csv(CSV, MAPPING)
    assert [(e.symbol, e.date) for e in events] == [
        ("AAPL", "2026-10-29"),
        ("BRK-B", "2026-11-01"),
        ("KO", "2026-10-21"),
        ("MSFT", "2026-10-28"),
    ]
    by_symbol = {e.symbol: e for e in events}
    assert by_symbol["AAPL"] == EarningsEvent(
        symbol="AAPL",
        date="2026-10-29",
        name="APPLE INC",
        fiscal_period_end="2026-09-30",
        eps_estimate=1.9,  # the later duplicate row wins
        currency="USD",
        time_of_day="AMC",
        source="alphavantage",
    )
    assert by_symbol["MSFT"].time_of_day == "BMO"
    assert by_symbol["MSFT"].eps_estimate is None  # empty estimate
    assert by_symbol["BRK-B"].eps_estimate is None  # "None"
    assert by_symbol["BRK-B"].currency == "USD"
    assert by_symbol["BRK-B"].time_of_day == "unknown"
    assert by_symbol["KO"].eps_estimate is None  # malformed
    assert by_symbol["KO"].currency is None  # not an ISO code
    assert by_symbol["KO"].time_of_day == "unknown"
    assert "NVDA" not in by_symbol  # invalid date
    assert "TSLA" not in by_symbol  # not tracked


def test_parse_earnings_csv_ignores_bom_and_blank_values() -> None:
    text = (
        "\ufeffsymbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nAAPL,,2026-10-29,,,,\n"
    )
    [event] = cp.parse_earnings_csv(text, {"AAPL": "AAPL"})
    assert (event.name, event.fiscal_period_end, event.eps_estimate, event.currency) == (
        None,
        None,
        None,
        None,
    )


def test_parse_earnings_csv_header_only_is_empty() -> None:
    assert cp.parse_earnings_csv("symbol,name,reportDate\n", MAPPING) == []


@pytest.mark.parametrize(
    ("body", "error"),
    [
        ('{"Information": "Thank you! Our standard API rate limit is 25 requests per day."}', RateLimitError),
        (
            '{"Note": "Our standard API call frequency is 5 calls per minute."}',
            RateLimitError,
        ),
        ('{"Error Message": "Invalid API call."}', ProviderError),
        ("{}", ProviderError),
        ("[]", ProviderError),
        ("{not json", ProviderError),
        ("", ProviderError),
        ("<html>nope</html>", ProviderError),
        ("a,b\n1,2\n", ProviderError),
    ],
)
def test_parse_earnings_csv_rejects_non_csv_bodies(body: str, error: type[Exception]) -> None:
    with pytest.raises(error) as info:
        cp.parse_earnings_csv(body, MAPPING)
    assert type(info.value) is error


def test_alphavantage_earnings_makes_one_call_for_all_symbols(
    text_opener: TextOpener, sleeps: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    text_opener.add("function=EARNINGS_CALENDAR", CSV)
    source = cp.AlphaVantageEarnings(
        KEY, horizon="6month", http=text_client(text_opener, sleeps), bucket=free_bucket()
    )
    events = source.fetch(["AAPL", "MSFT", "BRK-B", "ASML.AS", "BTC-EUR"], TODAY)
    assert {e.symbol for e in events} == {"AAPL", "MSFT", "BRK-B"}
    assert len(text_opener.requests) == 1
    url = text_opener.urls[0]
    assert "horizon=6month" in url
    assert f"apikey={KEY}" in url  # sent, but never logged:
    assert KEY not in caplog.text
    assert text_opener.requests[0].get_header("Accept") == "text/csv, */*"
    assert source.name == "alphavantage"
    assert source.budgeted is True


def test_alphavantage_earnings_skips_the_call_without_us_symbols(
    text_opener: TextOpener, sleeps: list[float]
) -> None:
    source = cp.AlphaVantageEarnings(KEY, http=text_client(text_opener, sleeps), bucket=free_bucket())
    assert source.fetch(["ASML.AS", "BTC-EUR"], TODAY) == []
    assert text_opener.requests == []


def test_alphavantage_earnings_drops_dates_in_the_past(text_opener: TextOpener, sleeps: list[float]) -> None:
    text_opener.add("EARNINGS_CALENDAR", CSV)
    source = cp.AlphaVantageEarnings(KEY, http=text_client(text_opener, sleeps), bucket=free_bucket())
    events = source.fetch(["AAPL", "MSFT"], date(2026, 10, 29))
    assert [e.symbol for e in events] == ["AAPL"]


def test_alphavantage_earnings_reports_http_failures(text_opener: TextOpener, sleeps: list[float]) -> None:
    text_opener.add("EARNINGS_CALENDAR", [429, 429, 429])
    source = cp.AlphaVantageEarnings(KEY, http=text_client(text_opener, sleeps), bucket=free_bucket())
    with pytest.raises(RateLimitError) as info:
        source.fetch(["AAPL"], TODAY)
    assert KEY not in str(info.value)
    assert len(sleeps) == 2


def test_alphavantage_earnings_defaults() -> None:
    source = cp.AlphaVantageEarnings(KEY)
    assert isinstance(source._http, cp.TextHttpClient)


def test_text_client_returns_text_even_for_empty_bodies(text_opener: TextOpener, sleeps: list[float]) -> None:
    text_opener.add("/empty", b"")
    assert text_client(text_opener, sleeps).get_text("https://example.test/empty") == ""


# --------------------------------------------------------------------------- splits


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("4.000000/1.000000", (1.0, 4.0)),
        ("1.000000/10.000000", (10.0, 1.0)),
        ("3/2", (2.0, 3.0)),
        ("104.000000/100.000000", (100.0, 104.0)),
        ("1281/1000", (1000.0, 1281.0)),
        ("4", None),
        ("4/1/2", None),
        ("a/b", None),
        ("0/1", None),
        ("1/0", None),
        ("-2/1", None),
        ("nan/1", None),
        ("inf/1", None),
        (None, None),
        (2, None),
    ],
)
def test_parse_split_ratio(raw: Any, expected: tuple[float, float] | None) -> None:
    assert cp.parse_split_ratio(raw) == expected


def test_parse_splits_keeps_valid_rows_from_the_start_date() -> None:
    data = [
        {"date": "2024-06-10", "split": "10.000000/1.000000"},
        {"date": "2026-09-01", "split": "104/100"},
        {"date": "2026-10-20", "split": "1.000000/8.000000"},
        {"date": "2026-10-20", "split": "1/9"},  # same day: last wins
        {"date": "garbage", "split": "2/1"},
        {"date": "2026-11-01", "split": "oops"},
        {"date": "2026-11-02"},
        "row",
        None,
    ]
    assert cp.parse_splits(data, "NVDA", date(2026, 7, 1)) == [
        SplitEvent("NVDA", "2026-09-01", 100.0, 104.0, "eodhd"),
        SplitEvent("NVDA", "2026-10-20", 9.0, 1.0, "eodhd"),
    ]
    assert cp.parse_splits({"error": "x"}, "NVDA", date(2026, 7, 1)) == []
    assert cp.parse_splits(None, "NVDA", date(2026, 7, 1)) == []


def eodhd_actions(opener: FakeOpener, http_factory: Callable[[str], Any]) -> cp.EodhdCorporateActions:
    http = http_factory("eodhd")
    dividends = EodhdProvider(KEY, http=http, bucket=free_bucket())
    return cp.EodhdCorporateActions(KEY, http=http, dividends=dividends, bucket=free_bucket())


def test_eodhd_splits_use_the_provider_symbol_and_start_date(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("/splits/AAPL.US", [[{"date": "2026-11-02", "split": "4.000000/1.000000"}]])
    opener.add("/splits/SAP.XETRA", [[]])
    actions = eodhd_actions(opener, http_factory)
    assert actions.get_splits("AAPL", date(2026, 7, 17)) == [
        SplitEvent("AAPL", "2026-11-02", 1.0, 4.0, "eodhd")
    ]
    assert actions.get_splits("SAP.DE", date(2026, 7, 17)) == []
    assert "from=2026-07-17" in opener.urls[0]
    assert "fmt=json" in opener.urls[0]
    assert actions.name == "eodhd"
    assert actions.budgeted is True


def test_eodhd_splits_of_an_unknown_symbol_are_empty(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("/splits/", 404)
    assert eodhd_actions(opener, http_factory).get_splits("ZZZZ", date(2026, 7, 17)) == []


def test_eodhd_splits_map_402_to_a_rate_limit(opener: FakeOpener, http_factory: Callable[[str], Any]) -> None:
    opener.add("/splits/", 402)
    with pytest.raises(RateLimitError) as info:
        eodhd_actions(opener, http_factory).get_splits("AAPL", date(2026, 7, 17))
    assert KEY not in str(info.value)


def test_eodhd_splits_propagate_other_failures(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add("/splits/", 403)
    with pytest.raises(ProviderError) as info:
        eodhd_actions(opener, http_factory).get_splits("AAPL", date(2026, 7, 17))
    assert info.value.status == 403


def test_eodhd_dividends_go_through_the_existing_adapter(
    opener: FakeOpener, http_factory: Callable[[str], Any]
) -> None:
    opener.add(
        "/div/AAPL.US",
        [[{"date": "2026-11-09", "paymentDate": "2026-11-12", "value": 0.26, "currency": "USD"}]],
    )
    [event] = eodhd_actions(opener, http_factory).get_dividends("AAPL", date(2025, 1, 1), date(2027, 1, 1))
    assert (event.ex_date, event.pay_date, event.amount) == ("2026-11-09", "2026-11-12", 0.26)


def test_eodhd_actions_build_their_defaults() -> None:
    actions = cp.EodhdCorporateActions(KEY)
    assert isinstance(actions._http, HttpClient)


# --------------------------------------------------------------------------- mock


def test_mock_source_is_deterministic_and_only_covers_us_listings() -> None:
    source = cp.MockCalendarSource(now=lambda: NOW)
    symbols = ["AAPL", "NVDA", "ZZZ", "ASML.AS", "BTC-EUR"]
    first = source.fetch(symbols, TODAY)
    assert first == cp.MockCalendarSource(now=lambda: NOW).fetch(list(reversed(symbols)), TODAY)
    assert [e.symbol for e in first] == ["AAPL", "NVDA", "ZZZ"]
    for e in first:
        report = date.fromisoformat(e.date)
        assert 5 <= (report - TODAY).days <= 62
        assert report.weekday() < 5
        assert e.source == "mock"
        assert e.time_of_day in ("BMO", "AMC")
        assert e.currency == "USD"
        assert e.fiscal_period_end is not None
        assert e.eps_estimate is not None
        assert date.fromisoformat(e.fiscal_period_end) < report
    assert source.name == "mock"
    assert source.budgeted is False


def test_mock_source_has_one_upcoming_split_for_known_symbols() -> None:
    source = cp.MockCalendarSource(now=lambda: NOW)
    [nvda] = source.get_splits("NVDA", date(2026, 7, 1))
    assert (nvda.from_factor, nvda.to_factor, nvda.source) == (1, 10, "mock")
    assert date(2026, 11, 1) <= date.fromisoformat(nvda.date) <= date(2026, 11, 12)
    assert date.fromisoformat(nvda.date).weekday() < 5
    assert source.get_splits("MSFT", date(2026, 7, 1)) == []
    assert source.get_splits("NVDA", date(2027, 1, 1)) == []  # the split lies before the start date


def test_mock_source_dividends_match_the_mock_market() -> None:
    source = cp.MockCalendarSource(now=lambda: NOW)
    start, end = date(2025, 10, 15), date(2027, 10, 15)
    assert source.get_dividends("AAPL", start, end) == MockProvider(now=lambda: NOW).get_dividends(
        "AAPL", start, end
    )
    assert cp.MockCalendarSource().name == "mock"


# --------------------------------------------------------------------------- factory


def test_build_calendar_sources_mock() -> None:
    earnings, actions = cp.build_calendar_sources("mock", CalendarSettings())
    assert isinstance(earnings, cp.MockCalendarSource)
    assert actions is earnings


@pytest.mark.parametrize("kind", ["live", "routing"])
def test_build_calendar_sources_live_with_keys(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALPHAVANTAGE_API_KEY", "av")
    monkeypatch.setenv("EODHD_API_KEY", "eod")
    earnings, actions = cp.build_calendar_sources(kind, CalendarSettings(earnings_horizon="3month"))
    assert isinstance(earnings, cp.AlphaVantageEarnings)
    assert earnings._horizon == "3month"
    assert isinstance(actions, cp.EodhdCorporateActions)


def test_build_calendar_sources_without_keys_disables_the_parts() -> None:
    secrets.clear_cache()
    assert cp.build_calendar_sources("live", CalendarSettings()) == (None, None)


def test_build_calendar_sources_rejects_unknown_kinds() -> None:
    with pytest.raises(ValueError, match="MARKET_DATA_PROVIDER"):
        cp.build_calendar_sources("quantum", CalendarSettings())
