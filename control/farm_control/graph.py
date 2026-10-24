"""Bubble-map graph (FRONTEND.md §3): sessions, rigs, devices, cameras and their edges."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .tailnet import farm_id_from_node


@dataclass
class RigView:
    rig_id: str
    online: bool
    state: dict[str, Any] | None  # C3 /v1/state snapshot, or None if never reached


@dataclass
class SessionView:
    farm_id: str
    title: str
    ticket_id: str
    status: str
    data: dict[str, Any]


def session_node_id(holder: str) -> tuple[str, str]:
    """Map a lease holder (tailnet node name) to its session node id and farm id."""
    farm_id = farm_id_from_node(holder) or holder
    return f"session:{farm_id}", farm_id


def build_graph(rigs: list[RigView], sessions: list[SessionView], *, public: bool = False,
                mode: str = "live") -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    session_ids: set[str] = set()

    for s in sessions:
        sid = f"session:{s.farm_id}"
        session_ids.add(sid)
        data = {"ticket_id": s.ticket_id, "online": s.data.get("online", False), "acus": s.data.get("acus", 0)}
        if not public:
            data.update(s.data)
        nodes.append({"id": sid, "kind": "session", "label": s.ticket_id if public else s.title,
                      "status": s.status, "data": data})

    def ensure_holder(holder: str) -> str:
        sid, farm_id = session_node_id(holder)
        if sid not in session_ids:  # a lease held by a node control didn't create (team laptop, older session)
            session_ids.add(sid)
            nodes.append({"id": sid, "kind": "session", "label": farm_id, "status": "external",
                          "data": {"node_name": holder, "external": True}})
        return sid

    for rig in rigs:
        rid = f"rig:{rig.rig_id}"
        state = rig.state or {}
        info = dict(state.get("rig") or {})
        rig_status = "offline" if not rig.online else ("maintenance" if info.get("maintenance") else "online")
        info.pop("devices", None)
        nodes.append({"id": rid, "kind": "rig", "label": rig.rig_id, "status": rig_status, "data": info})

        camera = state.get("camera") or {}
        cam_id = f"camera:{rig.rig_id}"
        cam_ok = rig.online and bool(camera.get("ok"))
        nodes.append({"id": cam_id, "kind": "camera", "parent": rid, "label": "camera",
                      "status": "offline" if not rig.online else ("ok" if cam_ok else "down"), "data": camera})

        for order, dev in enumerate(state.get("devices") or []):
            dev_name = dev.get("id", "")
            did = f"device:{rig.rig_id}/{dev_name}"
            status = dev.get("status", "offline") if rig.online else "offline"
            lease = dev.get("lease") if rig.online else None
            queue = (dev.get("queue") or []) if rig.online else []
            data: dict[str, Any] = {
                "type": dev.get("type"), "order": order, "outputs": dev.get("outputs", []), "holder": dev.get("holder"),
                "queue_depth": len(queue), "last_verdict": dev.get("last_verdict"),
                "snapshot_path": f"rigs/{rig.rig_id}/devices/{dev_name}/snapshot.jpg",
            }
            if lease:
                data["lease"] = {k: lease.get(k) for k in ("lease_id", "holder", "token", "granted_at", "expires_at")}
            nodes.append({"id": did, "kind": "device", "parent": rid, "label": dev_name, "status": status, "data": data})
            edges.append({"id": f"attached:{rig.rig_id}/{dev_name}", "kind": "attached", "source": rid, "target": did})
            if cam_ok and status != "offline":
                edges.append({"id": f"watches:{rig.rig_id}/{dev_name}", "kind": "watches",
                              "source": cam_id, "target": did})
            if lease and lease.get("holder"):
                edges.append({"id": f"lease:{lease.get('lease_id')}", "kind": "lease",
                              "source": ensure_holder(lease["holder"]), "target": did,
                              "data": {"token": lease.get("token"), "expires_at": lease.get("expires_at")}})
            for q in queue:
                if q.get("holder"):
                    edges.append({"id": f"queue:{q.get('lease_id')}", "kind": "queue",
                                  "source": ensure_holder(q["holder"]), "target": did,
                                  "data": {"position": q.get("position")}})
    return {"nodes": nodes, "edges": edges, "mode": mode}
