import json

import httpx
import pytest

from farm_control.config import Settings, check_bind_host
from farm_control.devin import DevinClient
from farm_control.events import iter_sse
from farm_control.tailnet import TailscaleAPI, farm_id_from_node, parse_status


async def _lines(text):
    for line in text.split("\n"):
        yield line


@pytest.mark.anyio
async def test_sse_parser_handles_comments_crlf_and_multiline_data():
    raw = ": keepalive\n\nevent: lease\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata: plain\n\nevent: x\n"
    got = [e async for e in iter_sse(_lines(raw))]
    assert got == [("lease", '{"a":\n1}'), ("message", "plain")]  # trailing event without blank line is not dispatched


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.5", "8.8.8.8", "localhost"])
def test_bind_refuses_non_loopback_non_tailnet(host):
    with pytest.raises(ValueError):
        check_bind_host(host)


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "100.101.102.103", "fd7a:115c:a1e0::1"])
def test_bind_accepts_loopback_and_tailnet(host):
    check_bind_host(host)


def test_open_operator_auth_is_refused_outside_mock_mode():
    with pytest.raises(ValueError):
        Settings(operator_auth="open").validate()
    Settings(operator_auth="open", mode="mock").validate()


def test_farm_id_from_node_accepts_magicdns_suffix_only():
    assert farm_id_from_node("devin-s-1a2b3c4d") == "s-1a2b3c4d"
    assert farm_id_from_node("devin-s-1a2b3c4d-2") == "s-1a2b3c4d"
    assert farm_id_from_node("devin-s-1a2b3c4dx") is None
    assert farm_id_from_node("rig-1") is None


def test_parse_status_prefers_magicdns_name():
    doc = {"Peer": {"k1": {"HostName": "jetson", "DNSName": "rig-1.tail1234.ts.net.", "TailscaleIPs": ["100.64.0.5", "fd7a::5"],
                           "Tags": ["tag:rig"], "Online": True, "ID": "n1"}}}
    (peer,) = parse_status(doc)
    assert (peer.hostname, peer.ipv4(), peer.tags, peer.online) == ("rig-1", "100.64.0.5", ["tag:rig"], True)


@pytest.mark.anyio
async def test_devin_client_prefixes_session_ids_once():
    paths = []

    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json={"items": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        c = DevinClient("https://api.example", "k", "org-1", http)
        await c.get_session("abc123")
        await c.get_session("devin-abc123")
        await c.list_messages("abc123", after="cur")
    assert paths == ["/v3/organizations/org-1/sessions/devin-abc123"] * 2 + \
        ["/v3/organizations/org-1/sessions/devin-abc123/messages"]


@pytest.mark.anyio
async def test_delete_nodes_removes_only_that_sessions_nodes():
    devices = [{"nodeId": "a", "hostname": "x", "name": "devin-s-0000000a.tn.ts.net"},
               {"nodeId": "b", "hostname": "y", "name": "devin-s-0000000a-1.tn.ts.net"},
               {"nodeId": "c", "hostname": "z", "name": "devin-s-0000000ab.tn.ts.net"},
               {"nodeId": "d", "hostname": "rig-1", "name": "rig-1.tn.ts.net"}]
    deleted = []

    def handler(request):
        if request.url.path == "/api/v2/oauth/token":
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET":
            return httpx.Response(200, json={"devices": devices})
        deleted.append(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        api = TailscaleAPI("https://ts.example", "id", "secret", http)
        assert await api.delete_nodes("devin-s-0000000a") == 2
    assert deleted == ["a", "b"]


@pytest.mark.anyio
async def test_minted_key_is_one_off_ephemeral_preauthorized_and_tagged():
    bodies = []

    def handler(request):
        if request.url.path == "/api/v2/oauth/token":
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "k1", "key": "secret-key"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        key_id, key = await TailscaleAPI("https://ts.example", "id", "s", http).mint_session_key("s-1", "tag:devin-session")
    assert (key_id, key) == ("k1", "secret-key")
    create = bodies[0]["capabilities"]["devices"]["create"]
    assert create == {"reusable": False, "ephemeral": True, "preauthorized": True, "tags": ["tag:devin-session"]}
    assert bodies[0]["expirySeconds"] == 3600
