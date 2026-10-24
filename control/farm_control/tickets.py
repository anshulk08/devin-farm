"""Ticket catalog (CONTRACTS C9): every directory under the tickets root holding farm.yaml + TICKET.md.
Only TICKET.md (the public text) is read; assertions.json and reference/ stay hidden."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Ticket:
    ticket_id: str
    title: str
    device_type: str
    outputs: tuple[str, ...]
    text: str


def _title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


class TicketCatalog:
    def __init__(self, root: Path):
        self.root = root

    def list(self) -> list[Ticket]:
        if not self.root.is_dir():
            return []
        tickets = []
        for farm_yaml in sorted(self.root.rglob("farm.yaml")):
            ticket_dir = farm_yaml.parent
            if "reference" in ticket_dir.relative_to(self.root).parts:
                continue
            ticket_md = ticket_dir / "TICKET.md"
            if not ticket_md.is_file():
                continue
            meta = yaml.safe_load(farm_yaml.read_text(encoding="utf-8")) or {}
            text = ticket_md.read_text(encoding="utf-8")
            ticket_id = ticket_dir.relative_to(self.root).as_posix()
            tickets.append(Ticket(ticket_id=ticket_id, title=_title(text, ticket_id),
                                  device_type=str(meta.get("device_type", "")),
                                  outputs=tuple(meta.get("outputs") or ()), text=text))
        return tickets

    def get(self, ticket_id: str) -> Ticket | None:
        return next((t for t in self.list() if t.ticket_id == ticket_id), None)
