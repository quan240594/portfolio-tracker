from __future__ import annotations

import logging
import urllib.error

import pytest

from prices.errors import ProviderError, RateLimitError, RetryableProviderError, SymbolNotFoundError
from prices.httpclient import DailyQuota, HttpClient, TokenBucket, redact_url
from tests.conftest import FakeOpener

SECRET = "sup3r-s3cret-key"


def test_redact_url() -> None:
    url = f"https://x.test/a?symbol=AAPL&api_token={SECRET}&apikey={SECRET}&fmt=json"
    redacted = redact_url(url)
    assert SECRET not in redacted
    assert "symbol=AAPL" in redacted and "api_token=***" in redacted and "apikey=***" in redacted
    assert redact_url("https://x.test/a") == "https://x.test/a"


def test_retries_429_then_succeeds(caplog: pytest.LogCaptureFixture) -> None:
    opener = FakeOpener([("x.test", [429, 503, {"ok": True}])])
    sleeps: list[float] = []
    client = HttpClient("p", opener=opener, sleep=sleeps.append, max_retries=3)
    with caplog.at_level(logging.DEBUG):
        assert client.get_json("https://x.test/q", {"apikey": SECRET, "s": "A,B"}) == {"ok": True}
    assert len(opener.requests) == 3 and len(sleeps) == 2
    assert "s=A,B" in opener.urls[0]
    assert SECRET not in caplog.text
    assert any(getattr(r, "url", "").endswith("apikey=***&s=A,B") for r in caplog.records)


def test_retries_exhausted_raises_rate_limit_without_key() -> None:
    opener = FakeOpener([("x.test", 429)])
    client = HttpClient("p", opener=opener, sleep=lambda _s: None, max_retries=2)
    with pytest.raises(RateLimitError) as info:
        client.get_json("https://x.test/q", {"api_token": SECRET})
    assert info.value.retryable and info.value.status == 429
    assert SECRET not in str(info.value)
    assert len(opener.requests) == 3


def test_5xx_is_retryable() -> None:
    client = HttpClient("p", opener=FakeOpener([("x.test", 502)]), sleep=lambda _s: None, max_retries=1)
    with pytest.raises(RetryableProviderError) as info:
        client.get_json("https://x.test/q")
    assert not isinstance(info.value, RateLimitError)


def test_404_and_400_not_retried() -> None:
    opener = FakeOpener([("/missing", 404), ("/bad", 400)])
    client = HttpClient("p", opener=opener, sleep=lambda _s: pytest.fail("no sleep"))
    with pytest.raises(SymbolNotFoundError):
        client.get_json("https://x.test/missing", symbol="X")
    with pytest.raises(ProviderError) as info:
        client.get_json("https://x.test/bad")
    assert not info.value.retryable and info.value.status == 400
    assert len(opener.requests) == 2


def test_network_error_retried() -> None:
    opener = FakeOpener([("x.test", [urllib.error.URLError(TimeoutError()), TimeoutError(), {"a": 1}])])
    client = HttpClient("p", opener=opener, sleep=lambda _s: None, max_retries=3)
    assert client.get_json("https://x.test/q") == {"a": 1}


def test_invalid_json() -> None:
    class Raw:
        def __call__(self, request, timeout=None):
            from tests.conftest import FakeResponse

            return FakeResponse(b"<html>")

    with pytest.raises(ProviderError, match="invalid JSON"):
        HttpClient("p", opener=Raw()).get_json("https://x.test/q")


def test_backoff_bounds() -> None:
    client = HttpClient("p", backoff_base=1, backoff_max=4)
    for attempt in range(6):
        assert 0 <= client._backoff(attempt, None) <= 4
    assert client._backoff(0, "2") == 2
    assert client._backoff(0, "99") == 4
    assert 0 <= client._backoff(0, "soon") <= 1


def test_token_bucket_waits() -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    bucket = TokenBucket(8, 8 / 60, clock=lambda: now[0], sleep=sleep)
    assert bucket.acquire(8) == 0
    waited = bucket.acquire(4)
    assert waited == pytest.approx(30.0)
    with pytest.raises(ValueError):
        bucket.acquire(9)


def test_daily_quota_resets_per_day() -> None:
    day = ["2026-10-13"]
    quota = DailyQuota(2, "p", today=lambda: day[0])
    quota.consume(2)
    with pytest.raises(RateLimitError):
        quota.consume()
    day[0] = "2026-10-14"
    quota.consume()
    assert quota.used == 1
