"""Rig configuration: /etc/farm/rig.yaml (or $FARM_RIG_CONFIG / --config). See rig.example.yaml."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG = "/etc/farm/rig.yaml"
DEFAULT_LIB_ALLOWLIST = ["Arduino_LED_Matrix", "Arduino_RouterBridge", "Arduino_Modulino"]
MOCK_DEVICES = [
    {"id": "pico-1", "type": "pico", "path": None, "order": 1},
    {"id": "unoq-1", "type": "unoq", "path": None, "order": 2},
]


@dataclass
class RigConfig:
    rig_id: str = "rig-1"
    verifier_url: str = "http://127.0.0.1:8090"
    team_logins: list[str] = field(default_factory=list)
    unoq_library_allowlist: list[str] = field(default_factory=lambda: list(DEFAULT_LIB_ALLOWLIST))
    devices: list[dict[str, Any]] = field(default_factory=list)


def load_config(path: str | None, mock: bool) -> RigConfig:
    path = path or os.environ.get("FARM_RIG_CONFIG") or (DEFAULT_CONFIG if Path(DEFAULT_CONFIG).exists() else None)
    raw: dict[str, Any] = {}
    if path:
        raw = yaml.safe_load(Path(path).read_text()) or {}
    elif not mock:
        raise SystemExit(f"no rig config: create {DEFAULT_CONFIG} or pass --config / $FARM_RIG_CONFIG")
    cfg = RigConfig(
        rig_id=str(raw.get("rig_id", "rig-1")),
        verifier_url=str(raw.get("verifier_url", "http://127.0.0.1:8090")),
        team_logins=list(raw.get("team_logins") or []),
        unoq_library_allowlist=list(raw.get("unoq_library_allowlist") or DEFAULT_LIB_ALLOWLIST),
        devices=list(raw.get("devices") or []),
    )
    if not cfg.devices:
        if not mock:
            raise SystemExit("rig config has no devices")
        cfg.devices = [dict(d) for d in MOCK_DEVICES]
    ids = [d["id"] for d in cfg.devices]
    if len(set(ids)) != len(ids):
        raise SystemExit("duplicate device ids in rig config")
    for d in cfg.devices:
        if d.get("type") not in ("pico", "unoq"):
            raise SystemExit(f"device {d.get('id')}: unsupported type {d.get('type')!r}")
    return cfg
