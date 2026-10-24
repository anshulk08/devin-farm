"""Event fan-out (C4), ndjson recording for replays, and SSE encode/decode."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Event:
    name: str
    data: dict[str, Any]


def encode_sse(name: str, data: dict[str, Any]) -> str:
    # json.dumps escapes newlines, so the payload is always a single data line.
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def iter_sse(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str, str]]:
    """Parse an SSE line stream into (event, data) pairs (WHATWG event-stream rules)."""
    name, data = "", []
    async for raw in lines:
        line = raw.rstrip("\r")
        if not line:
            if data:
                yield name or "message", "\n".join(data)
            name, data = "", []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            name = value
        elif field == "data":
            data.append(value)


class Recorder:
    """Appends every event to var/events-YYYYMMDD.ndjson so any run can become a replay."""

    def __init__(self, directory: Path):
        self._dir = directory
        self._day = ""
        self._fh: IO[str] | None = None

    def write(self, event: Event) -> None:
        day = time.strftime("%Y%m%d", time.gmtime())
        if day != self._day or self._fh is None:
            self.close()
            self._dir.mkdir(parents=True, exist_ok=True)
            self._fh = open(self._dir / f"events-{day}.ndjson", "a", encoding="utf-8")
            self._day = day
        self._fh.write(json.dumps({"ts": event.data.get("ts", time.time()), "event": event.name, "data": event.data},
                                  separators=(",", ":")) + "\n")
        self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None


class Subscription:
    def __init__(self, maxsize: int):
        self.queue: asyncio.Queue[Event] = asyncio.Queue(maxsize)
        self.dropped = False


class EventBus:
    """In-process fan-out. A subscriber that falls behind is dropped; its client reconnects
    and gets a fresh graph_snapshot instead of a silently gappy stream."""

    def __init__(self, recorder: Recorder | None = None):
        self._recorder = recorder
        self._subs: set[Subscription] = set()

    def publish(self, name: str, data: dict[str, Any]) -> Event:
        data.setdefault("ts", time.time())
        event = Event(name, data)
        if self._recorder is not None:
            try:
                self._recorder.write(event)
            except OSError:
                log.exception("event recorder write failed")
        for sub in list(self._subs):
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                sub.dropped = True
                self._subs.discard(sub)
        return event

    def subscribe(self, maxsize: int = 2000) -> Subscription:
        sub = Subscription(maxsize)
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        self._subs.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)
