import React, { useCallback, useEffect, useState } from "react";
import { Form } from "react-bootstrap";
import { SettingSection } from "./SettingSection";
import { TagSelect } from "../Shared/Select";
import * as GQL from "src/core/generated-graphql";

export const ALGORITHM_SETTINGS_KEY = "algorithm.settings";
export const ALGORITHM_SETTINGS_EVENT = "stashhub:algorithm-settings-changed";

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

  useEffect(() => {
    save(s);
  }, [s]);

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
