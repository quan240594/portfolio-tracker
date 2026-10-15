"""DynamoDB access for the prices service (single table, layout per keys.py)."""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Sequence
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from . import aws
from .keys import (
    FX_DAY_PREFIX,
    TICKER_SK_PREFIX,
    TRACKED_PK,
    dividend_item,
    eod_item,
    fx_day_item,
    fx_item,
    fx_pk,
    profile_details,
    profile_item,
    profile_key,
    quote_from_item,
    quote_item,
    quote_key,
    tracked_item,
)
from .models import DividendEvent, EodPrice, FxDay, FxRates, InstrumentProfile, Quote

log = logging.getLogger(__name__)

BATCH_GET_LIMIT = 100


class Repository:
    def __init__(self, table_name: str) -> None:
        self.table_name = table_name
        self.table = aws.table(table_name)

    def list_tracked(self) -> list[str]:
        symbols: list[str] = []
        kwargs: dict[str, Any] = {"KeyConditionExpression": Key("PK").eq(TRACKED_PK)}
        while True:
            resp = self.table.query(**kwargs)
            for item in resp.get("Items", []):
                sk = str(item.get("SK", ""))
                symbol = item.get("symbol") or (
                    sk[len(TICKER_SK_PREFIX) :] if sk.startswith(TICKER_SK_PREFIX) else ""
                )
                if symbol:
                    symbols.append(str(symbol))
            if "LastEvaluatedKey" not in resp:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
        return sorted(set(symbols))

    def _batch_get(
        self, keys: Sequence[dict[str, str]], projection: str | None = None
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for i in range(0, len(keys), BATCH_GET_LIMIT):
            request: dict[str, Any] = {"Keys": list(keys[i : i + BATCH_GET_LIMIT])}
            if projection:
                request["ProjectionExpression"] = projection
            pending: dict[str, Any] = {self.table_name: request}
            attempt = 0
            while pending:
                resp = aws.dynamodb().batch_get_item(RequestItems=pending)
                out.extend(resp.get("Responses", {}).get(self.table_name, []))
                pending = resp.get("UnprocessedKeys") or {}
                if pending:
                    attempt += 1
                    time.sleep(min(2.0, 0.05 * 2**attempt))
        return out

    def latest_quotes(self, symbols: Sequence[str]) -> dict[str, Quote]:
        items = self._batch_get([quote_key(s) for s in symbols])
        out: dict[str, Quote] = {}
        for item in items:
            try:
                q = quote_from_item(item)
            except (KeyError, TypeError, ValueError):
                continue
            out[q.symbol] = q
        return out

    def symbols_with_profile(self, symbols: Sequence[str]) -> set[str]:
        items = self._batch_get([profile_key(s) for s in symbols], projection="PK")
        return {str(i["PK"]).removeprefix("TICKER#") for i in items}

    def stale_profile_details(self, symbols: Sequence[str], cutoff: str) -> list[str]:
        """Symbols with a PROFILE item whose optional details were never fetched or before `cutoff`
        (YYYY-MM-DD), never-fetched first."""
        if not symbols:
            return []
        items = self._batch_get([profile_key(s) for s in symbols], projection="PK, detailsAsOf")
        stale = [
            (str(i.get("detailsAsOf", "")), str(i["PK"]).removeprefix("TICKER#"))
            for i in items
            if str(i.get("detailsAsOf", "")) < cutoff
        ]
        return [symbol for _, symbol in sorted(stale)]

    def put_profile_details(self, symbol: str, profile: InstrumentProfile | None, as_of: str) -> None:
        """Stores only the optional details (+ their fetch date) on the existing PROFILE item, so a refresh
        can never degrade the name/sector/country written at enrichment. `profile` None = nothing found."""
        values = {**profile_details(profile), "detailsAsOf": as_of}
        names = {f"#f{i}": k for i, k in enumerate(values)}
        self.table.update_item(
            Key=profile_key(symbol),
            UpdateExpression="SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(values))),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={f":v{i}": v for i, v in enumerate(values.values())},
            ConditionExpression="attribute_exists(PK)",
        )

    def put_quote(self, quote: Quote) -> None:
        self.table.put_item(Item=quote_item(quote))

    def put_profile(self, profile: InstrumentProfile) -> None:
        self.table.put_item(Item=profile_item(profile))

    def put_fx(self, fx: FxRates) -> None:
        self.table.put_item(Item=fx_item(fx))

    def latest_fx_day(self, base: str) -> str | None:
        """Date (YYYY-MM-DD) of the most recent stored FX_DAY item for `base`, or None."""
        resp = self.table.query(
            KeyConditionExpression=Key("PK").eq(fx_pk(base)) & Key("SK").begins_with(FX_DAY_PREFIX),
            ScanIndexForward=False,
            Limit=1,
            ProjectionExpression="SK",
        )
        items = resp.get("Items", [])
        return str(items[0]["SK"])[len(FX_DAY_PREFIX) :] if items else None

    def put_fx_days(self, days: Iterable[FxDay]) -> int:
        return self._batch_put(fx_day_item(d) for d in days)

    def put_eods(self, rows: Iterable[EodPrice]) -> int:
        return self._batch_put(eod_item(r) for r in rows)

    def put_dividends(self, events: Iterable[DividendEvent]) -> int:
        return self._batch_put(dividend_item(e) for e in events)

    def _batch_put(self, items: Iterable[dict[str, Any]]) -> int:
        n = 0
        with self.table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as writer:
            for item in items:
                writer.put_item(Item=item)
                n += 1
        return n

    def ensure_tracked(self, symbol: str, added_at: str) -> bool:
        """Create the TRACKED item if absent. Returns True when it was created."""
        try:
            self.table.put_item(
                Item=tracked_item(symbol, added_at), ConditionExpression="attribute_not_exists(PK)"
            )
            return True
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
