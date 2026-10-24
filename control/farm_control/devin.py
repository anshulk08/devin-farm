"""Devin API v3 client (create, get, messages, send, archive). Docs: docs.devin.ai/api-reference/v3."""
from __future__ import annotations

from typing import Any

import httpx


class DevinError(RuntimeError):
    def __init__(self, status: int, detail: str):
        super().__init__(f"Devin API HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def devin_id(session_id: str) -> str:
    """Path parameter form: the session id prefixed with `devin-`."""
    return session_id if session_id.startswith("devin-") else f"devin-{session_id}"


class DevinClient:
    def __init__(self, base: str, api_key: str, org_id: str, http: httpx.AsyncClient):
        self._base = f"{base.rstrip('/')}/v3/organizations/{org_id}"
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._http = http

    async def _req(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        r = await self._http.request(method, f"{self._base}{path}", headers=self._headers, **kw)
        if r.status_code >= 400:
            try:
                body = r.json()
                detail = body.get("detail") or body.get("title") or r.text
            except ValueError:
                detail = r.text
            raise DevinError(r.status_code, str(detail)[:300])
        return r.json() if r.content else {}

    async def create_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._req("POST", "/sessions", json=payload)

    async def get_session(self, session_id: str) -> dict[str, Any]:
        return await self._req("GET", f"/sessions/{devin_id(session_id)}")

    async def list_sessions(self, first: int = 1) -> dict[str, Any]:
        return await self._req("GET", "/sessions", params={"first": first})

    async def list_messages(self, session_id: str, after: str | None = None, first: int = 100) -> dict[str, Any]:
        params: dict[str, Any] = {"first": first}
        if after:
            params["after"] = after
        return await self._req("GET", f"/sessions/{devin_id(session_id)}/messages", params=params)

    async def send_message(self, session_id: str, text: str) -> dict[str, Any]:
        return await self._req("POST", f"/sessions/{devin_id(session_id)}/messages", json={"message": text})

    async def archive(self, session_id: str) -> dict[str, Any]:
        return await self._req("POST", f"/sessions/{devin_id(session_id)}/archive")
