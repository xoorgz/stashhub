import React, { useCallback, useEffect, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import { SettingSection } from "./SettingSection";
import { TagSelect } from "../Shared/Select";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import {
  FILTER_CHIP_ICONS,
  FilterChipIcon,
} from "../Feed/feedIcons";

export const ALGORITHM_SETTINGS_KEY = "algorithm.settings";
export const ALGORITHM_SETTINGS_EVENT = "stashhub:algorithm-settings-changed";
// Stash auto-nests dotted UI config keys: writing key "stashhub.filterChips"
// produces ui.stashhub.filterChips on the server. We write with the dotted
// key (Stash interprets it) and read by walking the nested path.
export const FILTER_CHIPS_UI_KEY = "stashhub.filterChips";
const FILTER_CHIPS_UI_PATH = ["stashhub", "filterChips"] as const;

export interface FilterChip {
  label: string;
  iconName: string;
  // Pre-v1.3.2 chips used an emoji string. Keep the field so old DB blobs
  // load cleanly until they're re-saved through the new icon picker.
  emoji?: string;
  tagIds: string[];
  weight: number;
  mode: "boost" | "strict";
}

export interface AlgorithmSettings {
  hottestEnabled: boolean;
  hottestWeight: number;
  likedEnabled: boolean;
  likedWeight: number;
  topWatchedEnabled: boolean;
  topWatchedWeight: number;
  topWatchedMinSec: number;
  topOCountEnabled: boolean;
  topOCountWeight: number;
  topOCountMin: number;
  watchedTagsEnabled: boolean;
  watchedTagsWeight: number;
  watchedTagsLookback: number;
  favoredTagsEnabled: boolean;
  favoredTagsWeight: number;
  favoredTagIds: string[];
  topRatedEnabled: boolean;
  topRatedWeight: number;
  staleEnabled: boolean;
  staleWeight: number;
  staleMinDays: number;
  randomWeight: number;
  hottestTagName: string;
  hottestTagId?: string;
  topRatingMin: number;
  excludeRecentlyPlayed: boolean;
  excludeRecentlyPlayedDays: number;
  filterChips: FilterChip[];
}

export const DEFAULT_ALGORITHM_SETTINGS: AlgorithmSettings = {
  hottestEnabled: true,
  hottestWeight: 5,
  likedEnabled: true,
  likedWeight: 4,
  topWatchedEnabled: true,
  topWatchedWeight: 6,
  topWatchedMinSec: 60,
  topOCountEnabled: true,
  topOCountWeight: 3,
  topOCountMin: 1,
  watchedTagsEnabled: true,
  watchedTagsWeight: 4,
  watchedTagsLookback: 50,
  favoredTagsEnabled: false,
  favoredTagsWeight: 5,
  favoredTagIds: [],
  topRatedEnabled: true,
  topRatedWeight: 2,
  staleEnabled: true,
  staleWeight: 2,
  staleMinDays: 30,
  randomWeight: 1,
  hottestTagName: "hottest",
  topRatingMin: 80,
  excludeRecentlyPlayed: true,
  excludeRecentlyPlayedDays: 7,
  filterChips: [
    { label: "", iconName: "", tagIds: [], weight: 3, mode: "boost" },
    { label: "", iconName: "", tagIds: [], weight: 3, mode: "boost" },
    { label: "", iconName: "", tagIds: [], weight: 3, mode: "boost" },
  ],
};

export function loadAlgorithmSettings(): AlgorithmSettings {
  try {
    const raw = localStorage.getItem(ALGORITHM_SETTINGS_KEY);
    if (!raw) return DEFAULT_ALGORITHM_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ALGORITHM_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_ALGORITHM_SETTINGS;
  }
}

function save(s: AlgorithmSettings) {
  try {
    localStorage.setItem(ALGORITHM_SETTINGS_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent(ALGORITHM_SETTINGS_EVENT));
  } catch {
    /* ignore */
  }
}

function sanitizeChips(input: unknown): FilterChip[] | null {
  if (!Array.isArray(input)) return null;
  const out: FilterChip[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    out.push({
      label: typeof r.label === "string" ? r.label : "",
      iconName: typeof r.iconName === "string" ? r.iconName : "",
      emoji: typeof r.emoji === "string" ? r.emoji : undefined,
      tagIds: Array.isArray(r.tagIds)
        ? (r.tagIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      weight:
        typeof r.weight === "number" && r.weight >= 1 && r.weight <= 10
          ? Math.round(r.weight)
          : 3,
      mode: r.mode === "strict" ? "strict" : "boost",
    });
  }
  while (out.length < 3) {
    out.push({ label: "", iconName: "", tagIds: [], weight: 3, mode: "boost" });
  }
  return out.slice(0, 3);
}

/** Read filterChips from Stash's server-side UI config (DB). Falls back to
 *  null on any error, leaving the caller to keep whatever it already had.
 *  Note we use the Apollo client directly so this works outside React. */
export async function loadFilterChipsFromServer(): Promise<FilterChip[] | null> {
  try {
    const r = await getClient().query<GQL.ConfigurationQuery>({
      query: GQL.ConfigurationDocument,
      fetchPolicy: "cache-first",
    });
    let node: unknown = r.data?.configuration?.ui ?? {};
    for (const part of FILTER_CHIPS_UI_PATH) {
      if (!node || typeof node !== "object") return null;
      node = (node as Record<string, unknown>)[part];
    }
    return sanitizeChips(node);
  } catch {
    return null;
  }
}

/** Persist filterChips to the DB via configureUISetting. Side-effect: also
 *  writes the value back into the cached Configuration.ui blob so other
 *  consumers reading from the cache pick up the change immediately. */
export async function saveFilterChipsToServer(chips: FilterChip[]): Promise<void> {
  try {
    await getClient().mutate<GQL.ConfigureUiSettingMutation>({
      mutation: GQL.ConfigureUiSettingDocument,
      variables: { key: FILTER_CHIPS_UI_KEY, value: chips },
      update: (cache, result) => {
        const next = result.data?.configureUISetting;
        if (!next) return;
        try {
          cache.writeQuery({
            query: GQL.ConfigurationDocument,
            data: {
              configuration: {
                ...(cache.readQuery<GQL.ConfigurationQuery>({
                  query: GQL.ConfigurationDocument,
                })?.configuration ?? {}),
                ui: next,
              },
            },
          });
        } catch {
          /* ignore cache write failures */
        }
      },
    });
  } catch {
    /* leave the local copy in place, server is just out of sync */
  }
}

const Row: React.FC<{
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  weight?: number;
  onWeight?: (v: number) => void;
}> = ({ title, description, enabled, onToggle, weight, onWeight }) => (
  <div className="setting">
    <div>
      <h3>{title}</h3>
      <div className="value">{description}</div>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Form.Switch
        id={`algo-${title.replace(/\s+/g, "-").toLowerCase()}-on`}
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        label=""
      />
      {typeof weight === "number" && onWeight && (
        <Form.Control
          type="number"
          min={0}
          max={10}
          step={1}
          value={weight}
          disabled={!enabled}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 0 && n <= 10) onWeight(n);
          }}
          style={{ width: 70 }}
          title="Bucket weight (0–10)"
        />
      )}
    </div>
  </div>
);

export const SettingsAlgorithmPanel: React.FC = () => {
  const [s, setS] = useState<AlgorithmSettings>(() => loadAlgorithmSettings());

  // Chip defs are DB-backed; on mount, pull whatever's stored server-side
  // and merge into local state. Other algorithm settings stay in
  // localStorage (per-device tuning rather than per-account preference).
  const chipHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    loadFilterChipsFromServer().then((chips) => {
      if (cancelled || !chips) {
        chipHydrated.current = true;
        return;
      }
      setS((prev) => ({ ...prev, filterChips: chips }));
      chipHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    save(s);
  }, [s]);

  // Persist chip changes to the DB. Gated until the initial server hydrate
  // completes so we don't immediately overwrite the server's copy with the
  // local default if it lost the race to update state.
  useEffect(() => {
    if (!chipHydrated.current) return;
    saveFilterChipsToServer(s.filterChips);
  }, [s.filterChips]);

  const update = useCallback(
    <K extends keyof AlgorithmSettings>(k: K, v: AlgorithmSettings[K]) => {
      setS((prev) => ({ ...prev, [k]: v }));
    },
    []
  );

  const reset = useCallback(() => setS(DEFAULT_ALGORITHM_SETTINGS), []);

  return (
    <>
      <SettingSection heading="Feed algorithm">
        <div className="setting">
          <div>
            <p>
              The feed queue is drawn from independent buckets. Each bucket is
              weighted; higher weight means it appears more often. Set a weight
              to 0 to disable that bucket.
            </p>
          </div>
        </div>

        <Row
          title="Hottest"
          description={`Scenes tagged "${s.hottestTagName}".`}
          enabled={s.hottestEnabled}
          onToggle={(v) => update("hottestEnabled", v)}
          weight={s.hottestWeight}
          onWeight={(v) => update("hottestWeight", v)}
        />

        <Row
          title="Liked"
          description="Scenes with like_count greater than 0."
          enabled={s.likedEnabled}
          onToggle={(v) => update("likedEnabled", v)}
          weight={s.likedWeight}
          onWeight={(v) => update("likedWeight", v)}
        />

        <Row
          title="Top Watched"
          description={`Scenes with play_duration at or above ${s.topWatchedMinSec}s, ordered by play_duration desc.`}
          enabled={s.topWatchedEnabled}
          onToggle={(v) => update("topWatchedEnabled", v)}
          weight={s.topWatchedWeight}
          onWeight={(v) => update("topWatchedWeight", v)}
        />

        <Row
          title="Top O-Count"
          description={`Scenes with o_counter at or above ${s.topOCountMin}, ordered by o_counter desc.`}
          enabled={s.topOCountEnabled}
          onToggle={(v) => update("topOCountEnabled", v)}
          weight={s.topOCountWeight}
          onWeight={(v) => update("topOCountWeight", v)}
        />

        <Row
          title="Watched Tags"
          description={`Random scenes from the top-time-spent tags (top ${s.watchedTagsLookback} most-watched scenes feed the tag ranking).`}
          enabled={s.watchedTagsEnabled}
          onToggle={(v) => update("watchedTagsEnabled", v)}
          weight={s.watchedTagsWeight}
          onWeight={(v) => update("watchedTagsWeight", v)}
        />

        <Row
          title="Favored Tags"
          description="Random scenes tagged with any tag in the Favored Tags list (Advanced). Empty list = bucket inactive."
          enabled={s.favoredTagsEnabled}
          onToggle={(v) => update("favoredTagsEnabled", v)}
          weight={s.favoredTagsWeight}
          onWeight={(v) => update("favoredTagsWeight", v)}
        />

        <Row
          title="Top rated"
          description={`Scenes with rating100 at or above ${s.topRatingMin}.`}
          enabled={s.topRatedEnabled}
          onToggle={(v) => update("topRatedEnabled", v)}
          weight={s.topRatedWeight}
          onWeight={(v) => update("topRatedWeight", v)}
        />

        <Row
          title="Stale"
          description={`Scenes with no play history in the last ${s.staleMinDays} days.`}
          enabled={s.staleEnabled}
          onToggle={(v) => update("staleEnabled", v)}
          weight={s.staleWeight}
          onWeight={(v) => update("staleWeight", v)}
        />

        <Row
          title="Random"
          description="Unfiltered random fallback."
          enabled={s.randomWeight > 0}
          onToggle={(v) => update("randomWeight", v ? 1 : 0)}
          weight={s.randomWeight}
          onWeight={(v) => update("randomWeight", v)}
        />

        <div className="setting">
          <div>
            <h3>Skip recently played</h3>
            <div className="value">
              Hide scenes played in the last {s.excludeRecentlyPlayedDays} days
              from every bucket.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Form.Switch
              id="algo-skip-recent-on"
              checked={s.excludeRecentlyPlayed}
              onChange={(e) =>
                update("excludeRecentlyPlayed", e.target.checked)
              }
              label=""
            />
            <Form.Control
              type="number"
              min={1}
              max={365}
              step={1}
              value={s.excludeRecentlyPlayedDays}
              disabled={!s.excludeRecentlyPlayed}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 365)
                  update("excludeRecentlyPlayedDays", n);
              }}
              style={{ width: 80 }}
              title="Days"
            />
          </div>
        </div>
      </SettingSection>

      <SettingSection heading="Advanced">
        <div className="setting">
          <div>
            <h3>Hottest tag</h3>
            <div className="value">
              Tag used by the Hottest bucket. Defaults to a tag named "hottest"
              if not set.
            </div>
          </div>
          <div style={{ minWidth: 220, width: "100%", maxWidth: 360 }}>
            <TagSelect
              isClearable
              ids={s.hottestTagId ? [s.hottestTagId] : []}
              onSelect={(items) => {
                const first = items?.[0] as { id?: string; name?: string } | undefined;
                setS((prev) => ({
                  ...prev,
                  hottestTagId: first?.id,
                  hottestTagName: first?.name ?? prev.hottestTagName,
                }));
              }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Favored Tags</h3>
            <div className="value">
              Tags the Favored Tags bucket pulls scenes from. Add the ones you
              always want more of. Bucket is inactive if the list is empty.
            </div>
          </div>
          <div style={{ minWidth: 260, width: "100%", maxWidth: 440 }}>
            <TagSelect
              isMulti
              isClearable
              ids={s.favoredTagIds}
              onSelect={(items) => {
                const ids = (items ?? [])
                  .map((it) => (it as { id?: string }).id)
                  .filter((id): id is string => !!id);
                update("favoredTagIds", ids);
              }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Top Watched minimum seconds</h3>
            <div className="value">
              Minimum play_duration (in seconds) for a scene to qualify for the
              Top Watched bucket. Filters out brief plays.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={0}
              max={36000}
              step={5}
              value={s.topWatchedMinSec}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 36000)
                  update("topWatchedMinSec", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Watched Tags lookback</h3>
            <div className="value">
              Number of most-watched scenes (by play_duration) used to compute
              the tag ranking for the Watched Tags bucket.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={5}
              max={500}
              step={5}
              value={s.watchedTagsLookback}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 5 && n <= 500)
                  update("watchedTagsLookback", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Top O-Count minimum</h3>
            <div className="value">
              Minimum o_counter value used by the Top O-Count bucket.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={1000}
              step={1}
              value={s.topOCountMin}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 1000) update("topOCountMin", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Top-rated threshold</h3>
            <div className="value">
              Minimum rating100 value used by the Top rated bucket.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={0}
              max={100}
              step={5}
              value={s.topRatingMin}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 100) update("topRatingMin", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Stale window (days)</h3>
            <div className="value">
              Threshold for the Stale bucket, in days since last_played_at.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={3650}
              step={1}
              value={s.staleMinDays}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 3650) update("staleMinDays", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Filter chips</h3>
            <div className="value">
              Three configurable quick filters shown above the feed action
              stack. Each chip combines tag IDs of your choice. Tap a chip in
              the feed to activate it. Empty slots are hidden. Boost adds the
              chip's tags as an extra weighted bucket. Strict restricts every
              bucket to scenes carrying any of the chip's tags.
            </div>
          </div>
        </div>
        {s.filterChips.map((chip, idx) => (
          <div className="setting" key={`chip-${idx}`}>
            <div>
              <h3>Chip {idx + 1}</h3>
              <div className="value">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <Form.Control
                    as="select"
                    value={chip.iconName}
                    onChange={(e) => {
                      const next = [...s.filterChips];
                      next[idx] = { ...next[idx], iconName: e.target.value };
                      update("filterChips", next);
                    }}
                    style={{ width: 130 }}
                    title="Chip icon"
                  >
                    <option value="">(no icon)</option>
                    {FILTER_CHIP_ICONS.map((i) => (
                      <option key={i.name} value={i.name}>
                        {i.label}
                      </option>
                    ))}
                  </Form.Control>
                  {chip.iconName && (
                    <span
                      style={{
                        display: "inline-flex",
                        width: 28,
                        height: 28,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 6,
                        background: "rgba(255,255,255,0.06)",
                        color: "#fff",
                      }}
                      title="Preview"
                    >
                      <FilterChipIcon name={chip.iconName} size={18} />
                    </span>
                  )}
                  <Form.Control
                    type="text"
                    placeholder="Label"
                    value={chip.label}
                    maxLength={24}
                    onChange={(e) => {
                      const next = [...s.filterChips];
                      next[idx] = { ...next[idx], label: e.target.value };
                      update("filterChips", next);
                    }}
                    style={{ width: 160 }}
                  />
                  <Form.Control
                    as="select"
                    value={chip.mode}
                    onChange={(e) => {
                      const next = [...s.filterChips];
                      next[idx] = {
                        ...next[idx],
                        mode: (e.target.value === "strict" ? "strict" : "boost"),
                      };
                      update("filterChips", next);
                    }}
                    style={{ width: 110 }}
                  >
                    <option value="boost">Boost</option>
                    <option value="strict">Strict</option>
                  </Form.Control>
                  <Form.Control
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={chip.weight}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (Number.isFinite(n) && n >= 1 && n <= 10) {
                        const next = [...s.filterChips];
                        next[idx] = { ...next[idx], weight: n };
                        update("filterChips", next);
                      }
                    }}
                    style={{ width: 70 }}
                    title="Boost weight (ignored in strict mode)"
                  />
                </div>
                <div style={{ marginTop: 8, minWidth: 260, maxWidth: 440 }}>
                  <TagSelect
                    isMulti
                    isClearable
                    ids={chip.tagIds}
                    onSelect={(items) => {
                      const ids = (items ?? [])
                        .map((it) => (it as { id?: string }).id)
                        .filter((id): id is string => !!id);
                      const next = [...s.filterChips];
                      next[idx] = { ...next[idx], tagIds: ids };
                      update("filterChips", next);
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}

        <div className="setting">
          <div>
            <h3>Reset to defaults</h3>
            <div className="value">
              Restore default weights and thresholds. No data is modified.
            </div>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={reset}
            >
              Reset
            </button>
          </div>
        </div>
      </SettingSection>
    </>
  );
};

export default SettingsAlgorithmPanel;
