from __future__ import annotations

import io
import json
import urllib.error
from collections.abc import Callable, Iterator
from email.message import Message
from typing import Any

import boto3
import pytest
from moto import mock_aws

from prices import aws, handlers, secrets

TABLE = "portfolio-tracker-test"
BUS = "portfolio-tracker-test"

API_KEY_ENV = [
    f"{p}_API_KEY{s}" for p in ("TWELVEDATA", "EODHD", "COINGECKO", "ALPHAVANTAGE") for s in ("", "_PARAM")
]


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-west-1")
    monkeypatch.setenv("TABLE_NAME", TABLE)
    monkeypatch.setenv("EVENT_BUS_NAME", BUS)
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "mock")
    # Keep the initial FX_DAY backfill small (the default 2015-01-01 means ~3000 items per test).
    monkeypatch.setenv("FX_HISTORY_START", "2026-10-01")
    for name in ["AWS_ENDPOINT_URL", "EU_REFRESH_HOURS", "FX_PROVIDER", "COINGECKO_COIN_IDS", *API_KEY_ENV]:
        monkeypatch.delenv(name, raising=False)
    aws.reset()
    secrets.clear_cache()
    handlers.reset()
    yield
    aws.reset()
    secrets.clear_cache()
    handlers.reset()


class Infra:
    def __init__(self) -> None:
        self.ddb = boto3.resource("dynamodb", region_name="eu-west-1")
        self.table = self.ddb.create_table(
            TableName=TABLE,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        events = boto3.client("events", region_name="eu-west-1")
        sqs = boto3.client("sqs", region_name="eu-west-1")
        events.create_event_bus(Name=BUS)
        # Tests pin the clock to fixed past dates but moto expires messages against the real clock: with the
        # default 4 day retention every captured event vanished 4 days after the pinned date (a time bomb).
        # A century of retention never expires in practice.
        self.queue_url = sqs.create_queue(
            QueueName="capture", Attributes={"MessageRetentionPeriod": str(100 * 365 * 24 * 3600)}
        )["QueueUrl"]
        arn = sqs.get_queue_attributes(QueueUrl=self.queue_url, AttributeNames=["QueueArn"])["Attributes"][
            "QueueArn"
        ]
        events.put_rule(
            Name="capture-all", EventBusName=BUS, EventPattern=json.dumps({"source": ["portfolio.prices"]})
        )
        events.put_targets(Rule="capture-all", EventBusName=BUS, Targets=[{"Id": "q", "Arn": arn}])
        self.sqs = sqs

    def items(self, pk: str | None = None) -> list[dict[str, Any]]:
        items = self.table.scan()["Items"]
        return sorted((i for i in items if pk is None or i["PK"] == pk), key=lambda i: (i["PK"], i["SK"]))

    def get(self, pk: str, sk: str) -> dict[str, Any] | None:
        return self.table.get_item(Key={"PK": pk, "SK": sk}).get("Item")

    def track(self, *symbols: str) -> None:
        for s in symbols:
            self.table.put_item(
                Item={"PK": "TRACKED", "SK": f"TICKER#{s}", "entityType": "TRACKED_TICKER", "symbol": s}
            )

    def events(self) -> list[dict[str, Any]]:
        out = []
        while True:
            msgs = self.sqs.receive_message(QueueUrl=self.queue_url, MaxNumberOfMessages=10).get(
                "Messages", []
            )
            if not msgs:
                return out
            for m in msgs:
                out.append(json.loads(m["Body"]))
                self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=m["ReceiptHandle"])


@pytest.fixture
def infra() -> Iterator[Infra]:
    with mock_aws():
        yield Infra()


# --------------------------------------------------------------------------- fake urllib


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


Responder = Callable[[Any], Any]


class FakeOpener:
    """Stands in for urllib.request.urlopen. Routes are (substring, response) checked in order;
    a response may be a JSON-able object, an int HTTP status, an Exception, or a list consumed FIFO."""

    def __init__(self, routes: list[tuple[str, Any]] | None = None) -> None:
        self.routes = list(routes or [])
        self.requests: list[Any] = []

    @property
    def urls(self) -> list[str]:
        return [r.full_url for r in self.requests]

    def add(self, match: str, response: Any) -> FakeOpener:
        self.routes.append((match, response))
        return self

    def __call__(self, request: Any, timeout: float | None = None) -> FakeResponse:
        assert timeout is not None, "requests must set a timeout"
        self.requests.append(request)
        for match, response in self.routes:
            if match in request.full_url:
                if isinstance(response, list):
                    if not response:
                        continue
                    response = response.pop(0)
                return self._emit(request, response)
        raise AssertionError(f"unexpected request {request.full_url}")

    @staticmethod
    def _emit(request: Any, response: Any) -> FakeResponse:
        if isinstance(response, BaseException):
            raise response
        if isinstance(response, int):
            headers = Message()
            headers["Retry-After"] = "0"
            raise urllib.error.HTTPError(request.full_url, response, "err", headers, io.BytesIO(b"error"))
        return FakeResponse(json.dumps(response).encode())


@pytest.fixture
def opener() -> FakeOpener:
    return FakeOpener()


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def http_factory(opener: FakeOpener, sleeps: list[float]) -> Callable[[str], Any]:
    from prices.httpclient import HttpClient

    def make(provider: str) -> HttpClient:
        return HttpClient(provider, opener=opener, sleep=sleeps.append, max_retries=2)

    return make
