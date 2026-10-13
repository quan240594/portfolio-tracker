"""Tiny stdlib HTTP client: timeouts, retries with exponential backoff + jitter, key redaction.

No third-party HTTP dependencies so the Lambda zip stays dependency-free.
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from .errors import ProviderError, RateLimitError, RetryableProviderError, SymbolNotFoundError

log = logging.getLogger(__name__)

SENSITIVE_PARAMS = frozenset(
    {"apikey", "api_key", "api_token", "token", "key", "x_cg_demo_api_key", "access_key"}
)
SENSITIVE_HEADERS = frozenset({"x-cg-demo-api-key", "authorization", "x-api-key"})
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
USER_AGENT = "portfolio-tracker-prices/0.1 (+https://github.com/)"


def redact_url(url: str) -> str:
    """Replace the values of credential-like query parameters with `***`."""
    parts = urllib.parse.urlsplit(url)
    if not parts.query:
        return url
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    safe = [(k, "***" if k.lower() in SENSITIVE_PARAMS else v) for k, v in pairs]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(safe, safe=",*")))


class TokenBucket:
    """Client-side rate limiter: `capacity` tokens, refilled continuously at `rate` tokens/second."""

    def __init__(
        self,
        capacity: float,
        rate: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.capacity = float(capacity)
        self.rate = float(rate)
        self._tokens = float(capacity)
        self._clock = clock
        self._sleep = sleep
        self._last = clock()
        self._lock = threading.Lock()

    def _refill(self) -> None:
        now = self._clock()
        self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
        self._last = now

    def acquire(self, tokens: float = 1.0) -> float:
        """Block until `tokens` are available; returns total seconds waited."""
        if tokens > self.capacity:
            raise ValueError(f"cannot acquire {tokens} tokens from a bucket of {self.capacity}")
        waited = 0.0
        while True:
            with self._lock:
                self._refill()
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return waited
                wait = (tokens - self._tokens) / self.rate
            self._sleep(wait)
            waited += wait


class DailyQuota:
    """Per-container counter of calls/credits per UTC day; raises RateLimitError once exhausted."""

    def __init__(self, limit: int, provider: str, *, today: Callable[[], str] | None = None) -> None:
        self.limit = limit
        self.provider = provider
        self._today = today or (lambda: datetime.now(UTC).date().isoformat())
        self._day = ""
        self.used = 0

    def consume(self, n: int = 1) -> None:
        day = self._today()
        if day != self._day:
            self._day, self.used = day, 0
        if self.used + n > self.limit:
            raise RateLimitError(
                f"{self.provider} daily quota of {self.limit} exhausted", provider=self.provider
            )
        self.used += n


Opener = Callable[..., Any]


class HttpClient:
    def __init__(
        self,
        provider: str,
        *,
        timeout: float = 10.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        backoff_max: float = 8.0,
        opener: Opener | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.provider = provider
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self._opener = opener or urllib.request.urlopen
        self._sleep = sleep

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), self.backoff_max)
            except ValueError:
                pass
        delay = min(self.backoff_max, self.backoff_base * (2**attempt))
        return delay / 2 + random.uniform(0, delay / 2)  # noqa: S311 - jitter, not crypto

    def get_json(
        self,
        url: str,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        *,
        symbol: str | None = None,
    ) -> Any:
        full = url
        if params:
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, safe=",")
            full = f"{url}{'&' if '?' in url else '?'}{query}"
        safe_url = redact_url(full)
        req_headers = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
        last_error: ProviderError | None = None

        for attempt in range(self.max_retries + 1):
            retry_after: str | None = None
            started = time.monotonic()
            try:
                request = urllib.request.Request(full, headers=req_headers, method="GET")  # noqa: S310
                with self._opener(request, timeout=self.timeout) as resp:
                    body = resp.read()
                log.debug(
                    "http ok",
                    extra={
                        "provider": self.provider,
                        "url": safe_url,
                        "ms": int((time.monotonic() - started) * 1000),
                    },
                )
                try:
                    return json.loads(body) if body else None
                except ValueError as exc:
                    raise ProviderError(
                        f"{self.provider}: invalid JSON from {safe_url}",
                        provider=self.provider,
                        symbol=symbol,
                    ) from exc
            except urllib.error.HTTPError as exc:
                status = exc.code
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                exc.close()
                if status == 404:
                    raise SymbolNotFoundError(
                        f"{self.provider}: 404 for {safe_url}",
                        provider=self.provider,
                        symbol=symbol,
                        status=404,
                    ) from None
                if status not in RETRY_STATUSES:
                    raise ProviderError(
                        f"{self.provider}: HTTP {status} for {safe_url}",
                        provider=self.provider,
                        symbol=symbol,
                        status=status,
                    ) from None
                cls = RateLimitError if status == 429 else RetryableProviderError
                last_error = cls(
                    f"{self.provider}: HTTP {status} for {safe_url}",
                    provider=self.provider,
                    symbol=symbol,
                    status=status,
                )
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                last_error = RetryableProviderError(
                    f"{self.provider}: network error for {safe_url}: {type(reason).__name__}",
                    provider=self.provider,
                    symbol=symbol,
                )
            if attempt < self.max_retries:
                delay = self._backoff(attempt, retry_after)
                log.warning(
                    "http retry",
                    extra={
                        "provider": self.provider,
                        "url": safe_url,
                        "attempt": attempt + 1,
                        "delaySeconds": round(delay, 2),
                        "error": str(last_error),
                    },
                )
                self._sleep(delay)
        assert last_error is not None
        raise last_error
