"""Provider API keys: direct env override (`{NAME}_API_KEY`) or SSM SecureString (`{NAME}_API_KEY_PARAM`).

Values are cached per container; keys are never logged.
"""

from __future__ import annotations

import logging
import os

from botocore.exceptions import BotoCoreError, ClientError

from . import aws

log = logging.getLogger(__name__)

PROVIDER_ENV_PREFIXES = {
    "twelvedata": "TWELVEDATA",
    "eodhd": "EODHD",
    "coingecko": "COINGECKO",
    "alphavantage": "ALPHAVANTAGE",
}

_cache: dict[str, str | None] = {}


def get_api_key(provider: str) -> str | None:
    prefix = PROVIDER_ENV_PREFIXES[provider]
    direct = os.environ.get(f"{prefix}_API_KEY", "").strip()
    if direct:
        return direct
    param = os.environ.get(f"{prefix}_API_KEY_PARAM", "").strip()
    if not param:
        return None
    if param in _cache:
        return _cache[param]
    value: str | None
    try:
        resp = aws.client("ssm").get_parameter(Name=param, WithDecryption=True)
        value = resp["Parameter"]["Value"].strip() or None
    except (ClientError, BotoCoreError) as exc:
        code = exc.response["Error"]["Code"] if isinstance(exc, ClientError) else type(exc).__name__
        log.warning(
            "api key parameter unavailable", extra={"provider": provider, "parameter": param, "error": code}
        )
        value = None
    _cache[param] = value
    return value


def clear_cache() -> None:
    _cache.clear()
