import React, { useCallback, useEffect, useState } from "react";
import {
  loadFilterChipsFromServer,
  ALGORITHM_SETTINGS_EVENT,
  FilterChip,
  loadAlgorithmSettings,
} from "../Settings/SettingsAlgorithmPanel";
import { FilterChipIcon } from "../Feed/feedIcons";

// Per-device active state lives in localStorage. The feed listens for
// the same event the settings panel fires so it can rebuild the queue
// when chips toggle.
const ACTIVE_KEY = "feed.filterChips.active";
const ACTIVE_EVENT = "stashhub:feed-chip-active-changed";

function readActive(): number[] {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((n) => Number.isInteger(n))
      : [];
  } catch {
    return [];
  }
}

function writeActive(next: number[]) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, { detail: next }));
}

export const FeedChipIsland: React.FC = () => {
  const [chips, setChips] = useState<FilterChip[]>(
    () => loadAlgorithmSettings().filterChips ?? []
  );
  const [active, setActive] = useState<number[]>(() => readActive());

  useEffect(() => {
    let cancelled = false;
    loadFilterChipsFromServer().then((server) => {
      if (cancelled || !server) return;
      setChips(server);
    });
    function onSettingsChange() {
      setChips(loadAlgorithmSettings().filterChips ?? []);
      loadFilterChipsFromServer().then((server) => {
        if (!cancelled && server) setChips(server);
      });
    }
    window.addEventListener(ALGORITHM_SETTINGS_EVENT, onSettingsChange);
    return () => {
      cancelled = true;
      window.removeEventListener(ALGORITHM_SETTINGS_EVENT, onSettingsChange);
    };
  }, []);

  const toggle = useCallback((idx: number) => {
    setActive((prev) => {
      const next = prev.includes(idx)
        ? prev.filter((i) => i !== idx)
        : [...prev, idx];
      writeActive(next);
      return next;
    });
  }, []);

  const visible = chips
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => c.tagIds.length > 0 && (c.iconName || c.emoji));

  if (visible.length === 0) return null;

  return (
    <div
      className="feed-chip-island"
      role="group"
      aria-label="Feed filter chips"
    >
      {visible.map(({ c, idx }) => {
        const isActive = active.includes(idx);
        const title = `${c.label || `Chip ${idx + 1}`}${
          c.mode === "strict" ? " (strict)" : ""
        }`;
        return (
          <button
            key={idx}
            type="button"
            className={`feed-chip-island-btn${isActive ? " is-active" : ""}${
              c.mode === "strict" ? " is-strict" : ""
            }`}
            title={title}
            aria-label={title}
            aria-pressed={isActive}
            onClick={(e) => {
              e.preventDefault();
              toggle(idx);
            }}
          >
            {c.iconName ? (
              <FilterChipIcon name={c.iconName} size={18} />
            ) : (
              <span className="feed-chip-island-emoji">{c.emoji}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default FeedChipIsland;
