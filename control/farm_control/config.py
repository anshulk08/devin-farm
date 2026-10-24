"""Runtime settings, read from the environment (never from committed files)."""
from __future__ import annotations

import dataclasses
import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

CONTROL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = CONTROL_DIR.parent

_TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
_TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _path(name: str, default: Path) -> Path:
    value = _env(name)
    return Path(value).expanduser() if value else default


def check_bind_host(host: str) -> None:
    """C0: services bind loopback or the tailnet address, never all interfaces."""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError(f"bind host must be an IP literal, got {host!r}") from exc
    if addr.is_loopback or addr in _TAILNET_V4 or addr in _TAILNET_V6:
        return
    raise ValueError(f"refusing to bind {host}: use 127.0.0.1 (behind tailscale serve/funnel) or the tailnet IP")


@dataclass
class Settings:
    mode: str = "live"  # "live" | "mock"; mock is always labelled in graph/events
    operator_host: str = "127.0.0.1"
    operator_port: int = 8700
    public_host: str = "127.0.0.1"
    public_port: int = 8701
    operator_auth: str = "tailscale"  # "tailscale" (Tailscale-User-Login allowlist) | "open" (mock/dev only)
    team_logins: frozenset[str] = frozenset()
    public_url: str = ""  # https://<control>.<tailnet>.ts.net, for absolute evidence/OpenGraph links
    var_dir: Path = CONTROL_DIR / "var"
    web_dist: Path = REPO_ROOT / "web" / "dist"
    web_public_dist: Path = REPO_ROOT / "web" / "dist-public"
    tickets_dir: Path = REPO_ROOT / "tickets"
    claim_schema_path: Path = REPO_ROOT / "session-kit" / "claim.schema.json"
    tickets_repo: str = ""
    kit_repo: str = "https://github.com/anshulk08/devin-farm"
    playbook_id: str = ""
    acu_cap: float = 50.0
    default_max_acu: int = 5
    devin_api_base: str = "https://api.devin.ai"
    devin_api_key: str = field(default="", repr=False)
    devin_org_id: str = ""
    ts_api_base: str = "https://api.tailscale.com"
    ts_client_id: str = ""
    ts_client_secret: str = field(default="", repr=False)
    ts_tailnet: str = "-"
    rig_tag: str = "tag:rig"
    session_tag: str = "tag:devin-session"
    rig_control_port: int = 8081
    discovery_interval_s: float = 10.0
    devin_poll_interval_s: float = 5.0
    rig_read_timeout_s: float = 20.0
    mock_identity: str = ""  # when set, calls to rigs carry X-Mock-Node (rigd --mock-identity)

    @classmethod
    def from_env(cls) -> Settings:
        d = cls()
        logins = _env("FARM_TEAM_LOGINS")
        return dataclasses.replace(
            d,
            operator_host=_env("FARM_OPERATOR_HOST", d.operator_host),
            operator_port=int(_env("FARM_OPERATOR_PORT", str(d.operator_port))),
            public_host=_env("FARM_PUBLIC_HOST", d.public_host),
            public_port=int(_env("FARM_PUBLIC_PORT", str(d.public_port))),
            operator_auth=_env("FARM_OPERATOR_AUTH", d.operator_auth),
            team_logins=frozenset(x.strip().lower() for x in logins.split(",") if x.strip()),
            public_url=_env("FARM_PUBLIC_URL").rstrip("/"),
            var_dir=_path("FARM_VAR_DIR", d.var_dir),
            web_dist=_path("FARM_WEB_DIST", d.web_dist),
            web_public_dist=_path("FARM_WEB_PUBLIC_DIST", d.web_public_dist),
            tickets_dir=_path("FARM_TICKETS_DIR", d.tickets_dir),
            claim_schema_path=_path("FARM_CLAIM_SCHEMA", d.claim_schema_path),
            tickets_repo=_env("FARM_TICKETS_REPO"),
            kit_repo=_env("FARM_KIT_REPO", d.kit_repo),
            playbook_id=_env("FARM_PLAYBOOK_ID"),
            acu_cap=float(_env("FARM_ACU_CAP", str(d.acu_cap))),
            default_max_acu=int(_env("FARM_MAX_ACU_DEFAULT", str(d.default_max_acu))),
            devin_api_base=_env("DEVIN_API_BASE", d.devin_api_base).rstrip("/"),
            devin_api_key=_env("DEVIN_API_KEY"),
            devin_org_id=_env("DEVIN_ORG_ID"),
            ts_api_base=_env("TS_API_BASE", d.ts_api_base).rstrip("/"),
            ts_client_id=_env("TS_OAUTH_CLIENT_ID"),
            ts_client_secret=_env("TS_OAUTH_CLIENT_SECRET"),
            ts_tailnet=_env("TS_TAILNET", d.ts_tailnet),
            rig_control_port=int(_env("FARM_RIG_CONTROL_PORT", str(d.rig_control_port))),
        )

    def validate(self) -> None:
        check_bind_host(self.operator_host)
        check_bind_host(self.public_host)
        if self.operator_auth not in ("tailscale", "open"):
            raise ValueError("FARM_OPERATOR_AUTH must be 'tailscale' or 'open'")
        if self.operator_auth == "open" and self.mode != "mock":
            raise ValueError("FARM_OPERATOR_AUTH=open is only allowed in mock mode")
        if self.acu_cap <= 0 or self.default_max_acu <= 0:
            raise ValueError("FARM_ACU_CAP and FARM_MAX_ACU_DEFAULT must be positive")

    @property
    def devin_configured(self) -> bool:
        return bool(self.devin_api_key and self.devin_org_id)

    @property
    def tailscale_api_configured(self) -> bool:
        return bool(self.ts_client_id and self.ts_client_secret)
