"""Error hierarchy shared by providers and handlers.

`retryable` drives SQS partial-batch failures: retryable errors (throttling, 5xx, network) make the
message visible again, non-retryable ones (unknown symbol, missing API key) are logged and acked.
"""

from __future__ import annotations


class ProviderError(Exception):
    retryable = False

    def __init__(
        self, message: str, *, provider: str = "", symbol: str | None = None, status: int | None = None
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.symbol = symbol
        self.status = status


class RetryableProviderError(ProviderError):
    """Throttling (429 / quota), 5xx or network failure."""

    retryable = True


class RateLimitError(RetryableProviderError):
    """Provider or client-side quota exhausted."""


class SymbolNotFoundError(ProviderError):
    """The provider does not know the symbol (non-retryable)."""


class ProviderUnavailableError(ProviderError):
    """No provider is configured for this symbol (e.g. missing API key). Non-retryable."""
