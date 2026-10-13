"""Structured JSON logging with the stdlib (aws-lambda-powertools is intentionally not bundled)."""

from __future__ import annotations

import contextvars
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)

_RESERVED = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "aws_request_id"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "service": "prices",
        }
        rid = request_id.get()
        if rid:
            payload["requestId"] = rid
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    root = logging.getLogger()
    root.setLevel(level)
    formatter = JsonFormatter()
    if not root.handlers:
        root.addHandler(logging.StreamHandler())
    for handler in root.handlers:
        handler.setFormatter(formatter)
    for noisy in ("botocore", "boto3", "urllib3"):
        logging.getLogger(noisy).setLevel(max(logging.WARNING, root.level))
