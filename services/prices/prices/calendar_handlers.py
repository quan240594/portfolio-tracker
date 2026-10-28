"""Lambda entry point of the calendar refresh.

- `prices.calendar_handlers.calendar_refresh` - EventBridge Scheduler cron (daily): upcoming earnings
  dates of every tracked ticker (one Alpha Vantage call), then splits (and refreshed dividends) for a
  rotating, budgeted subset of the tracked tickers (EODHD). Holdings and watchlist symbols share the
  `TRACKED` registry, so both are covered.

Everything is idempotent (items are keyed by symbol and date) and failures are per symbol/provider: they
are logged and counted in the returned summary, never fatal. API keys are never logged.

Run locally against LocalStack: `python -m prices.calendar_handlers` (MARKET_DATA_PROVIDER=mock by default).
"""

from __future__ import annotations

import json
import logging
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from .calendar_config import CalendarSettings
from .calendar_providers import CorporateActionsSource, EarningsSource, av_symbol, build_calendar_sources
from .calendar_repository import CalendarRepository
from .config import Settings
from .errors import ProviderError, RateLimitError
from .handlers import DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS, _init, utcnow
from .models import iso_datetime
from .repository import Repository
from .symbols import is_crypto

log = logging.getLogger("prices.calendar_handlers")


@dataclass
class CalendarDeps:
    settings: Settings
    calendar: CalendarSettings
    repo: Repository
    crepo: CalendarRepository
    earnings: EarningsSource | None
    actions: CorporateActionsSource | None


_deps: CalendarDeps | None = None


def get_deps() -> CalendarDeps:
    global _deps
    if _deps is None:
        settings = Settings.from_env()
        calendar = CalendarSettings.from_env()
        earnings, actions = build_calendar_sources(settings.provider, calendar)
        _deps = CalendarDeps(
            settings=settings,
            calendar=calendar,
            repo=Repository(settings.table_name),
            crepo=CalendarRepository(settings.table_name),
            earnings=earnings,
            actions=actions,
        )
    return _deps


def reset() -> None:
    """Forget cached dependencies (tests / local runner)."""
    global _deps
    _deps = None


def calendar_refresh(event: dict[str, Any] | None, context: Any) -> dict[str, Any]:
    _init(context)
    return run_calendar_refresh(get_deps(), utcnow())


# --------------------------------------------------------------------------- earnings


MAX_RUN_SYMBOLS = 300
_URL = re.compile(r"https?://\S+")
_SECRET = re.compile(r"\b(?:api_?key|token|secret|key)=\S+", re.IGNORECASE)
_LONG_TOKEN = re.compile(r"[A-Za-z0-9_-]{24,}")


def _safe_reason(text: str, fallback: str) -> str:
    """One line without URLs or tokens, at most 120 characters (same rule as `sanitizeAttemptError`)."""
    clean = _LONG_TOKEN.sub("[redacted]", _SECRET.sub("[redacted]", _URL.sub("[url]", text)))
    clean = " ".join(clean.split())
    if not clean:
        return fallback
    return clean if len(clean) <= 120 else clean[:119] + "\u2026"


def _record_earnings_run(deps: CalendarDeps, run: dict[str, Any]) -> None:
    try:
        deps.crepo.put_earnings_run(run)
    except (ClientError, BotoCoreError) as exc:
        log.warning("could not record the earnings run", extra={"error": str(exc)})


def _refresh_earnings(deps: CalendarDeps, symbols: list[str], today: date, stamp: str) -> dict[str, Any]:
    """One provider call lists the upcoming earnings of every company; only tracked tickers are stored.
    The outcome is recorded for Settings > Diagnostics (see `put_earnings_run`)."""
    run: dict[str, Any] = {"at": stamp, "trigger": "scheduled", "reason": "", "tracked": len(symbols)}
    summary = _attempt_earnings(deps, symbols, today, stamp, run)
    run["status"] = summary["status"]
    _record_earnings_run(deps, run)
    return summary


def _attempt_earnings(
    deps: CalendarDeps, symbols: list[str], today: date, stamp: str, run: dict[str, Any]
) -> dict[str, Any]:
    source = deps.earnings
    if source is None:
        return {"status": "no-provider"}
    eligible = [s for s in symbols if av_symbol(s) is not None]
    if not eligible:
        return {"status": "no-symbols"}
    day = today.isoformat()
    if source.budgeted and not deps.crepo.consume_budget(
        source.name, day, 1, deps.calendar.alphavantage_daily_calls
    ):
        log.info("earnings refresh skipped: daily budget used", extra={"provider": source.name})
        return {"status": "budget-exhausted"}
    try:
        events = source.fetch(eligible, today)
        written = deps.crepo.put_earnings(events, stamp)
        stale = _drop_moved_reports(deps, events, day)
    except (ProviderError, ClientError, BotoCoreError) as exc:
        log.warning("earnings refresh failed", extra={"provider": source.name, "error": str(exc)})
        status = "rate-limited" if isinstance(exc, RateLimitError) else "failed"
        run["reason"] = _safe_reason(str(exc), type(exc).__name__)
        return {"status": status, "error": type(exc).__name__}
    matched = sorted({e.symbol for e in events})
    run.update({"events": written, "matchedSymbols": matched[:MAX_RUN_SYMBOLS]})
    return {
        "status": "ok",
        "symbols": len(matched),
        "events": written,
        "staleDeleted": stale,
    }


def _drop_moved_reports(deps: CalendarDeps, events: list[Any], today: str) -> int:
    """Removes stored upcoming report dates that the provider no longer lists (the company rescheduled)."""
    dates: dict[str, set[str]] = {}
    for e in events:
        dates.setdefault(e.symbol, set()).add(e.date)
    deleted = 0
    for symbol, keep in sorted(dates.items()):
        stale = deps.crepo.stale_earnings_dates(symbol, today, keep)
        if stale:
            deleted += deps.crepo.delete_earnings(symbol, stale)
    return deleted


# --------------------------------------------------------------------------- splits and dividends


def due_symbols(
    symbols: list[str], states: dict[str, dict[str, Any]], now: datetime, recheck_days: int
) -> list[str]:
    """Symbols whose splits were not checked within `recheck_days`, least recently attempted first.

    Never-checked symbols come first; a symbol whose last attempt failed goes to the back of the queue so
    one broken ticker cannot use up the daily budget every day."""
    cutoff = iso_datetime(now - timedelta(days=recheck_days))

    def checked(symbol: str) -> str:
        return str(states.get(symbol, {}).get("splitsCheckedAt", ""))

    def attempted(symbol: str) -> str:
        return max(checked(symbol), str(states.get(symbol, {}).get("splitsFailedAt", "")))

    return sorted((s for s in symbols if checked(s) < cutoff), key=lambda s: (attempted(s), s))


def _check_symbol(
    deps: CalendarDeps, source: CorporateActionsSource, symbol: str, today: date, stamp: str
) -> tuple[int, int]:
    """Fetches and stores splits (and dividends); returns the numbers of items written."""
    splits = source.get_splits(symbol, today - timedelta(days=deps.calendar.split_lookback_days))
    written_splits = deps.crepo.put_splits(splits, stamp)
    written_dividends = 0
    marker = {"splitsCheckedAt": stamp}
    if deps.calendar.refresh_dividends:
        dividends = source.get_dividends(
            symbol,
            today - timedelta(days=DIVIDEND_LOOKBACK_DAYS),
            today + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS),
        )
        written_dividends = deps.repo.put_dividends(dividends)
        marker["dividendsCheckedAt"] = stamp
    deps.crepo.put_state(symbol, **marker)
    return written_splits, written_dividends


def _refresh_corporate_actions(
    deps: CalendarDeps, symbols: list[str], now: datetime, today: date, stamp: str
) -> dict[str, Any]:
    source = deps.actions
    if source is None:
        return {"status": "no-provider"}
    eligible = [s for s in symbols if not is_crypto(s)]
    states = deps.crepo.get_states(eligible)
    due = due_symbols(eligible, states, now, deps.calendar.recheck_days)
    cost = 2 if deps.calendar.refresh_dividends else 1
    checked: list[str] = []
    failed: dict[str, str] = {}
    splits = dividends = 0
    status = "ok"
    for symbol in due:
        if source.budgeted and not deps.crepo.consume_budget(
            source.name, today.isoformat(), cost, deps.calendar.eodhd_daily_calls
        ):
            status = "budget-exhausted"
            break
        try:
            n_splits, n_dividends = _check_symbol(deps, source, symbol, today, stamp)
        except RateLimitError as exc:
            log.warning(
                "provider limit reached; stopping", extra={"provider": source.name, "error": str(exc)}
            )
            status = "rate-limited"
            break
        except (ProviderError, ClientError, BotoCoreError) as exc:
            failed[symbol] = type(exc).__name__
            log.warning("calendar check failed", extra={"symbol": symbol, "error": str(exc)})
            _mark_failed(deps, symbol, stamp)
            continue
        checked.append(symbol)
        splits += n_splits
        dividends += n_dividends
    return {
        "status": status,
        "eligible": len(eligible),
        "due": len(due),
        "checked": len(checked),
        "splitsWritten": splits,
        "dividendsWritten": dividends,
        "failed": len(failed),
        "failedSymbols": sorted(failed),
        "checkedSymbols": checked,
    }


def _mark_failed(deps: CalendarDeps, symbol: str, stamp: str) -> None:
    """Moves the symbol to the back of the queue; storage errors here are not worth failing the run for."""
    try:
        deps.crepo.put_state(symbol, splitsFailedAt=stamp)
    except (ClientError, BotoCoreError):
        log.exception("could not record failed calendar check", extra={"symbol": symbol})


# --------------------------------------------------------------------------- run


def run_calendar_refresh(deps: CalendarDeps, now: datetime) -> dict[str, Any]:
    symbols = deps.repo.list_tracked()
    today = now.astimezone(UTC).date()
    stamp = iso_datetime(now)
    summary = {
        "tracked": len(symbols),
        "earnings": _refresh_earnings(deps, symbols, today, stamp),
        "corporateActions": _refresh_corporate_actions(deps, symbols, now, today, stamp),
    }
    log.info("calendar refresh complete", extra={"summary": summary})
    return summary


def main() -> int:  # pragma: no cover - local runner
    from . import aws, secrets
    from .local import apply_local_env

    apply_local_env()
    aws.reset()
    secrets.clear_cache()
    reset()
    result = calendar_refresh({}, SimpleNamespace(aws_request_id=f"local-{uuid.uuid4()}"))
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
