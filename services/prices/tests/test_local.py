from __future__ import annotations

import json

import pytest

from prices import local
from tests.conftest import Infra


def test_local_refresh_and_enrich(
    infra: Infra, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("AWS_ENDPOINT_URL", "")  # keep moto in charge instead of LocalStack
    assert local.main(["refresh", "aapl", "--all-hours"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["refreshed"] == 1 and out["euWindow"] is True
    assert infra.get("TRACKED", "TICKER#AAPL") is not None

    assert local.main(["enrich", "SAP.DE"]) == 0
    assert json.loads(capsys.readouterr().out) == {"batchItemFailures": []}
    assert infra.get("TICKER#SAP.DE", "PROFILE")["name"] == "SAP SE"


def test_sqs_event_shape() -> None:
    event = local.sqs_event(["AAPL"])
    body = json.loads(event["Records"][0]["body"])
    assert body["detail"]["symbols"] == ["AAPL"] and body["detail-type"] == "TransactionsChanged"


def test_local_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in local.LOCAL_DEFAULTS:
        monkeypatch.delenv(k, raising=False)
    local.apply_local_env()
    import os

    assert os.environ["AWS_ENDPOINT_URL"] == "http://localhost:4566"
    assert os.environ["TABLE_NAME"] == "portfolio-tracker-local"
    assert os.environ["AWS_REGION"] == "eu-west-1"


def test_local_refresh_without_symbols_and_module_entrypoint(
    infra: Infra, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import runpy
    import sys

    monkeypatch.setenv("AWS_ENDPOINT_URL", "")
    infra.track("MSFT")
    assert local.main(["refresh"]) == 0
    assert json.loads(capsys.readouterr().out)["refreshed"] == 1

    monkeypatch.setattr(sys, "argv", ["prices.local", "refresh"])
    sys.modules.pop("prices.local", None)
    with pytest.raises(SystemExit) as exc:
        runpy.run_module("prices.local", run_name="__main__")
    assert exc.value.code == 0
