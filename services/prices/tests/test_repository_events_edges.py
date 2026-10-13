"""Edge cases for the DynamoDB repository and EventBridge publisher (pagination, retries, failures)."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from prices import aws, events, repository
from prices.events import EventPublisher


class FakeTable:
    def __init__(self, pages: list[dict[str, Any]] | None = None, put_error: str | None = None) -> None:
        self.pages = pages or []
        self.queries: list[dict[str, Any]] = []
        self.put_error = put_error

    def query(self, **kwargs: Any) -> dict[str, Any]:
        self.queries.append(kwargs)
        return self.pages[len(self.queries) - 1]

    def put_item(self, **kwargs: Any) -> None:
        if self.put_error:
            raise ClientError({"Error": {"Code": self.put_error, "Message": "x"}}, "PutItem")


class FakeDynamo:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    def batch_get_item(self, RequestItems: dict[str, Any]) -> dict[str, Any]:  # noqa: N803 - boto3 kwarg
        self.calls.append(RequestItems)
        return self.responses[len(self.calls) - 1]


def _cached(fn: Any) -> Any:
    """Mimic functools.cache so conftest's aws.reset() teardown still works on the patched helpers."""
    fn.cache_clear = lambda: None
    return fn


def make_repo(monkeypatch: pytest.MonkeyPatch, table: FakeTable, dynamo: FakeDynamo | None = None) -> Any:
    monkeypatch.setattr(aws, "table", lambda name: table)
    if dynamo is not None:
        monkeypatch.setattr(aws, "dynamodb", _cached(lambda: dynamo))
    monkeypatch.setattr(repository.time, "sleep", lambda s: None)
    return repository.Repository("t")


def test_list_tracked_paginates_falls_back_to_sk_and_skips_blank(monkeypatch: pytest.MonkeyPatch) -> None:
    table = FakeTable(
        [
            {
                "Items": [{"SK": "TICKER#MSFT"}, {"symbol": "AAPL", "SK": "TICKER#AAPL"}],
                "LastEvaluatedKey": {"k": 1},
            },
            {"Items": [{"SK": "OTHER#X"}, {"SK": "TICKER#MSFT"}]},
        ]
    )
    repo = make_repo(monkeypatch, table)
    assert repo.list_tracked() == ["AAPL", "MSFT"]
    assert table.queries[1]["ExclusiveStartKey"] == {"k": 1}


def test_batch_get_retries_unprocessed_keys_and_skips_corrupt_quotes(monkeypatch: pytest.MonkeyPatch) -> None:
    good = {
        "symbol": "AAPL",
        "price": Decimal("1"),
        "previousClose": Decimal("1"),
        "currency": "USD",
        "asOf": "t",
        "source": "s",
    }
    dynamo = FakeDynamo(
        [
            {"Responses": {"t": [{"symbol": "BAD"}]}, "UnprocessedKeys": {"t": {"Keys": [{"PK": "x"}]}}},
            {"Responses": {"t": [good]}},
        ]
    )
    repo = make_repo(monkeypatch, FakeTable(), dynamo)
    quotes = repo.latest_quotes(["AAPL", "BAD"])
    assert list(quotes) == ["AAPL"]
    assert len(dynamo.calls) == 2 and dynamo.calls[1] == {"t": {"Keys": [{"PK": "x"}]}}


def test_ensure_tracked_reraises_unexpected_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = make_repo(monkeypatch, FakeTable(put_error="ProvisionedThroughputExceededException"))
    with pytest.raises(ClientError):
        repo.ensure_tracked("AAPL", "t")
    repo = make_repo(monkeypatch, FakeTable(put_error="ConditionalCheckFailedException"))
    assert repo.ensure_tracked("AAPL", "t") is False


class FakeEvents:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[list[dict[str, Any]]] = []

    def put_events(self, Entries: list[dict[str, Any]]) -> dict[str, Any]:  # noqa: N803 - boto3 kwarg
        self.calls.append(Entries)
        r = self.responses[len(self.calls) - 1]
        if isinstance(r, Exception):
            raise r
        return r


def test_publisher_noop_for_empty_symbols(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeEvents([])
    monkeypatch.setattr(aws, "client", _cached(lambda svc: fake))
    assert EventPublisher("bus").prices_updated([], "t", "scheduled") is True
    assert fake.calls == []


def test_publisher_chunks_and_reports_partial_and_transport_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    n = events.MAX_SYMBOLS_PER_EVENT * 11  # 11 entries -> two PutEvents calls (10 + 1)
    symbols = [f"S{i:04d}" for i in range(n)]
    fake = FakeEvents(
        [{"FailedEntryCount": 1, "Entries": [{"ErrorCode": "x"}]}, EndpointConnectionError(endpoint_url="u")]
    )
    monkeypatch.setattr(aws, "client", _cached(lambda svc: fake))
    assert EventPublisher("bus").prices_updated(symbols, "t", "enrichment") is False
    assert [len(c) for c in fake.calls] == [10, 1]
    first = json.loads(fake.calls[0][0]["Detail"])
    assert first["trigger"] == "enrichment" and len(first["symbols"]) == events.MAX_SYMBOLS_PER_EVENT
    assert fake.calls[0][0]["EventBusName"] == "bus"
