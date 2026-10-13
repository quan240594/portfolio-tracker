"""Lambda entry points.

- `prices.handlers.scheduled_refresh`      — EventBridge Scheduler cron: FX (latest + daily ECB fixings,
                                             gaps backfilled) + quotes for tracked tickers.
- `prices.handlers.on_transactions_changed` — SQS (enrich-queue) batch of TransactionsChanged envelopes.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from botocore.exceptions import BotoCoreError, ClientError

from .config import Settings
from .errors import ProviderError, ProviderUnavailableError, SymbolNotFoundError
from .events import EventPublisher
from .logging_setup import request_id, setup_logging
from .models import EodPrice, FxDay, FxRates, InstrumentProfile, Quote, iso_datetime, parse_iso_datetime
from .providers import FxProvider, MarketDataProvider, build_fx_provider, build_provider, fetch_quotes
from .repository import Repository
from .symbols import has_exchange_suffix, minimal_profile, normalize

log = logging.getLogger("prices.handlers")

STALE_AFTER = timedelta(hours=24)
HISTORY_DAYS = 365
DIVIDEND_LOOKBACK_DAYS = 730
DIVIDEND_LOOKAHEAD_DAYS = 365


@dataclass
class Deps:
    settings: Settings
    repo: Repository
    provider: MarketDataProvider
    fx: FxProvider
    publisher: EventPublisher


_deps: Deps | None = None
_logging_ready = False


def get_deps() -> Deps:
    global _deps
    if _deps is None:
        settings = Settings.from_env()
        _deps = Deps(
            settings=settings,
            repo=Repository(settings.table_name),
            provider=build_provider(settings.provider),
            fx=build_fx_provider(settings.fx_provider),
            publisher=EventPublisher(settings.event_bus_name),
        )
    return _deps


def reset() -> None:
    """Forget cached dependencies (tests / local runner)."""
    global _deps
    _deps = None


def _init(context: Any) -> None:
    global _logging_ready
    if not _logging_ready:
        setup_logging()
        _logging_ready = True
    request_id.set(getattr(context, "aws_request_id", None))


def utcnow() -> datetime:
    return datetime.now(UTC)


def _last_sunday(year: int, month: int) -> date:
    d = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def amsterdam_hour(now: datetime) -> int:
    try:
        return now.astimezone(ZoneInfo("Europe/Amsterdam")).hour
    except ZoneInfoNotFoundError:  # pragma: no cover - runtime without tzdata: EU DST rule
        utc = now.astimezone(UTC)
        start = datetime.combine(_last_sunday(utc.year, 3), time(1), UTC)
        end = datetime.combine(_last_sunday(utc.year, 10), time(1), UTC)
        return (utc + timedelta(hours=2 if start <= utc < end else 1)).hour


# --------------------------------------------------------------------------- scheduled refresh


def scheduled_refresh(event: dict[str, Any] | None, context: Any) -> dict[str, Any]:
    _init(context)
    return run_scheduled_refresh(get_deps(), utcnow())


def _refresh_fx(deps: Deps) -> FxRates | None:
    try:
        fx = deps.fx.get_latest(deps.settings.base_currency)
        deps.repo.put_fx(fx)
        log.info("fx refreshed", extra={"base": fx.base, "currencies": len(fx.rates), "asOf": fx.asOf})
        return fx
    except (ProviderError, ClientError, BotoCoreError) as exc:
        log.error("fx refresh failed", extra={"error": str(exc)})
        return None


def backfill_fx_history(deps: Deps, today: date, start: date | None = None) -> dict[str, Any]:
    """Store daily ECB fixings (FX_DAY items) from `start` — default: the day after the latest stored
    fixing, or `FX_HISTORY_START` when none exists — through `today`. Provider/storage errors propagate."""
    base = deps.settings.base_currency
    stored = deps.repo.latest_fx_day(base)
    if start is None:
        start = date.fromisoformat(stored) + timedelta(days=1) if stored else deps.settings.fx_history_start
    days = deps.fx.get_history(base, start, today) if start <= today else []
    written = deps.repo.put_fx_days(days) if days else 0
    last_day = max(filter(None, [stored, days[-1].date if days else None]), default=None)
    result = {
        "base": base,
        "start": start.isoformat(),
        "end": today.isoformat(),
        "fxDaysWritten": written,
        "lastDay": last_day,
    }
    log.info("fx history stored", extra=result)
    return result


def _store_fx_days(deps: Deps, latest: FxRates | None, today: date) -> tuple[int, bool]:
    """Backfill missing fixings, then store today's fixing from the latest rates. Never raises.

    Today's fixing is only written after a successful backfill: otherwise it would become the newest
    FX_DAY item and hide the gap from the next run's "latest stored day + 1" computation."""
    try:
        result = backfill_fx_history(deps, today)
        written = int(result["fxDaysWritten"])
        base = deps.settings.base_currency
        fixing = latest.date if latest is not None and latest.base == base else None
        if latest is not None and fixing and fixing > (result["lastDay"] or ""):
            written += deps.repo.put_fx_days([FxDay(base=base, date=fixing, rates=dict(latest.rates))])
        return written, True
    except Exception:
        log.exception("fx history refresh failed")
        return 0, False


def run_scheduled_refresh(deps: Deps, now: datetime) -> dict[str, Any]:
    symbols = deps.repo.list_tracked()
    latest_fx = _refresh_fx(deps)
    fx_ok = latest_fx is not None
    fx_days_written, fx_history_ok = _store_fx_days(deps, latest_fx, now.astimezone(UTC).date())

    in_eu_window = amsterdam_hour(now) in deps.settings.eu_refresh_hours
    skipped: list[str] = []
    due = [s for s in symbols if not has_exchange_suffix(s)]
    listed = [s for s in symbols if has_exchange_suffix(s)]
    if in_eu_window:
        due.extend(listed)
    elif listed:
        latest = deps.repo.latest_quotes(listed)
        for s in listed:
            q = latest.get(s)
            if q is None or now - parse_iso_datetime(q.asOf) > STALE_AFTER:
                due.append(s)
            else:
                skipped.append(s)

    failed: dict[str, str] = {}
    refreshed: list[str] = []
    if due:
        try:
            batch = fetch_quotes(deps.provider, due)
        except Exception as exc:
            log.exception("quote fetch crashed")
            batch = None
            failed.update({s: str(exc) for s in due})
        if batch is not None:
            skipped.extend(batch.unavailable)
            failed.update({s: str(e) for s, e in batch.failed.items()})
            for symbol, quote in batch.quotes.items():
                try:
                    deps.repo.put_quote(quote)
                    deps.repo.put_eods([eod_from_quote(quote)])
                    refreshed.append(symbol)
                except (ClientError, BotoCoreError) as exc:
                    failed[symbol] = str(exc)
    for symbol, error in sorted(failed.items()):
        log.warning("symbol refresh failed", extra={"symbol": symbol, "error": error})

    published = (
        deps.publisher.prices_updated(refreshed, iso_datetime(now), "scheduled") if refreshed else False
    )
    summary = {
        "refreshed": len(refreshed),
        "skipped": len(skipped),
        "failed": len(failed),
        "fxUpdated": fx_ok,
        "fxDaysWritten": fx_days_written,
        "fxHistoryOk": fx_history_ok,
        "eventPublished": published,
        "euWindow": in_eu_window,
        "failedSymbols": sorted(failed),
        "skippedSymbols": sorted(skipped),
    }
    log.info("scheduled refresh complete", extra={"summary": summary})
    return summary


def eod_from_quote(quote: Quote) -> EodPrice:
    day = parse_iso_datetime(quote.asOf).astimezone(UTC).date().isoformat()
    return EodPrice(symbol=quote.symbol, date=day, close=quote.price, currency=quote.currency)


# --------------------------------------------------------------------------- enrichment


def on_transactions_changed(event: dict[str, Any], context: Any) -> dict[str, Any]:
    _init(context)
    return run_enrichment(get_deps(), event, utcnow())


def parse_symbols(body: str) -> list[str]:
    """Extract TransactionsChanged.detail.symbols from an SQS body holding an EventBridge envelope."""
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("body is not a JSON object")
    detail = payload.get("detail", payload)
    if isinstance(detail, str):
        detail = json.loads(detail)
    symbols = detail.get("symbols") if isinstance(detail, dict) else None
    if not isinstance(symbols, list):
        raise ValueError("detail.symbols missing")
    return [normalize(s) for s in symbols if isinstance(s, str) and s.strip()]


class _RetryableError(Exception):
    pass


def _quote_from_history(symbol: str, history: list[EodPrice], source: str) -> Quote | None:
    if not history:
        return None
    last = history[-1]
    prev = history[-2].close if len(history) > 1 else last.close
    as_of = datetime.combine(date.fromisoformat(last.date), time(0), UTC)
    return Quote(symbol, last.close, prev, last.currency, iso_datetime(as_of), f"{source}-eod")


def enrich_symbol(deps: Deps, symbol: str, now: datetime) -> bool:
    """Fetch & store everything for a new symbol. Returns True when enriched, False when skipped
    (non-retryable). Raises _RetryableError for throttling / 5xx / storage errors.

    The PROFILE item is written last: it is the "already enriched" marker that makes redelivery
    idempotent, so a partial failure is simply redone on retry."""
    provider = deps.provider
    today = now.astimezone(UTC).date()
    try:
        try:
            profile: InstrumentProfile | None = provider.get_profile(symbol)
        except SymbolNotFoundError:
            profile = None
        try:
            history = provider.get_eod_history(symbol, today - timedelta(days=HISTORY_DAYS), today)
        except SymbolNotFoundError:
            log.warning("unknown symbol; not enriching", extra={"symbol": symbol})
            return False
        try:
            dividends = provider.get_dividends(
                symbol,
                today - timedelta(days=DIVIDEND_LOOKBACK_DAYS),
                today + timedelta(days=DIVIDEND_LOOKAHEAD_DAYS),
            )
        except ProviderError as exc:
            if exc.retryable:
                raise
            log.warning("dividends unavailable", extra={"symbol": symbol, "error": str(exc)})
            dividends = []
        batch = fetch_quotes(provider, [symbol])
        if symbol in batch.failed and batch.failed[symbol].retryable:
            raise batch.failed[symbol]
        quote = batch.quotes.get(symbol) or _quote_from_history(symbol, history, provider.name)

        if profile is None:
            profile = minimal_profile(symbol)
            log.info("using fallback profile", extra={"symbol": symbol})
        deps.repo.put_eods(history)
        deps.repo.put_dividends(dividends)
        if quote is not None:
            deps.repo.put_quote(quote)
        deps.repo.ensure_tracked(symbol, iso_datetime(now))
        deps.repo.put_profile(profile)
    except ProviderUnavailableError as exc:
        log.warning("no provider for symbol; skipping", extra={"symbol": symbol, "error": str(exc)})
        return False
    except ProviderError as exc:
        if exc.retryable:
            raise _RetryableError(str(exc)) from exc
        log.warning("non-retryable provider error; skipping", extra={"symbol": symbol, "error": str(exc)})
        return False
    except (ClientError, BotoCoreError) as exc:
        raise _RetryableError(str(exc)) from exc
    log.info(
        "symbol enriched",
        extra={
            "symbol": symbol,
            "eod": len(history),
            "dividends": len(dividends),
            "quote": quote is not None,
        },
    )
    return True


def run_enrichment(deps: Deps, event: dict[str, Any], now: datetime) -> dict[str, Any]:
    by_message: dict[str, list[str]] = {}
    for record in event.get("Records") or []:
        message_id = record.get("messageId", "")
        try:
            by_message[message_id] = parse_symbols(record.get("body") or "")
        except (ValueError, TypeError, AttributeError) as exc:
            log.error("malformed message; acking", extra={"messageId": message_id, "error": str(exc)})

    unique = sorted({s for symbols in by_message.values() for s in symbols})
    retry: set[str] = set()
    enriched: list[str] = []
    try:
        existing = deps.repo.symbols_with_profile(unique) if unique else set()
    except (ClientError, BotoCoreError) as exc:
        log.error("profile lookup failed; retrying batch", extra={"error": str(exc)})
        return {"batchItemFailures": [{"itemIdentifier": m} for m in by_message if by_message[m]]}

    for symbol in unique:
        if symbol in existing:
            continue
        try:
            if enrich_symbol(deps, symbol, now):
                enriched.append(symbol)
        except _RetryableError as exc:
            log.warning("retryable enrichment failure", extra={"symbol": symbol, "error": str(exc)})
            retry.add(symbol)
        except Exception:
            log.exception("unexpected enrichment failure", extra={"symbol": symbol})
            retry.add(symbol)

    if enriched:
        deps.publisher.prices_updated(enriched, iso_datetime(now), "enrichment")
    failures = [{"itemIdentifier": m} for m, symbols in by_message.items() if retry.intersection(symbols)]
    log.info(
        "enrichment complete",
        extra={
            "symbols": len(unique),
            "alreadyEnriched": len(existing),
            "enriched": enriched,
            "retry": sorted(retry),
            "batchItemFailures": len(failures),
        },
    )
    return {"batchItemFailures": failures}
