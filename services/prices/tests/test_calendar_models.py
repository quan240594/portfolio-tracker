from __future__ import annotations

from decimal import Decimal

import pytest

from prices import calendar_models as cm
from prices.calendar_config import CalendarSettings

UPDATED = "2026-10-15T05:30:00.000Z"


def test_keys_follow_the_single_table_layout() -> None:
    assert cm.earnings_key("AAPL", "2026-10-29") == {"PK": "TICKER#AAPL", "SK": "EARN#2026-10-29"}
    assert cm.split_key("NVDA", "2026-11-02") == {"PK": "TICKER#NVDA", "SK": "SPLIT#2026-11-02"}
    assert cm.state_key("AAPL") == {"PK": "TICKER#AAPL", "SK": "CAL#STATE"}
    assert cm.budget_key("eodhd") == {"PK": "CALENDAR", "SK": "BUDGET#eodhd"}


def test_earnings_item_shape() -> None:
    event = cm.EarningsEvent(
        symbol="AAPL",
        date="2026-10-29",
        name="APPLE INC",
        fiscal_period_end="2026-09-30",
        eps_estimate=1.85,
        currency="USD",
        time_of_day="AMC",
        source="alphavantage",
    )
    assert cm.earnings_item(event, UPDATED) == {
        "PK": "TICKER#AAPL",
        "SK": "EARN#2026-10-29",
        "entityType": "EARNINGS_EVENT",
        "symbol": "AAPL",
        "date": "2026-10-29",
        "name": "APPLE INC",
        "fiscalPeriodEnd": "2026-09-30",
        "epsEstimate": Decimal("1.85"),
        "currency": "USD",
        "timeOfDay": "AMC",
        "source": "alphavantage",
        "updatedAt": UPDATED,
    }


def test_earnings_item_omits_unknown_optional_fields() -> None:
    item = cm.earnings_item(cm.EarningsEvent(symbol="KO", date="2026-10-21", source="alphavantage"), UPDATED)
    assert set(item) == {"PK", "SK", "entityType", "symbol", "date", "timeOfDay", "source", "updatedAt"}
    assert item["timeOfDay"] == "unknown"


def test_earnings_event_rejects_an_unknown_time_of_day() -> None:
    with pytest.raises(ValueError, match="timeOfDay"):
        cm.EarningsEvent(symbol="KO", date="2026-10-21", time_of_day="lunch")


def test_split_item_shape() -> None:
    item = cm.split_item(cm.SplitEvent("NVDA", "2026-11-02", 1.0, 10.0, "eodhd"), UPDATED)
    assert item == {
        "PK": "TICKER#NVDA",
        "SK": "SPLIT#2026-11-02",
        "entityType": "SPLIT_EVENT",
        "symbol": "NVDA",
        "date": "2026-11-02",
        "fromFactor": Decimal("1.0"),
        "toFactor": Decimal("10.0"),
        "source": "eodhd",
        "updatedAt": UPDATED,
    }
    assert isinstance(item["fromFactor"], Decimal)


def test_settings_defaults_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "CALENDAR_EARNINGS_HORIZON",
        "CALENDAR_ALPHAVANTAGE_DAILY_CALLS",
        "CALENDAR_EODHD_DAILY_CALLS",
        "CALENDAR_RECHECK_DAYS",
        "CALENDAR_REFRESH_DIVIDENDS",
        "CALENDAR_SPLIT_LOOKBACK_DAYS",
    ):
        monkeypatch.delenv(name, raising=False)
    assert CalendarSettings.from_env() == CalendarSettings()
    assert CalendarSettings() == CalendarSettings(
        earnings_horizon="12month",
        alphavantage_daily_calls=1,
        eodhd_daily_calls=8,
        recheck_days=7,
        refresh_dividends=True,
        split_lookback_days=90,
    )
    monkeypatch.setenv("CALENDAR_EARNINGS_HORIZON", " 6MONTH ")
    monkeypatch.setenv("CALENDAR_ALPHAVANTAGE_DAILY_CALLS", "2")
    monkeypatch.setenv("CALENDAR_EODHD_DAILY_CALLS", "0")
    monkeypatch.setenv("CALENDAR_RECHECK_DAYS", "0")
    monkeypatch.setenv("CALENDAR_REFRESH_DIVIDENDS", "no")
    monkeypatch.setenv("CALENDAR_SPLIT_LOOKBACK_DAYS", "30")
    assert CalendarSettings.from_env() == CalendarSettings(
        earnings_horizon="6month",
        alphavantage_daily_calls=2,
        eodhd_daily_calls=0,
        recheck_days=1,  # at least one day
        refresh_dividends=False,
        split_lookback_days=30,
    )


def test_settings_ignore_invalid_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CALENDAR_EARNINGS_HORIZON", "forever")
    monkeypatch.setenv("CALENDAR_EODHD_DAILY_CALLS", "lots")
    monkeypatch.setenv("CALENDAR_REFRESH_DIVIDENDS", "TRUE")
    settings = CalendarSettings.from_env()
    assert settings.earnings_horizon == "12month"
    assert settings.eodhd_daily_calls == 8
    assert settings.refresh_dividends is True
