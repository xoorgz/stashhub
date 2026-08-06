// Fast-mode playback: stream a pre-generated small/fast-start copy (720p,
// capped bitrate) instead of the original file, so the feed never waits on a
// large source or a slow live transcode. Copies are built out-of-band into
// /srv/stash/data/generated/fastmode/{sceneId}.mp4; the server serves them
// from GET /scene/:id/stream.fast, falling back to the normal stream for any
// scene that has not been generated yet.
//
// Same load/save shape as Interactive/buttplug.ts: DB-backed via
// configureUISetting so the choice follows the account, mirrored to
// localStorage so components can read it synchronously without waiting on a
// query.

const CONFIG_KEY = "stashhub.fastMode";
export const FAST_MODE_EVENT = "stashhub:fast-mode-changed";

export interface FastModeConfig {
  // Off by default: this is a speed/quality tradeoff, not something every
  // install should silently opt into.
  enabled: boolean;
}

export const DEFAULT_FAST_MODE_CONFIG: FastModeConfig = {
  enabled: false,
};

export function loadFastModeConfig(): FastModeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_FAST_MODE_CONFIG;
    return { ...DEFAULT_FAST_MODE_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_FAST_MODE_CONFIG;
  }
}

export function saveFastModeConfig(c: FastModeConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    window.dispatchEvent(new CustomEvent(FAST_MODE_EVENT));
  } catch {
    /* ignore */
  }
}

export { CONFIG_KEY as FAST_MODE_UI_KEY };
export const FAST_MODE_UI_PATH = ["stashhub", "fastMode"] as const;

export function sanitizeFastMode(input: unknown): FastModeConfig | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  return {
    enabled:
      typeof r.enabled === "boolean" ? r.enabled : DEFAULT_FAST_MODE_CONFIG.enabled,
  };
}

/** Pull stashhub.fastMode out of the app-wide Configuration.ui blob (the same
 *  object ConfigurationContext already holds at boot, no extra query needed).
 *  Used so a setting flipped by any means (Settings panel, a direct DB write,
 *  another tab) reaches the feed on first render instead of only after the
 *  Settings panel happens to have synced it into localStorage. */
export function fastModeFromConfigUi(ui: unknown): FastModeConfig | null {
  let node: unknown = ui;
  for (const part of FAST_MODE_UI_PATH) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return sanitizeFastMode(node);
}
