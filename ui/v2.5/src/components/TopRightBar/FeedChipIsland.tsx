import React, { useCallback, useContext, useEffect, useState } from "react";
import { ConfigurationContext } from "src/hooks/Config";
import {
  loadFilterChipsFromServer,
  ALGORITHM_SETTINGS_EVENT,
  FilterChip,
  loadAlgorithmSettings,
} from "../Settings/SettingsAlgorithmPanel";
import { FilterChipIcon } from "../Feed/feedIcons";
import { CcOnIcon, InteractiveIcon, NewIcon } from "../Feed/icons";

// Per-device active state lives in localStorage. The feed listens for
// the same event the settings panel fires so it can rebuild the queue
// when chips toggle.
const ACTIVE_KEY = "feed.filterChips.active";
export const ACTIVE_EVENT = "stashhub:feed-chip-active-changed";

// Built-in attribute filters, independent of the tag chips and each other.
const CC_KEY = "feed.filter.cc";
const TOY_KEY = "feed.filter.toy";
export const NEW_KEY = "feed.filter.new";

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(ACTIVE_EVENT));
}

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
  const [ccOn, setCcOn] = useState<boolean>(() => readFlag(CC_KEY));
  const [toyOn, setToyOn] = useState<boolean>(() => readFlag(TOY_KEY));
  const [newOn, setNewOn] = useState<boolean>(() => readFlag(NEW_KEY));
  const { configuration } = useContext(ConfigurationContext);
  const showNew = configuration?.ui?.showFeedNewFilter ?? false;

  // NEW takes the funscript chip's slot, so the hidden one must not keep filtering.
  useEffect(() => {
    if (showNew && readFlag(TOY_KEY)) {
      setToyOn(false);
      writeFlag(TOY_KEY, false);
    }
    if (!showNew && readFlag(NEW_KEY)) {
      setNewOn(false);
      writeFlag(NEW_KEY, false);
    }
  }, [showNew]);

  // Also fired by the feed's empty-state reset button.
  useEffect(() => {
    const sync = () => setNewOn(readFlag(NEW_KEY));
    window.addEventListener(ACTIVE_EVENT, sync);
    return () => window.removeEventListener(ACTIVE_EVENT, sync);
  }, []);

  const toggleCc = useCallback(() => {
    setCcOn((prev) => {
      const next = !prev;
      writeFlag(CC_KEY, next);
      return next;
    });
  }, []);
  const toggleNew = useCallback(() => {
    writeFlag(NEW_KEY, !readFlag(NEW_KEY));
  }, []);
  const toggleToy = useCallback(() => {
    setToyOn((prev) => {
      const next = !prev;
      writeFlag(TOY_KEY, next);
      return next;
    });
  }, []);

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
    // Single-select: tapping a chip makes it the sole active one, tapping
    // the already-active chip turns the filter off entirely. Picking
    // multiple at once was confusing — the user expects "show me this".
    setActive((prev) => {
      const next = prev.length === 1 && prev[0] === idx ? [] : [idx];
      writeActive(next);
      return next;
    });
  }, []);

  const visible = chips
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => c.tagIds.length > 0 && (c.iconName || c.emoji));

  return (
    <div
      className="feed-chip-island"
      role="group"
      aria-label="Feed filter chips"
    >
      <button
        type="button"
        className={`feed-chip-island-btn${ccOn ? " is-active" : ""}`}
        title="Captioned videos only"
        aria-label="Captioned videos only"
        aria-pressed={ccOn}
        onClick={(e) => {
          e.preventDefault();
          toggleCc();
        }}
      >
        <CcOnIcon />
      </button>
      {showNew ? (
        <button
          type="button"
          className={`feed-chip-island-btn${newOn ? " is-active" : ""}`}
          title="New and barely watched videos only"
          aria-label="New and barely watched videos only"
          aria-pressed={newOn}
          onClick={(e) => {
            e.preventDefault();
            toggleNew();
          }}
        >
          <NewIcon />
        </button>
      ) : (
        <button
          type="button"
          className={`feed-chip-island-btn${toyOn ? " is-active" : ""}`}
          title="Videos with a funscript only"
          aria-label="Videos with a funscript only"
          aria-pressed={toyOn}
          onClick={(e) => {
            e.preventDefault();
            toggleToy();
          }}
        >
          <InteractiveIcon />
        </button>
      )}
      {visible.map(({ c, idx }) => {
        const isActive = active.includes(idx);
        const title = c.label || `Chip ${idx + 1}`;
        return (
          <button
            key={idx}
            type="button"
            className={`feed-chip-island-btn${isActive ? " is-active" : ""}`}
            title={title}
            aria-label={title}
            aria-pressed={isActive}
            onClick={(e) => {
              e.preventDefault();
              toggle(idx);
            }}
          >
            {c.iconName ? (
              <FilterChipIcon name={c.iconName} size={20} />
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
