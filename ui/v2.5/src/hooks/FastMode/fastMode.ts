// Fast mode streams a pre-generated 720p copy via GET /scene/:id/stream.fast.
// Same shape as Interactive/buttplug.ts: DB-backed, mirrored to localStorage.

const CONFIG_KEY = "stashhub.fastMode";
export const FAST_MODE_EVENT = "stashhub:fast-mode-changed";

export interface FastModeConfig {
  // Off by default: this is a speed/quality tradeoff, not something every
  // install should silently opt into.
  enabled: boolean;
  // Scenes after the current one the feed downloads to the device.
  cacheAhead: number;
}

export const CACHE_AHEAD_MAX = 20;

export const DEFAULT_FAST_MODE_CONFIG: FastModeConfig = {
  enabled: false,
  cacheAhead: 6,
};

// The encode parameters stash-fastmode.sh actually produces. Single source of
// truth so the feed's displayed resolution/codec badge can describe what is
// really playing instead of the original file's metadata.
export const FAST_MODE_MAX_HEIGHT = 720;
export const FAST_MODE_VIDEO_CODEC = "h264";

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
    cacheAhead:
      typeof r.cacheAhead === "number" && Number.isFinite(r.cacheAhead)
        ? Math.min(CACHE_AHEAD_MAX, Math.max(0, Math.round(r.cacheAhead)))
        : DEFAULT_FAST_MODE_CONFIG.cacheAhead,
  };
}

/** Pull stashhub.fastMode out of the Configuration.ui blob ConfigurationContext
 *  already holds, so a setting flipped anywhere lands on first render. */
export function fastModeFromConfigUi(ui: unknown): FastModeConfig | null {
  let node: unknown = ui;
  for (const part of FAST_MODE_UI_PATH) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return sanitizeFastMode(node);
}
