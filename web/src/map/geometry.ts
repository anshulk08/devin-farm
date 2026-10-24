// Fixed sizes for every bubble (flow units). Bubbles never resize with state, so the layout never has to move.
export const SESSION_D = 88; // session circle diameter
export const SESSION_W = 200; // session node box (circle + title underneath)
export const SESSION_H = SESSION_D + 52;

export const DEVICE_D = 112; // device circle (≥ 96 px thumbnail at 1080p / 100 %)
export const DEVICE_W = 148;
export const DEVICE_H = DEVICE_D + 50;

export const CAMERA_D = 44;
export const CAMERA_W = 96;
export const CAMERA_H = CAMERA_D + 24;

export const RIG_PAD_X = 40;
/** Name plate with health pills, at the bottom of the rig so lease lines plug straight into the devices. */
export const RIG_FOOT_H = 60;
export const RIG_SLOT_GAP = 36; // gap between device boxes; the USB port stub sits in it
export const RIG_DEVICE_Y = 30;
export const RIG_CAMERA_Y = RIG_DEVICE_Y + DEVICE_H + 10;
export const RIG_H = RIG_CAMERA_Y + CAMERA_H + 14 + RIG_FOOT_H;
export const RIG_MIN_W = 460;
/** USB port stub: how far left of the device circle the rig's port handle sits. */
export const PORT_STUB = 26;

export const CLOUD_PAD_X = 48;
export const CLOUD_PAD_TOP = 44;
export const CLOUD_PAD_BOTTOM = 28;
export const BAND_GAP = 190; // vertical gap between the cloud and the rigs: room for lease/queue lines to read
export const RIG_GAP = 96;
export const SESSION_SPACING = 230;

export function rigWidth(deviceCount: number): number {
  const n = Math.max(deviceCount, 1);
  return Math.max(RIG_MIN_W, RIG_PAD_X * 2 + n * DEVICE_W + (n - 1) * RIG_SLOT_GAP);
}

/** Device box x (relative to its rig) for bench slot `i` of `n`, centred in a rig of width `w`. */
export function deviceSlotX(i: number, n: number, w: number): number {
  const row = n * DEVICE_W + Math.max(0, n - 1) * RIG_SLOT_GAP;
  return (w - row) / 2 + i * (DEVICE_W + RIG_SLOT_GAP);
}
