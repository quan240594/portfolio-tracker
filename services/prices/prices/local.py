"""Run the handlers locally against LocalStack.

    python -m prices.local refresh [SYMBOL ...] [--all-hours]
    python -m prices.local enrich SYMBOL [SYMBOL ...]
    python -m prices.local fx-backfill [--start YYYY-MM-DD]

Defaults: AWS_ENDPOINT_URL=http://localhost:4566, TABLE_NAME / EVENT_BUS_NAME=portfolio-tracker-local,
region eu-west-1, dummy credentials, MARKET_DATA_PROVIDER=mock. Existing env vars win.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from collections.abc import Sequence
from datetime import UTC, date
from types import SimpleNamespace

LOCAL_DEFAULTS = {
    "AWS_ENDPOINT_URL": "http://localhost:4566",
    "AWS_REGION": "eu-west-1",
    "AWS_DEFAULT_REGION": "eu-west-1",
    "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test",
    "TABLE_NAME": "portfolio-tracker-local",
    "EVENT_BUS_NAME": "portfolio-tracker-local",
    "MARKET_DATA_PROVIDER": "mock",
    "LOG_LEVEL": "INFO",
}


def apply_local_env() -> None:
    for key, value in LOCAL_DEFAULTS.items():
        os.environ.setdefault(key, value)


def sqs_event(symbols: Sequence[str]) -> dict[str, object]:
    envelope = {
        "version": "0",
        "id": str(uuid.uuid4()),
        "detail-type": "TransactionsChanged",
        "source": "portfolio.local",
        "detail": {"userId": "demo", "symbols": list(symbols), "reason": "CREATED"},
    }
    return {"Records": [{"messageId": str(uuid.uuid4()), "body": json.dumps(envelope)}]}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m prices.local", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    refresh = sub.add_parser("refresh", help="run scheduled_refresh (optionally tracking SYMBOLs first)")
    refresh.add_argument("symbols", nargs="*")
    refresh.add_argument("--all-hours", action="store_true", help="ignore EU_REFRESH_HOURS gating")
    enrich = sub.add_parser("enrich", help="run on_transactions_changed for SYMBOLs")
    enrich.add_argument("symbols", nargs="+")
    backfill = sub.add_parser(
        "fx-backfill",
        help="store daily ECB fixings (FX_DAY) up to today; default start: day after the latest stored "
        "fixing, else FX_HISTORY_START",
    )
    backfill.add_argument("--start", type=date.fromisoformat, metavar="YYYY-MM-DD", help="force start date")
    args = parser.parse_args(argv)

    apply_local_env()
    if getattr(args, "all_hours", False):
        os.environ["EU_REFRESH_HOURS"] = ",".join(str(h) for h in range(24))

    from . import aws, handlers, secrets
    from .models import iso_datetime
    from .symbols import normalize

    aws.reset()
    secrets.clear_cache()
    handlers.reset()
    context = SimpleNamespace(aws_request_id=f"local-{uuid.uuid4()}")
    symbols = [normalize(s) for s in getattr(args, "symbols", [])]

    if args.command == "fx-backfill":
        today = handlers.utcnow().astimezone(UTC).date()
        result = handlers.backfill_fx_history(handlers.get_deps(), today, args.start)
    elif args.command == "refresh":
        if symbols:
            repo = handlers.get_deps().repo
            now = iso_datetime(handlers.utcnow())
            for s in symbols:
                repo.ensure_tracked(s, now)
        result = handlers.scheduled_refresh({}, context)
    else:
        result = handlers.on_transactions_changed(sqs_event(symbols), context)
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
