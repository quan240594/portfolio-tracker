"""DynamoDB access of the calendar refresh (single table, layout per calendar_models.py)."""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Sequence
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from . import aws
from .calendar_models import (
    BUDGET_PK,
    EARNINGS_PREFIX,
    EARNINGS_RUN_LAST_SK,
    EARNINGS_RUN_OK_SK,
    ENTITY_CALENDAR_BUDGET,
    ENTITY_CALENDAR_STATE,
    ENTITY_EARNINGS_RUN,
    EarningsEvent,
    SplitEvent,
    budget_key,
    earnings_item,
    earnings_key,
    split_item,
    state_key,
)
from .keys import ticker_pk

log = logging.getLogger(__name__)

BATCH_GET_LIMIT = 100
MAX_UNPROCESSED_ATTEMPTS = 5
FAR_FUTURE = "9999-12-31"


def _is_conditional_failure(exc: ClientError) -> bool:
    return exc.response["Error"]["Code"] == "ConditionalCheckFailedException"


class CalendarRepository:
    def __init__(self, table_name: str) -> None:
        self.table_name = table_name
        self.table = aws.table(table_name)

    def _batch_put(self, items: Iterable[dict[str, Any]]) -> int:
        n = 0
        with self.table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as writer:
            for item in items:
                writer.put_item(Item=item)
                n += 1
        return n

    def put_earnings(self, events: Iterable[EarningsEvent], updated_at: str) -> int:
        """Idempotent: an event is keyed by symbol and report date, so re-runs overwrite the same items."""
        return self._batch_put(earnings_item(e, updated_at) for e in events)

    def put_earnings_run(self, run: dict[str, Any]) -> None:
        """What a calendar run did to the earnings dates, for Settings > Diagnostics: `EARNINGS#LASTRUN`
        always, `EARNINGS#LASTOK` too when it read the provider's calendar (the Cloudflare job's record)."""
        sort_keys = [EARNINGS_RUN_LAST_SK] + ([EARNINGS_RUN_OK_SK] if run.get("status") == "ok" else [])
        items = ({"PK": BUDGET_PK, "SK": sk, "entityType": ENTITY_EARNINGS_RUN, **run} for sk in sort_keys)
        self._batch_put(items)

    def put_splits(self, events: Iterable[SplitEvent], updated_at: str) -> int:
        return self._batch_put(split_item(e, updated_at) for e in events)

    def stale_earnings_dates(self, symbol: str, today: str, keep: set[str]) -> list[str]:
        """Dates of stored upcoming earnings of `symbol` not in `keep` (the company moved its report)."""
        resp = self.table.query(
            KeyConditionExpression=Key("PK").eq(ticker_pk(symbol))
            & Key("SK").between(f"{EARNINGS_PREFIX}{today}", f"{EARNINGS_PREFIX}{FAR_FUTURE}"),
            ProjectionExpression="SK",
        )
        dates = [str(i["SK"]).removeprefix(EARNINGS_PREFIX) for i in resp.get("Items", [])]
        return sorted(d for d in dates if d not in keep)

    def delete_earnings(self, symbol: str, dates: Iterable[str]) -> int:
        n = 0
        with self.table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as writer:
            for d in dates:
                writer.delete_item(Key=earnings_key(symbol, d))
                n += 1
        return n

    def get_states(self, symbols: Sequence[str]) -> dict[str, dict[str, Any]]:
        """Per-symbol `CAL#STATE` markers (`splitsCheckedAt`, ...); symbols without a marker are absent."""
        out: dict[str, dict[str, Any]] = {}
        for i in range(0, len(symbols), BATCH_GET_LIMIT):
            pending: dict[str, Any] | None = {
                self.table_name: {"Keys": [state_key(s) for s in symbols[i : i + BATCH_GET_LIMIT]]}
            }
            for attempt in range(MAX_UNPROCESSED_ATTEMPTS):
                if not pending:
                    break
                resp = aws.dynamodb().batch_get_item(RequestItems=pending)
                for item in resp.get("Responses", {}).get(self.table_name, []):
                    out[str(item["PK"]).removeprefix("TICKER#")] = item
                pending = resp.get("UnprocessedKeys") or None
                if pending:
                    time.sleep(min(2.0, 0.05 * 2**attempt))
        return out

    def put_state(self, symbol: str, **attrs: str) -> None:
        """Sets marker attributes (e.g. `splitsCheckedAt`) without touching the other attributes."""
        names = {f"#a{i}": k for i, k in enumerate(attrs)}
        values = {f":v{i}": v for i, v in enumerate(attrs.values())}
        assignments = ", ".join(f"#a{i} = :v{i}" for i in range(len(attrs)))
        self.table.update_item(
            Key=state_key(symbol),
            UpdateExpression=f"SET entityType = :entity, symbol = :symbol, {assignments}",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={**values, ":entity": ENTITY_CALENDAR_STATE, ":symbol": symbol},
        )

    def consume_budget(self, provider: str, day: str, calls: int, limit: int) -> bool:
        """Atomically spends `calls` of the provider's per-day budget; False (nothing spent) when it would
        exceed `limit`. One item per provider holds the day and the counter; a new day resets it."""
        if calls <= 0:
            return True
        if calls > limit:
            return False
        key = budget_key(provider)
        names = {"#day": "day", "#used": "used"}
        try:
            self.table.update_item(
                Key=key,
                UpdateExpression="SET entityType = :entity, #day = :day, #used = :calls",
                ConditionExpression="attribute_not_exists(#day) OR #day <> :day",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues={":entity": ENTITY_CALENDAR_BUDGET, ":day": day, ":calls": calls},
            )
            return True
        except ClientError as exc:
            if not _is_conditional_failure(exc):
                raise
        try:
            self.table.update_item(
                Key=key,
                UpdateExpression="ADD #used :calls",
                ConditionExpression="#day = :day AND #used <= :room",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues={":day": day, ":calls": calls, ":room": limit - calls},
            )
            return True
        except ClientError as exc:
            if not _is_conditional_failure(exc):
                raise
            return False
