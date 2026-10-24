// Demo topology shared by mock mode, fixtures and component development:
// 3 sessions, 2 rigs (rig-2 in mock-driver mode), 5 devices. Matches FRONTEND §3 IDs.
import type { Graph } from "../state/types";

export const T0 = 1_761_300_000; // fixture epoch (Unix s)

export const sampleGraph: Graph = {
  nodes: [
    { id: "session:s-1a2b3c4d", kind: "session", label: "pico/led-sequence-trap", status: "running", data: { farm_id: "s-1a2b3c4d", node_name: "devin-s-1a2b3c4d", acus: 1.4, url: "https://app.devin.ai/sessions/demo-a", created_at: T0 } },
    { id: "session:s-5e6f7a8b", kind: "session", label: "unoq/matrix-heart", status: "running", data: { farm_id: "s-5e6f7a8b", node_name: "devin-s-5e6f7a8b", acus: 0.9, url: "https://app.devin.ai/sessions/demo-b", created_at: T0 + 20 } },
    { id: "session:s-9c0d1e2f", kind: "session", label: "pico/led-sequence", status: "running", data: { farm_id: "s-9c0d1e2f", node_name: "devin-s-9c0d1e2f", acus: 0.3, url: "https://app.devin.ai/sessions/demo-c", created_at: T0 + 45 } },

    { id: "rig:rig-1", kind: "rig", label: "rig-1", status: "online", data: { model: "Jetson Orin Nano", temp_c: 48.5, load1: 0.62, mem_free_mb: 2210, throttled: false, camera_ok: true, verifier_online: true, maintenance: false } },
    { id: "device:rig-1/pico-1", kind: "device", parent: "rig:rig-1", label: "pico-1", status: "leased", data: { type: "pico", order: 0, holder: "devin-s-1a2b3c4d", queue_depth: 1, outputs: ["pico.leds"] } },
    { id: "device:rig-1/unoq-1", kind: "device", parent: "rig:rig-1", label: "unoq-1", status: "leased", data: { type: "unoq", order: 1, holder: "devin-s-5e6f7a8b", queue_depth: 0, outputs: ["unoq.matrix", "unoq.rgb1"] } },
    { id: "device:rig-1/pico-3", kind: "device", parent: "rig:rig-1", label: "pico-3", status: "free", data: { type: "pico", order: 2, queue_depth: 0, outputs: ["pico.leds"] } },
    { id: "camera:rig-1", kind: "camera", parent: "rig:rig-1", label: "cam0", status: "ok", data: { fps: 30 } },

    { id: "rig:rig-2", kind: "rig", label: "rig-2", status: "online", data: { model: "mock", mock: true, temp_c: 41.0, load1: 0.1, mem_free_mb: 6000, throttled: false, camera_ok: true, verifier_online: true, maintenance: false } },
    { id: "device:rig-2/pico-2", kind: "device", parent: "rig:rig-2", label: "pico-2", status: "free", data: { type: "pico", order: 0, queue_depth: 0, outputs: ["pico.leds"] } },
    { id: "device:rig-2/unoq-2", kind: "device", parent: "rig:rig-2", label: "unoq-2", status: "offline", data: { type: "unoq", order: 1, queue_depth: 0, reason: "idle not confirmed" } },
    { id: "camera:rig-2", kind: "camera", parent: "rig:rig-2", label: "cam0", status: "ok", data: { fps: 30 } },
  ],
  edges: [
    { id: "attached:rig-1/pico-1", kind: "attached", source: "rig:rig-1", target: "device:rig-1/pico-1" },
    { id: "attached:rig-1/unoq-1", kind: "attached", source: "rig:rig-1", target: "device:rig-1/unoq-1" },
    { id: "attached:rig-1/pico-3", kind: "attached", source: "rig:rig-1", target: "device:rig-1/pico-3" },
    { id: "attached:rig-2/pico-2", kind: "attached", source: "rig:rig-2", target: "device:rig-2/pico-2" },
    { id: "attached:rig-2/unoq-2", kind: "attached", source: "rig:rig-2", target: "device:rig-2/unoq-2" },
    { id: "watches:rig-1/pico-1", kind: "watches", source: "camera:rig-1", target: "device:rig-1/pico-1" },
    { id: "watches:rig-1/unoq-1", kind: "watches", source: "camera:rig-1", target: "device:rig-1/unoq-1" },
    { id: "watches:rig-1/pico-3", kind: "watches", source: "camera:rig-1", target: "device:rig-1/pico-3" },
    { id: "watches:rig-2/pico-2", kind: "watches", source: "camera:rig-2", target: "device:rig-2/pico-2" },
    { id: "lease:L-a1", kind: "lease", source: "session:s-1a2b3c4d", target: "device:rig-1/pico-1", data: { token: 17, expires_at: T0 + 300 } },
    { id: "lease:L-b1", kind: "lease", source: "session:s-5e6f7a8b", target: "device:rig-1/unoq-1", data: { token: 4, expires_at: T0 + 320 } },
    { id: "queue:L-c1", kind: "queue", source: "session:s-9c0d1e2f", target: "device:rig-1/pico-1", data: { position: 1 } },
  ],
};
