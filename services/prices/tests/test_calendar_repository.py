from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError

from prices import aws
from prices.calendar_models import EarningsEvent, SplitEvent
from prices.calendar_repository import CalendarRepository
from tests.conftest import TABLE, Infra

STAMP = "2026-10-15T05:30:00.000Z"


def repo() -> CalendarRepository:
    return CalendarRepository(TABLE)


def earnings(symbol: str, date: str, **kw: Any) -> EarningsEvent:
    return EarningsEvent(symbol=symbol, date=date, source="alphavantage", **kw)


def client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "x"}}, "UpdateItem")


def test_put_earnings_and_splits_are_idempotent(infra: Infra) -> None:
    r = repo()
    events = [
        earnings("AAPL", "2026-10-29", eps_estimate=1.85, time_of_day="AMC"),
        earnings("MSFT", "2026-10-28"),
    ]
    assert r.put_earnings(events, STAMP) == 2
    assert r.put_splits([SplitEvent("NVDA", "2026-11-02", 1, 10, "eodhd")], STAMP) == 1
    first = infra.items()
    assert r.put_earnings(events, STAMP) == 2
    assert r.put_splits([SplitEvent("NVDA", "2026-11-02", 1, 10, "eodhd")], STAMP) == 1
    assert infra.items() == first
    assert [(i["PK"], i["SK"]) for i in first] == [
        ("TICKER#AAPL", "EARN#2026-10-29"),
        ("TICKER#MSFT", "EARN#2026-10-28"),
        ("TICKER#NVDA", "SPLIT#2026-11-02"),
    ]
    assert infra.get("TICKER#AAPL", "EARN#2026-10-29")["timeOfDay"] == "AMC"  # type: ignore[index]


def test_stale_earnings_dates_only_lists_upcoming_dates_that_are_not_kept(infra: Infra) -> None:
    r = repo()
    r.put_earnings(
        [earnings("AAPL", d) for d in ("2026-07-30", "2026-10-15", "2026-10-29", "2026-11-05", "2027-01-27")],
        STAMP,
    )
    r.put_earnings([earnings("MSFT", "2026-11-20")], STAMP)
    assert r.stale_earnings_dates("AAPL", "2026-10-15", {"2026-10-29"}) == [
        "2026-10-15",
        "2026-11-05",
        "2027-01-27",
    ]
    assert r.stale_earnings_dates("AAPL", "2026-10-16", set()) == ["2026-10-29", "2026-11-05", "2027-01-27"]
    assert r.stale_earnings_dates("NOPE", "2026-10-15", set()) == []


def test_delete_earnings(infra: Infra) -> None:
    r = repo()
    r.put_earnings([earnings("AAPL", "2026-11-05"), earnings("AAPL", "2026-10-29")], STAMP)
    assert r.delete_earnings("AAPL", ["2026-11-05", "2026-12-31"]) == 2
    assert [i["SK"] for i in infra.items("TICKER#AAPL")] == ["EARN#2026-10-29"]
    assert r.delete_earnings("AAPL", []) == 0


def test_state_markers_are_merged_per_symbol(infra: Infra) -> None:
    r = repo()
    assert r.get_states(["AAPL", "MSFT"]) == {}
    r.put_state("AAPL", splitsCheckedAt=STAMP)
    r.put_state("AAPL", dividendsCheckedAt="later", splitsFailedAt="failed")
    r.put_state("MSFT", splitsCheckedAt="other")
    states = r.get_states(["AAPL", "MSFT", "KO"])
    assert set(states) == {"AAPL", "MSFT"}
    assert states["AAPL"] == {
        "PK": "TICKER#AAPL",
        "SK": "CAL#STATE",
        "entityType": "CALENDAR_STATE",
        "symbol": "AAPL",
        "splitsCheckedAt": STAMP,
        "dividendsCheckedAt": "later",
        "splitsFailedAt": "failed",
    }


def test_get_states_handles_more_than_one_batch(infra: Infra) -> None:
    r = repo()
    symbols = [f"S{i:03d}" for i in range(130)]
    for s in symbols[::13]:
        r.put_state(s, splitsCheckedAt=STAMP)
    assert set(r.get_states(symbols)) == set(symbols[::13])


def test_get_states_retries_unprocessed_keys(infra: Infra, monkeypatch: pytest.MonkeyPatch) -> None:
    r = repo()
    r.put_state("AAPL", splitsCheckedAt=STAMP)
    resource = aws.dynamodb()
    real = resource.batch_get_item
    calls: list[int] = []

    def flaky(**kwargs: Any) -> dict[str, Any]:
        calls.append(1)
        if len(calls) == 1:
            return {"Responses": {}, "UnprocessedKeys": kwargs["RequestItems"]}
        return real(**kwargs)

    monkeypatch.setattr(resource, "batch_get_item", flaky)
    monkeypatch.setattr("prices.calendar_repository.time.sleep", lambda _s: None)
    assert set(r.get_states(["AAPL"])) == {"AAPL"}
    assert len(calls) == 2


def test_get_states_gives_up_after_repeated_unprocessed_keys(
    infra: Infra, monkeypatch: pytest.MonkeyPatch
) -> None:
    resource = aws.dynamodb()
    calls: list[int] = []

    def always(**kwargs: Any) -> dict[str, Any]:
        calls.append(1)
        return {"Responses": {}, "UnprocessedKeys": kwargs["RequestItems"]}

    monkeypatch.setattr(resource, "batch_get_item", always)
    monkeypatch.setattr("prices.calendar_repository.time.sleep", lambda _s: None)
    assert repo().get_states(["AAPL"]) == {}
    assert len(calls) == 5


def test_budget_is_spent_atomically_per_day(infra: Infra) -> None:
    r = repo()
    assert r.consume_budget("eodhd", "2026-10-15", 2, 5) is True
    assert r.consume_budget("eodhd", "2026-10-15", 2, 5) is True
    assert r.consume_budget("eodhd", "2026-10-15", 2, 5) is False  # 4 + 2 > 5
    assert r.consume_budget("eodhd", "2026-10-15", 1, 5) is True  # exactly at the limit
    assert r.consume_budget("eodhd", "2026-10-15", 1, 5) is False
    item = infra.get("CALENDAR", "BUDGET#eodhd")
    assert item is not None
    assert (item["day"], int(item["used"]), item["entityType"]) == ("2026-10-15", 5, "CALENDAR_BUDGET")
    # A new day resets the counter; other providers have their own.
    assert r.consume_budget("eodhd", "2026-10-16", 5, 5) is True
    assert int(infra.get("CALENDAR", "BUDGET#eodhd")["used"]) == 5  # type: ignore[index]
    assert r.consume_budget("alphavantage", "2026-10-16", 1, 1) is True
    assert r.consume_budget("alphavantage", "2026-10-16", 1, 1) is False


def test_budget_edge_cases(infra: Infra) -> None:
    r = repo()
    assert r.consume_budget("eodhd", "2026-10-15", 0, 0) is True
    assert r.consume_budget("eodhd", "2026-10-15", 3, 2) is False
    assert infra.get("CALENDAR", "BUDGET#eodhd") is None


@pytest.mark.parametrize("failing_call", [1, 2])
def test_budget_propagates_unexpected_storage_errors(
    infra: Infra, monkeypatch: pytest.MonkeyPatch, failing_call: int
) -> None:
    r = repo()
    real = r.table.update_item
    calls: list[int] = []

    def fail(**kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) == 1 and failing_call == 2:
            raise client_error("ConditionalCheckFailedException")
        raise client_error("ProvisionedThroughputExceededException")

    monkeypatch.setattr(r.table, "update_item", fail)
    with pytest.raises(ClientError):
        r.consume_budget("eodhd", "2026-10-15", 1, 5)
    assert len(calls) == failing_call
    monkeypatch.setattr(r.table, "update_item", real)
