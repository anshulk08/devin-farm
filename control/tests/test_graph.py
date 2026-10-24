from farm_control.graph import RigView, SessionView, build_graph


def _state(devices, camera_ok=True):
    return {"rig": {"rig_id": "rig-1", "temp_c": 50, "maintenance": False}, "devices": devices,
            "camera": {"ok": camera_ok, "fps": 30, "last_frame_age_s": 0.03}}


def _dev(dev_id, status="free", lease=None, queue=()):
    return {"id": dev_id, "type": "pico", "status": status, "outputs": ["pico.led"], "lease": lease,
            "queue": list(queue), "holder": (lease or {}).get("holder")}


def _session(farm_id, ticket="pico-blink"):
    return SessionView(farm_id=farm_id, title=f"farm {ticket} {farm_id}", ticket_id=ticket, status="running",
                       data={"url": "https://app.devin.ai/sessions/x", "devin_session_id": "abc", "online": True})


def _edges(g, kind):
    return sorted((e["source"], e["target"], e.get("data")) for e in g["edges"] if e["kind"] == kind)


def test_lease_and_queue_edges_point_from_holder_session_to_device():
    lease = {"lease_id": "l1", "holder": "devin-s-0000000a", "token": 17, "expires_at": 99.0}
    queue = [{"lease_id": "l2", "holder": "devin-s-0000000b", "position": 1},
             {"lease_id": "l3", "holder": "devin-s-0000000c", "position": 2}]
    rig = RigView("rig-1", True, _state([_dev("pico-1", "leased", lease, queue), _dev("unoq-1")]))
    g = build_graph([rig], [_session("s-0000000a"), _session("s-0000000b"), _session("s-0000000c")])

    assert _edges(g, "lease") == [("session:s-0000000a", "device:rig-1/pico-1", {"token": 17, "expires_at": 99.0})]
    assert _edges(g, "queue") == [("session:s-0000000b", "device:rig-1/pico-1", {"position": 1}),
                                  ("session:s-0000000c", "device:rig-1/pico-1", {"position": 2})]
    devices = [n["id"] for n in g["nodes"] if n["kind"] == "device"]
    assert devices == ["device:rig-1/pico-1", "device:rig-1/unoq-1"]  # bench order preserved
    assert {e["target"] for e in g["edges"] if e["kind"] == "watches"} == set(devices)


def test_offline_rig_shows_devices_offline_without_leases_or_camera_edges():
    lease = {"lease_id": "l1", "holder": "devin-s-0000000a", "token": 3}
    rig = RigView("rig-1", False, _state([_dev("pico-1", "leased", lease)]))
    g = build_graph([rig], [_session("s-0000000a")])

    by_id = {n["id"]: n for n in g["nodes"]}
    assert by_id["rig:rig-1"]["status"] == "offline"
    assert by_id["device:rig-1/pico-1"]["status"] == "offline"
    assert by_id["camera:rig-1"]["status"] == "offline"
    assert not [e for e in g["edges"] if e["kind"] in ("lease", "queue", "watches")]
    assert _edges(g, "attached") == [("rig:rig-1", "device:rig-1/pico-1", None)]


def test_holders_control_did_not_create_become_external_sessions():
    lease = {"lease_id": "l1", "holder": "adrian-laptop", "token": 1}
    queue = [{"lease_id": "l2", "holder": "devin-s-0000000b-1", "position": 1}]  # MagicDNS-deduplicated name
    rig = RigView("rig-1", True, _state([_dev("pico-1", "leased", lease, queue)]))
    g = build_graph([rig], [_session("s-0000000b")])

    sessions = {n["id"]: n for n in g["nodes"] if n["kind"] == "session"}
    assert sessions["session:adrian-laptop"]["status"] == "external"
    assert _edges(g, "queue")[0][0] == "session:s-0000000b"
    assert len(sessions) == 2


def test_public_graph_hides_transcript_links_and_titles():
    rig = RigView("rig-1", True, _state([_dev("pico-1")]))
    g = build_graph([rig], [_session("s-0000000a")], public=True)
    node = next(n for n in g["nodes"] if n["kind"] == "session")
    assert node["label"] == "pico-blink"
    assert "url" not in node["data"] and "devin_session_id" not in node["data"]


def test_camera_down_drops_watches_edges():
    rig = RigView("rig-1", True, _state([_dev("pico-1")], camera_ok=False))
    g = build_graph([rig], [])
    assert not _edges(g, "watches")
    assert next(n for n in g["nodes"] if n["kind"] == "camera")["status"] == "down"
