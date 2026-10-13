"""Cached boto3 clients/resources (one per container). boto3 is provided by the Lambda runtime."""

from __future__ import annotations

import functools
import os
from typing import Any

import boto3
from botocore.config import Config

from .config import DEFAULT_REGION

_BOTO_CONFIG = Config(retries={"mode": "standard", "max_attempts": 5}, connect_timeout=5, read_timeout=15)


def _region() -> str:
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or DEFAULT_REGION


def _endpoint() -> str | None:
    return os.environ.get("AWS_ENDPOINT_URL") or None


@functools.cache
def client(service: str) -> Any:
    return boto3.client(service, region_name=_region(), endpoint_url=_endpoint(), config=_BOTO_CONFIG)


@functools.cache
def dynamodb() -> Any:
    return boto3.resource("dynamodb", region_name=_region(), endpoint_url=_endpoint(), config=_BOTO_CONFIG)


def table(name: str) -> Any:
    return dynamodb().Table(name)


def reset() -> None:
    """Drop cached clients (tests / local runs that change env)."""
    client.cache_clear()
    dynamodb.cache_clear()
