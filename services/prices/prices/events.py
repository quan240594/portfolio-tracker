"""EventBridge publishing — mirrors packages/shared/src/events.ts."""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Literal

from botocore.exceptions import BotoCoreError, ClientError

from . import aws

log = logging.getLogger(__name__)

SOURCE_PRICES = "portfolio.prices"
DETAIL_TYPE_PRICES_UPDATED = "PricesUpdated"
DETAIL_TYPE_TRANSACTIONS_CHANGED = "TransactionsChanged"
MAX_SYMBOLS_PER_EVENT = 500

Trigger = Literal["scheduled", "enrichment"]


def prices_updated_detail(symbols: Sequence[str], as_of: str, trigger: Trigger) -> dict[str, object]:
    return {"symbols": list(symbols), "asOf": as_of, "trigger": trigger}


class EventPublisher:
    def __init__(self, bus_name: str) -> None:
        self.bus_name = bus_name

    def prices_updated(self, symbols: Sequence[str], as_of: str, trigger: Trigger) -> bool:
        """Publish PricesUpdated (chunked). Returns False (and logs) on failure instead of raising:
        the DynamoDB writes already happened and are the source of truth."""
        if not symbols:
            return True
        ordered = sorted(set(symbols))
        entries = [
            {
                "Source": SOURCE_PRICES,
                "DetailType": DETAIL_TYPE_PRICES_UPDATED,
                "Detail": json.dumps(
                    prices_updated_detail(ordered[i : i + MAX_SYMBOLS_PER_EVENT], as_of, trigger)
                ),
                "EventBusName": self.bus_name,
            }
            for i in range(0, len(ordered), MAX_SYMBOLS_PER_EVENT)
        ]
        ok = True
        for i in range(0, len(entries), 10):
            try:
                resp = aws.client("events").put_events(Entries=entries[i : i + 10])
            except (ClientError, BotoCoreError) as exc:
                log.error("PutEvents failed", extra={"error": str(exc), "bus": self.bus_name})
                ok = False
                continue
            if resp.get("FailedEntryCount"):
                log.error(
                    "PutEvents partial failure", extra={"entries": resp.get("Entries"), "bus": self.bus_name}
                )
                ok = False
        if ok:
            log.info("PricesUpdated published", extra={"trigger": trigger, "count": len(ordered)})
        return ok
