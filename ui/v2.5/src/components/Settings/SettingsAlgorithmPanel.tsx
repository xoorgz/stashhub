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
import { useToast } from "src/hooks/Toast";
import "./SettingsAlgorithmPanel.scss";

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
  unwatchedEnabled: boolean;
  unwatchedWeight: number;
  unwatchedMinSec: number;
  unwatchedMaxSec: number;
  watchedTagsEnabled: boolean;
  watchedTagsWeight: number;
  watchedTagsLookback: number;
  favoredTagsEnabled: boolean;
  favoredTagsWeight: number;
  favoredTagIds: string[];
  topRatedEnabled: boolean;
  topRatedWeight: number;
  affinityEnabled: boolean;
  affinityWeight: number;
  affinityRecentDays: number;
  affinityLookback: number;
  affinityMinSec: number;
  skipDemoteEnabled: boolean;
  skipThresholdSec: number;
  skipHalfLifeDays: number;
  skipMaxSuppress: number;
  tagSkipEnabled: boolean;
  tagSkipMinCount: number;
  tagSkipDecayDays: number;
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
  unwatchedEnabled: false,
  unwatchedWeight: 4,
  // Both zero means never played at all. Raising max opens it up to scenes
  // barely sampled, e.g. 0 to 10 for ones you started and dropped.
  unwatchedMinSec: 0,
  unwatchedMaxSec: 0,
  watchedTagsEnabled: true,
  watchedTagsWeight: 4,
  watchedTagsLookback: 50,
  favoredTagsEnabled: false,
  favoredTagsWeight: 5,
  favoredTagIds: [],
  topRatedEnabled: true,
  topRatedWeight: 2,
  affinityEnabled: true,
  affinityWeight: 7,
  affinityRecentDays: 14,
  affinityLookback: 30,
  affinityMinSec: 60,
  skipDemoteEnabled: true,
  skipThresholdSec: 10,
  skipHalfLifeDays: 7,
  skipMaxSuppress: 85,
  tagSkipEnabled: true,
  tagSkipMinCount: 3,
  tagSkipDecayDays: 30,
  staleEnabled: true,
  staleWeight: 2,
  staleMinDays: 30,
  randomWeight: 1,
  hottestTagName: "hottest",
  topRatingMin: 80,
  excludeRecentlyPlayed: true,
  excludeRecentlyPlayedDays: 2,
  filterChips: [
    { label: "", iconName: "", tagIds: [], weight: 3, mode: "strict" },
    { label: "", iconName: "", tagIds: [], weight: 3, mode: "strict" },
    { label: "", iconName: "", tagIds: [], weight: 3, mode: "strict" },
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


/** A bucket's real influence is its weight over the sum of all active weights,
 *  so the raw number means nothing on its own. Turn it into a percentage. */
function bucketShares(s: AlgorithmSettings): Record<string, number> {
  const active: Array<[string, number]> = [];
  const add = (key: string, on: boolean, w: number) => {
    if (on && w > 0) active.push([key, w]);
  };
  add("hottest", s.hottestEnabled, s.hottestWeight);
  add("liked", s.likedEnabled, s.likedWeight);
  add("topWatched", s.topWatchedEnabled, s.topWatchedWeight);
  add("topOCount", s.topOCountEnabled, s.topOCountWeight);
  add("unwatched", s.unwatchedEnabled, s.unwatchedWeight);
  add("watchedTags", s.watchedTagsEnabled, s.watchedTagsWeight);
  add(
    "favoredTags",
    s.favoredTagsEnabled && s.favoredTagIds.length > 0,
    s.favoredTagsWeight
  );
  add("affinity", s.affinityEnabled, s.affinityWeight);
  add("topRated", s.topRatedEnabled, s.topRatedWeight);
  add("stale", s.staleEnabled, s.staleWeight);
  add("random", true, s.randomWeight);

  const total = active.reduce((sum, [, w]) => sum + w, 0);
  const out: Record<string, number> = {};
  for (const [k, w] of active) out[k] = total ? Math.round((w / total) * 100) : 0;
  return out;
}

const Row: React.FC<{
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  weight?: number;
  onWeight?: (v: number) => void;
  share?: number;
}> = ({ title, description, enabled, onToggle, weight, onWeight, share }) => (
  <div className="setting algo-row">
    <div>
      <h3>{title}</h3>
      <div className="value">{description}</div>
    </div>
    <div className="algo-row-controls">
      <Form.Switch
        id={`algo-${title.replace(/\s+/g, "-").toLowerCase()}-on`}
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        label=""
      />
      {typeof weight === "number" && onWeight && (
        <div className="algo-weight">
          <input
            className="algo-slider"
            type="range"
            min={0}
            max={10}
            step={1}
            value={weight}
            disabled={!enabled}
            onChange={(e) => onWeight(parseInt(e.target.value, 10))}
            aria-label={`${title} weight`}
          />
          <span className="algo-share">
            {enabled && weight > 0 ? (
              <>
                <span className="algo-weight-num">{weight}</span>
                <span className="algo-share-pct">{share ?? 0}% of feed</span>
              </>
            ) : (
              "off"
            )}
          </span>
        </div>
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

  // "Saved" flash pill. Settings auto-save on every edit; this gives the
  // user passive confirmation that the change landed. Suppressed until
  // chipHydrated.current flips true so the initial server-load doesn't
  // pop the pill on first paint.
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimerRef = useRef<number | null>(null);
  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setSavedFlash(false), 1400);
  }, []);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  useEffect(() => {
    save(s);
    if (chipHydrated.current) flashSaved();
  }, [s, flashSaved]);

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

  // Explicit Save button: settings are already persisted on every change,
  // but a user-driven action is still worth supporting both because some
  // people expect a button and because it gives us a place to push the
  // server-side configureUISetting call again synchronously if anything
  // got stuck. Toast for explicit confirmation, flash pill for passive.
  const Toast = useToast();
  const onSaveClick = useCallback(() => {
    save(s);
    saveFilterChipsToServer(s.filterChips);
    flashSaved();
    Toast.success("Algorithm settings saved");
  }, [s, flashSaved, Toast]);

  const shares = bucketShares(s);

  return (
    <div className="settings-algorithm-panel">
      <div
        className={`algorithm-save-flash${savedFlash ? " is-on" : ""}`}
        aria-live="polite"
        aria-hidden={!savedFlash}
      >
        Saved
      </div>

      <SettingSection heading="Feed algorithm">
        <div className="setting">
          <div>
            <p>
              Each slider sets a bucket&apos;s weight from 0 to 10. The weight
              is not a percentage: a bucket&apos;s real share is its weight
              divided by the total of all active weights, shown beneath each
              slider.
            </p>
            <p>
              The shares always add up to 100%, because every video in the feed
              comes from exactly one bucket. So you cannot set them all to 100%,
              and sliding every bucket to 10 gives exactly the same feed as
              sliding them all to 1, just evenly split. Only the ratio between
              buckets matters. To make one dominate, raise it and lower the
              others. Switch a bucket off to drop it entirely.
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
          share={shares.hottest}
        />

        <Row
          title="Liked"
          description="Scenes you have liked."
          enabled={s.likedEnabled}
          onToggle={(v) => update("likedEnabled", v)}
          weight={s.likedWeight}
          onWeight={(v) => update("likedWeight", v)}
          share={shares.liked}
        />

        <Row
          title="Top Watched"
          description={`Scenes you spend the most time on, counting only those you watched at least ${s.topWatchedMinSec}s of.`}
          enabled={s.topWatchedEnabled}
          onToggle={(v) => update("topWatchedEnabled", v)}
          weight={s.topWatchedWeight}
          onWeight={(v) => update("topWatchedWeight", v)}
          share={shares.topWatched}
        />

        <Row
          title="Top O-Count"
          description={`Scenes you finished to most often, at least ${s.topOCountMin} time(s).`}
          enabled={s.topOCountEnabled}
          onToggle={(v) => update("topOCountEnabled", v)}
          weight={s.topOCountWeight}
          onWeight={(v) => update("topOCountWeight", v)}
          share={shares.topOCount}
        />

        <Row
          title="Unwatched"
          description={
            s.unwatchedMaxSec <= 0
              ? "Scenes you have never played. Set a max play time under Advanced to include ones you barely started."
              : `Scenes played between ${s.unwatchedMinSec}s and ${s.unwatchedMaxSec}s, newest first.`
          }
          enabled={s.unwatchedEnabled}
          onToggle={(v) => update("unwatchedEnabled", v)}
          weight={s.unwatchedWeight}
          onWeight={(v) => update("unwatchedWeight", v)}
          share={shares.unwatched}
        />

        <Row
          title="Watched Tags"
          description={`Random scenes carrying the tags you actually spend time on, learned from your ${s.watchedTagsLookback} most-watched scenes.`}
          enabled={s.watchedTagsEnabled}
          onToggle={(v) => update("watchedTagsEnabled", v)}
          weight={s.watchedTagsWeight}
          onWeight={(v) => update("watchedTagsWeight", v)}
          share={shares.watchedTags}
        />

        <Row
          title="Favored Tags"
          description="Random scenes with a tag from your Favored Tags list, set under Advanced below. Stays inactive while that list is empty."
          enabled={s.favoredTagsEnabled}
          onToggle={(v) => update("favoredTagsEnabled", v)}
          weight={s.favoredTagsWeight}
          onWeight={(v) => update("favoredTagsWeight", v)}
          share={shares.favoredTags}
        />

        <Row
          title="For You"
          description={`Scenes similar to what you actually watched in the last ${s.affinityRecentDays} days. Learns the performers, tags and title words you spend real time on, then ranks candidates by how many of those they hit. Re-learns on every refresh, so it follows your taste as it shifts.`}
          enabled={s.affinityEnabled}
          onToggle={(v) => update("affinityEnabled", v)}
          weight={s.affinityWeight}
          onWeight={(v) => update("affinityWeight", v)}
          share={shares.affinity}
        />

        <Row
          title="Top rated"
          description={`Scenes you rated ${s.topRatingMin}% or higher.`}
          enabled={s.topRatedEnabled}
          onToggle={(v) => update("topRatedEnabled", v)}
          weight={s.topRatedWeight}
          onWeight={(v) => update("topRatedWeight", v)}
          share={shares.topRated}
        />

        <Row
          title="Stale"
          description={`Scenes you have not played in the last ${s.staleMinDays} days.`}
          enabled={s.staleEnabled}
          onToggle={(v) => update("staleEnabled", v)}
          weight={s.staleWeight}
          onWeight={(v) => update("staleWeight", v)}
          share={shares.stale}
        />

        <Row
          title="Random"
          description="Anything at all, picked at random. Keeps the feed from narrowing to the same scenes."
          enabled={s.randomWeight > 0}
          onToggle={(v) => update("randomWeight", v ? 1 : 0)}
          weight={s.randomWeight}
          onWeight={(v) => update("randomWeight", v)}
          share={shares.random}
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
            <h3>Demote scenes you skip</h3>
            <div className="value">
              A scene you leave inside 10 seconds is shown less often, and the
              faster you bounce off it the harder it drops. Skipping ahead does
              not count as watching. It is never a permanent ban: the penalty
              fades on its own, so old skips drift back into rotation.
            </div>
          </div>
          <div>
            <Form.Switch
              id="algo-skip-demote-on"
              checked={s.skipDemoteEnabled}
              onChange={(e) => update("skipDemoteEnabled", e.target.checked)}
              label=""
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Skip threshold</h3>
            <div className="value">
              Seconds of real playback below which leaving a scene counts as a
              skip. Seeking around inside it never counts, whatever the number.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={120}
              step={1}
              value={s.skipThresholdSec}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 120)
                  update("skipThresholdSec", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Skip memory half-life</h3>
            <div className="value">
              Days for a skip to lose half its sting. Longer holds a grudge,
              shorter forgives faster.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={365}
              step={1}
              value={s.skipHalfLifeDays}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 365)
                  update("skipHalfLifeDays", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Maximum demotion</h3>
            <div className="value">
              Ceiling on how much a heavily skipped scene is held back, as a
              percentage of its draws. Even at 95 it still comes up sometimes.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={0}
              max={95}
              step={5}
              value={s.skipMaxSuppress}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 95)
                  update("skipMaxSuppress", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Hide heavily skipped tags</h3>
            <div className="value">
              Separate from scene demotion, and much blunter: once a tag has
              collected enough skips, every scene carrying it is dropped from
              the queue outright. Turn off if it is hiding too much.
            </div>
          </div>
          <div>
            <Form.Switch
              id="algo-tag-skip-on"
              checked={s.tagSkipEnabled}
              onChange={(e) => update("tagSkipEnabled", e.target.checked)}
              label=""
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Skips before a tag is hidden</h3>
            <div className="value">
              How many skipped scenes a tag needs before it is blocked. Low
              numbers block whole tags off a couple of mis-swipes.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={50}
              step={1}
              value={s.tagSkipMinCount}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 50)
                  update("tagSkipMinCount", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>Tag skip memory</h3>
            <div className="value">
              Days a tag skip is remembered before it is forgotten entirely.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={365}
              step={1}
              value={s.tagSkipDecayDays}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 365)
                  update("tagSkipDecayDays", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
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
            <h3>For You: memory</h3>
            <div className="value">
              How many days back For You looks when learning what you are into.
              Shorter reacts faster to a new mood, longer is more stable.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={90}
              step={1}
              value={s.affinityRecentDays}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 90)
                  update("affinityRecentDays", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>For You: scenes profiled</h3>
            <div className="value">
              How many of your recently watched scenes feed the profile.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={5}
              max={200}
              step={5}
              value={s.affinityLookback}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 5 && n <= 200)
                  update("affinityLookback", n);
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>
        <div className="setting">
          <div>
            <h3>For You: minimum watch time</h3>
            <div className="value">
              A scene only counts toward the profile once you have watched this
              many seconds of it, so scenes you swiped straight past do not
              teach it anything.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={5}
              max={3600}
              step={5}
              value={s.affinityMinSec}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 5 && n <= 3600)
                  update("affinityMinSec", n);
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
            <h3>Unwatched play time</h3>
            <div className="value">
              Play-time range the Unwatched bucket accepts, in seconds. Both at
              0 means never played at all. Raise the maximum to also include
              scenes you started and dropped.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Form.Control
              type="number"
              min={0}
              max={100000}
              step={1}
              value={s.unwatchedMinSec}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 100000) {
                  update("unwatchedMinSec", n);
                  // A minimum above the maximum matches nothing, so carry the
                  // maximum along rather than silently emptying the bucket.
                  if (n > s.unwatchedMaxSec) update("unwatchedMaxSec", n);
                }
              }}
              style={{ width: 100 }}
            />
            <span className="value">to</span>
            <Form.Control
              type="number"
              min={0}
              max={100000}
              step={1}
              value={s.unwatchedMaxSec}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 0 && n <= 100000) {
                  update("unwatchedMaxSec", n);
                  if (n < s.unwatchedMinSec) update("unwatchedMinSec", n);
                }
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
              Three configurable quick filters shown as small icon pills in
              the top-right island, left of the notification bell. Each chip
              combines tag IDs of your choice. Tap one in the island and the
              feed reroles to only scenes carrying any of those tags. Tap
              the active chip again to clear the filter. Tap a different
              chip to switch (single-select).
            </div>
          </div>
        </div>
        {s.filterChips.map((chip, idx) => (
          <div className="setting filter-chip-row" key={`chip-${idx}`}>
            <div className="filter-chip-row-inner">
              <h3>Chip {idx + 1}</h3>
              <div className="filter-chip-row-controls">
                <div className="filter-chip-row-top">
                  <Form.Control
                    as="select"
                    value={chip.iconName}
                    onChange={(e) => {
                      const next = [...s.filterChips];
                      next[idx] = { ...next[idx], iconName: e.target.value };
                      update("filterChips", next);
                    }}
                    className="filter-chip-icon-select"
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
                    <span className="filter-chip-icon-preview" title="Preview">
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
                    className="filter-chip-label-input"
                  />
                </div>
                <div className="filter-chip-tag-select">
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
            <h3>Save</h3>
            <div className="value">
              Algorithm settings auto-save as you edit. Click to confirm
              the current state, the chip defs also get pushed to the
              server-side UI config.
            </div>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSaveClick}
            >
              Save
            </button>
          </div>
        </div>

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
    </div>
  );
};

export default SettingsAlgorithmPanel;
