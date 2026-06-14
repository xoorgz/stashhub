import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
const client = getClient();
import { buildQueue, fetchSceneDetails } from "./algorithm";
import {
  loadFilterChipsFromServer,
  ALGORITHM_SETTINGS_EVENT,
  FilterChip,
} from "../Settings/SettingsAlgorithmPanel";
import {
  ChevronIcon,
  HeartIcon,
  DropIcon,
  EyeIcon,
  FullscreenIcon,
  SkipIcon,
  MuteOffIcon,
  MuteOnIcon,
  OpenSceneIcon,
} from "./icons";
import "./Feed.scss";

const VIEWED_KEY = "feed.viewedIds";
const VIEWED_LIMIT = 500;
const LIKES_KEY = "feed.likes";
const LIKE_THRESHOLD = 5;
const MUTED_KEY = "feed.muted";
const CURRENT_KEY = "feed.currentSceneId";
const SKIPPED_TAGS_KEY = "feed.skips.tags";
const SKIP_THRESHOLD_SEC = 5;
const SKIPPED_TAGS_DECAY_DAYS = 30;
const SKIPPED_TAG_DECAY_MS = SKIPPED_TAGS_DECAY_DAYS * 24 * 60 * 60 * 1000;
const QUEUE_TARGET = 30;
const REFILL_AT = 5;

const HEART_COLORS = ["#ff3b6b", "#ff1744", "#ff5070", "#ff7090", "#ff2d55", "#ff6086"];

type Scene = GQL.SceneDataFragment;

interface HeartParticle {
  id: number;
  x: number;
  y: number;
  driftX: number;
  rise: number;
  rot: number;
  size: number;
  color: string;
  dur: number;
}

interface DropParticle {
  id: number;
  x: number;       // start
  y: number;
  dx: number;      // travel offset
  dy: number;
  rot: number;
  size: number;
  color: string;
  dur: number;
}

const DROP_COLORS = [
  "#ffffff",
  "#fdfdfd",
  "#f6f6f6",
  "#f0ece4",
  "#fffaf0",
  "#f8f8f8",
];

// ───────── helpers ─────────
function relativize(u: string | null | undefined): string {
  if (!u) return "";
  return u.replace(/^https?:\/\/[^/]+/i, "");
}

function getViewed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(VIEWED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function markViewed(id: string) {
  try {
    const arr: string[] = JSON.parse(localStorage.getItem(VIEWED_KEY) || "[]");
    if (!arr.includes(id)) {
      arr.push(id);
      while (arr.length > VIEWED_LIMIT) arr.shift();
      localStorage.setItem(VIEWED_KEY, JSON.stringify(arr));
    }
  } catch {
    /* ignore */
  }
}

const WRAP_LAST_SHOWN_KEY = "feed.wrap.lastShownDay";
const WRAP_DISMISS_MS = 9000;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface DailyWrap {
  scenesCount: number;
  topTagName: string | null;
}

/** Fetch yesterday's wrap stats: scenes whose last_played_at falls within
 *  yesterday, and the tag with the highest play_duration across them. */
async function fetchYesterdayWrap(): Promise<DailyWrap | null> {
  const now = new Date();
  const yEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yStart = new Date(yEnd.getTime() - 86400_000);
  const startStr = yStart.toISOString().slice(0, 10);
  const endStr = yEnd.toISOString().slice(0, 10);
  try {
    const r = await client.query<
      GQL.FindScenesQuery,
      GQL.FindScenesQueryVariables
    >({
      query: GQL.FindScenesDocument,
      variables: {
        filter: { per_page: 100, page: 1 },
        scene_filter: {
          last_played_at: {
            value: startStr,
            value2: endStr,
            modifier: GQL.CriterionModifier.Between,
          },
        },
      },
    });
    const scenes = r.data.findScenes.scenes;
    if (!scenes.length) return null;
    const tagScore = new Map<string, { name: string; score: number }>();
    for (const s of scenes) {
      const dur = s.play_duration ?? 0;
      for (const t of s.tags ?? []) {
        const prev = tagScore.get(t.id) ?? { name: t.name, score: 0 };
        prev.score += dur;
        tagScore.set(t.id, prev);
      }
    }
    let topTagName: string | null = null;
    let topScore = 0;
    for (const v of tagScore.values()) {
      if (v.score > topScore) {
        topScore = v.score;
        topTagName = v.name;
      }
    }
    return { scenesCount: scenes.length, topTagName };
  } catch {
    return null;
  }
}

const DailyWrapCard: React.FC<{ data: DailyWrap; onDismiss: () => void }> = ({
  data,
  onDismiss,
}) => (
  <div className="feed-wrap-card" role="status">
    <button
      type="button"
      className="feed-wrap-close"
      aria-label="Dismiss"
      onClick={onDismiss}
    >
      ×
    </button>
    <div className="feed-wrap-title">Yesterday</div>
    <div className="feed-wrap-body">
      <strong>{data.scenesCount}</strong>
      <span> scene{data.scenesCount === 1 ? "" : "s"}</span>
      {data.topTagName ? (
        <>
          <span className="feed-wrap-sep">•</span>
          <span className="feed-wrap-tag">#{data.topTagName}</span>
        </>
      ) : null}
    </div>
  </div>
);

/** localStorage map of tagId -> {count, lastAt}. Entries decay after
 *  SKIPPED_TAGS_DECAY_DAYS; reads strip stale entries on the fly. */
type SkippedTagEntry = { count: number; lastAt: number };
type SkippedTagMap = Record<string, SkippedTagEntry>;
function loadSkippedTags(): SkippedTagMap {
  try {
    const raw = localStorage.getItem(SKIPPED_TAGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SkippedTagMap;
    const cutoff = Date.now() - SKIPPED_TAG_DECAY_MS;
    const out: SkippedTagMap = {};
    for (const [tid, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.count === "number" && entry.lastAt >= cutoff) {
        out[tid] = entry;
      }
    }
    return out;
  } catch {
    return {};
  }
}
function recordTagSkips(tagIds: string[]) {
  if (!tagIds.length) return;
  try {
    const map = loadSkippedTags();
    const now = Date.now();
    for (const id of tagIds) {
      const prev = map[id] ?? { count: 0, lastAt: 0 };
      map[id] = { count: prev.count + 1, lastAt: now };
    }
    localStorage.setItem(SKIPPED_TAGS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function getLikeCount(id: string): number {
  try {
    const map = JSON.parse(localStorage.getItem(LIKES_KEY) || "{}");
    return map[id] || 0;
  } catch {
    return 0;
  }
}

/** Persist a like to the database. Falls back to localStorage if the mutation
 *  fails so the local UI state is still incremented. */
async function bumpLike(id: string): Promise<number> {
  try {
    const result = await client.mutate<
      GQL.SceneIncrementLikeMutation,
      GQL.SceneIncrementLikeMutationVariables
    >({
      mutation: GQL.SceneIncrementLikeDocument,
      variables: { id },
    });
    const next = result.data?.sceneIncrementLike ?? 0;
    try {
      const map = JSON.parse(localStorage.getItem(LIKES_KEY) || "{}");
      map[id] = next;
      localStorage.setItem(LIKES_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
    return next;
  } catch {
    try {
      const map = JSON.parse(localStorage.getItem(LIKES_KEY) || "{}");
      map[id] = (map[id] || 0) + 1;
      localStorage.setItem(LIKES_KEY, JSON.stringify(map));
      return map[id];
    } catch {
      return 1;
    }
  }
}

async function registerScenePlay(id: string): Promise<number | null> {
  try {
    const result = await client.mutate<
      GQL.SceneAddPlayMutation,
      GQL.SceneAddPlayMutationVariables
    >({
      mutation: GQL.SceneAddPlayDocument,
      variables: { id },
    });
    // sceneAddPlay returns { count, history }. count is the new play count
    const r = result.data?.sceneAddPlay;
    if (r && typeof r.count === "number") return r.count;
    return null;
  } catch (e) {
    console.warn("[feed] play count register failed", e);
    return null;
  }
}

// sceneSaveActivity is Stash's existing mutation for persisting play_duration
// (and resume_time). We call it periodically with the additional seconds the
// user watched since the last call, the server adds the increment.
async function saveSceneActivity(
  id: string,
  resumeTime: number,
  durationDelta: number
): Promise<void> {
  if (durationDelta <= 0) return;
  try {
    await client.mutate<
      GQL.SceneSaveActivityMutation,
      GQL.SceneSaveActivityMutationVariables
    >({
      mutation: GQL.SceneSaveActivityDocument,
      variables: { id, resume_time: resumeTime, playDuration: durationDelta },
    });
  } catch (e) {
    console.warn("[feed] sceneSaveActivity failed", e);
  }
}

async function incrementSceneO(id: string): Promise<number | null> {
  try {
    const result = await client.mutate<
      GQL.SceneAddOMutation,
      GQL.SceneAddOMutationVariables
    >({
      mutation: GQL.SceneAddODocument,
      variables: { id },
    });
    return result.data?.sceneAddO?.count ?? null;
  } catch (e) {
    console.warn("[feed] sceneAddO failed", e);
    return null;
  }
}

const O_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per scene
const O_LAST_KEY = (id: string) => `feed.o.last.${id}`;
function getLastOAt(id: string): number {
  try {
    const v = localStorage.getItem(O_LAST_KEY(id));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}
function setLastOAt(id: string, ts: number) {
  try {
    localStorage.setItem(O_LAST_KEY(id), String(ts));
  } catch {
    /* ignore */
  }
}

async function setSceneRating(id: string, rating100: number) {
  try {
    await client.mutate<GQL.SceneUpdateMutation, GQL.SceneUpdateMutationVariables>({
      mutation: GQL.SceneUpdateDocument,
      variables: { input: { id, rating100 } },
    });
  } catch (e) {
    console.warn("[feed] setRating failed", e);
  }
}

function toggleFullscreen(el: HTMLElement | null) {
  if (!el) return;
  const doc = document as any;
  const anyEl = el as any;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen ||
      doc.webkitExitFullscreen ||
      doc.mozCancelFullScreen ||
      doc.msExitFullscreen)?.call(doc);
  } else {
    (anyEl.requestFullscreen ||
      anyEl.webkitRequestFullscreen ||
      anyEl.webkitEnterFullscreen ||
      anyEl.mozRequestFullScreen ||
      anyEl.msRequestFullscreen)?.call(anyEl);
  }
}

// ───────── components ─────────

interface FeedItemProps {
  scene: Scene;
  muted: boolean;
  onToggleMute: () => void;
  onSkip: () => void;
  onSpawnHearts: (x: number, y: number, count: number) => void;
  onSpawnDrops: (x: number, y: number, count: number) => void;
}

const FeedItem: React.FC<FeedItemProps> = ({
  scene,
  muted,
  onToggleMute,
  onSkip,
  onSpawnHearts,
  onSpawnDrops,
}) => {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);

  // Use scene.like_count when available; fall back to local cache.
  const [likeCount, setLikeCount] = useState<number>(
    () => (scene as any).like_count ?? getLikeCount(scene.id)
  );
  const [oCount, setOCount] = useState<number>(scene.o_counter ?? 0);
  const [playCount, setPlayCount] = useState<number>(scene.play_count ?? 0);
  const [liking, setLiking] = useState(false);
  const [oing, setOing] = useState(false);
  const [pulse, setPulse] = useState<"play" | "pause" | "back" | "fwd" | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Show the same centred chip on keyboard seek (ArrowLeft / ArrowRight)
  // as on edge-tap. Feed dispatches `feed-pulse-trigger` on the active
  // .feed-item with detail "back" or "fwd"; we just mirror it into local
  // pulse state with the same 600 ms auto-clear timer.
  useEffect(() => {
    const item = itemRef.current;
    if (!item) return;
    function onPulse(e: Event) {
      const kind = (e as CustomEvent).detail as
        | "play"
        | "pause"
        | "back"
        | "fwd";
      if (kind !== "play" && kind !== "pause" && kind !== "back" && kind !== "fwd") return;
      setPulse(kind);
      if (pulseTimerRef.current != null) window.clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = window.setTimeout(() => setPulse(null), 600);
    }
    item.addEventListener("feed-pulse-trigger", onPulse as EventListener);
    return () => {
      item.removeEventListener("feed-pulse-trigger", onPulse as EventListener);
    };
  }, []);

  const previewSrc = useMemo(
    () => relativize(scene.paths.stream || scene.paths.preview),
    [scene.paths.stream, scene.paths.preview]
  );
  const posterSrc = useMemo(() => relativize(scene.paths.screenshot), [scene.paths.screenshot]);

  // Set the wrap aspect-ratio from the video's intrinsic dimensions so the
  // CSS height: 100% rule scales it to viewport height regardless of source
  // resolution.
  useEffect(() => {
    const v = videoRef.current;
    const w = wrapRef.current;
    if (!v || !w) return;
    function applyAspect() {
      if (!v || !w) return;
      if (v.videoWidth && v.videoHeight) {
        w.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
      }
    }
    v.addEventListener("loadedmetadata", applyAspect);
    applyAspect();
    return () => v.removeEventListener("loadedmetadata", applyAspect);
  }, []);

  // Progress bar timeupdate
  useEffect(() => {
    const v = videoRef.current;
    const b = barRef.current;
    if (!v || !b) return;
    const onUpdate = () => {
      if (v.duration && isFinite(v.duration)) {
        b.style.width = `${(v.currentTime / v.duration) * 100}%`;
      }
    };
    v.addEventListener("timeupdate", onUpdate);
    return () => v.removeEventListener("timeupdate", onUpdate);
  }, []);

  // Seek (click + drag on progress)
  useEffect(() => {
    const p = progressRef.current;
    const v = videoRef.current;
    if (!p || !v) return;
    let scrubbing = false;
    function seek(ev: PointerEvent | MouseEvent | TouchEvent) {
      const rect = p!.getBoundingClientRect();
      const clientX =
        "touches" in ev
          ? (ev as TouchEvent).touches[0]?.clientX ?? 0
          : (ev as MouseEvent).clientX;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (v!.duration && isFinite(v!.duration)) {
        v!.currentTime = ratio * v!.duration;
        if (barRef.current) barRef.current.style.width = `${ratio * 100}%`;
      }
    }
    function down(ev: PointerEvent | MouseEvent | TouchEvent) {
      (ev as Event).stopPropagation();
      scrubbing = true;
      p!.classList.add("scrubbing");
      seek(ev);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
    }
    function move(ev: MouseEvent | TouchEvent) {
      if (!scrubbing) return;
      if ((ev as Event).cancelable) ev.preventDefault();
      seek(ev);
    }
    function up() {
      scrubbing = false;
      p!.classList.remove("scrubbing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    }
    p.addEventListener("mousedown", down as EventListener);
    p.addEventListener("touchstart", down as EventListener, { passive: true });
    return () => {
      p.removeEventListener("mousedown", down as EventListener);
      p.removeEventListener("touchstart", down as EventListener);
    };
  }, []);

  // Double-click to fullscreen, desktop only. On touch devices a quick
  // double-tap on the edge of the video accidentally triggered fullscreen
  // when the user actually wanted edge-tap seek. Gate on `hover: hover`
  // which is true on pointer devices and false on touch-only ones.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!window.matchMedia("(hover: hover)").matches) return;
    function onDbl(ev: Event) {
      ev.preventDefault();
      ev.stopPropagation();
      toggleFullscreen(v);
    }
    v.addEventListener("dblclick", onDbl);
    return () => v.removeEventListener("dblclick", onDbl);
  }, []);

  // Apply mute when prop changes
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  // Robust load/play + buffering UI: handle slow initial buffering and "stuck"
  // states. The IO handler calls play() the moment a tile crosses the
  // visibility threshold, but if src was only just assigned the play() promise
  // rejects and the tile sits on its poster. Re-trigger play() on every canplay,
  // and surface a centered loader + buffered % so the user sees progress.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let stuckTimer: number | null = null;
    let loaderTimer: number | null = null;
    let waitingSince = 0;
    let lastTime = 0;
    let lastTimeAt = 0;
    const showLoader = () => {
      if (loaderTimer != null) return;
      // Defer 250ms so a quick load doesn't flash a loader frame. At the
      // deadline, only commit to "loading" if the video is genuinely stuck:
      // either paused, or its readyState is below HAVE_FUTURE_DATA (3), i.e.
      // the browser doesn't have enough buffered to keep playing forward.
      // Brief mid-playback network hiccups stop firing waiting/stalled by then
      // and we leave the UI alone.
      loaderTimer = window.setTimeout(() => {
        if (v.paused || v.readyState < 3) setLoading(true);
        loaderTimer = null;
      }, 250);
    };
    const hideLoader = () => {
      if (loaderTimer != null) {
        window.clearTimeout(loaderTimer);
        loaderTimer = null;
      }
      setLoading(false);
    };
    const tryPlay = () => {
      if (!v.paused) return;
      const rect = v.getBoundingClientRect();
      const inView = rect.top < window.innerHeight && rect.bottom > 0;
      if (!inView) return;
      v.play().catch(() => {});
    };
    const onCanPlay = () => {
      hideLoader();
      tryPlay();
    };
    const onWaiting = () => {
      waitingSince = performance.now();
      showLoader();
      if (stuckTimer != null) window.clearTimeout(stuckTimer);
      stuckTimer = window.setTimeout(() => {
        if (v.readyState < 3 && performance.now() - waitingSince >= 2900) {
          try { v.load(); } catch { /* ignore */ }
          tryPlay();
        }
      }, 3000);
    };
    const onPlaying = () => {
      waitingSince = 0;
      hideLoader();
      if (stuckTimer != null) {
        window.clearTimeout(stuckTimer);
        stuckTimer = null;
      }
    };
    const onError = () => {
      showLoader();
      try { v.load(); } catch { /* ignore */ }
      window.setTimeout(tryPlay, 500);
    };
    const onTimeUpdate = () => {
      if (v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        lastTimeAt = performance.now();
      }
    };
    const onLoadStart = () => {
      // Only spin the loader for a fresh load if we're not already mid-playback
      // (load() can be called by the watchdog while the video is actually
      // playing; in that case the next progress event flips us back).
      if (v.paused && v.readyState < 3) showLoader();
    };
    // Hard guarantee: any time the element transitions out of paused into
    // playing, the loader is off. This covers cases where `waiting` fires
    // alongside `playing` (Chrome occasionally emits waiting on segment
    // boundaries for transcoded streams).
    const onPlay = () => hideLoader();
    // Watchdog: if the active tile claims to be playing but currentTime hasn't
    // advanced for 4 s, force a load() + play().
    const watchdog = window.setInterval(() => {
      if (v.paused || v.ended) return;
      if (!lastTimeAt) {
        lastTimeAt = performance.now();
        return;
      }
      if (performance.now() - lastTimeAt > 4000 && v.readyState < 3) {
        try { v.load(); } catch { /* ignore */ }
        tryPlay();
        lastTimeAt = performance.now();
      }
    }, 2000);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("loadeddata", onCanPlay);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("stalled", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("error", onError);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("loadstart", onLoadStart);
    v.addEventListener("play", onPlay);
    return () => {
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("loadeddata", onCanPlay);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("stalled", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("error", onError);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("loadstart", onLoadStart);
      v.removeEventListener("play", onPlay);
      if (stuckTimer != null) window.clearTimeout(stuckTimer);
      if (loaderTimer != null) window.clearTimeout(loaderTimer);
      window.clearInterval(watchdog);
    };
  }, [scene.id]);

  // Register a play with Stash after 3s of continuous playback + track real
  // watched seconds and flush to sceneSaveActivity every 10s (and on
  // pause/end/unmount). This is what the Top Watched + Watched Tags buckets
  // feed on, without it, Stash never learns how much time you actually spent.
  const playTimerRef = useRef<number | null>(null);
  const playRegisteredRef = useRef(false);
  const watchedSinceLastFlushRef = useRef(0);
  // Cumulative seconds the user spent viewing THIS scene this mount. Not
  // reset by flush(), used by skip-learning on unmount to decide whether
  // the user genuinely watched (>= SKIP_THRESHOLD_SEC) or just skipped past.
  const sceneViewedTotalRef = useRef(0);
  const lastTickAtRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const FLUSH_INTERVAL_MS = 10_000;
    const flush = () => {
      const delta = Math.round(watchedSinceLastFlushRef.current);
      if (delta <= 0) return;
      watchedSinceLastFlushRef.current = 0;
      saveSceneActivity(scene.id, v.currentTime || 0, delta);
    };
    function startTracking() {
      lastTickAtRef.current = performance.now();
      if (playRegisteredRef.current) return;
      if (playTimerRef.current != null) {
        window.clearTimeout(playTimerRef.current);
      }
      playTimerRef.current = window.setTimeout(async () => {
        if (!playRegisteredRef.current) {
          playRegisteredRef.current = true;
          setPlayCount((c) => c + 1);
          const serverCount = await registerScenePlay(scene.id);
          if (typeof serverCount === "number") {
            setPlayCount(serverCount);
          }
        }
      }, 3000);
      if (flushTimerRef.current == null) {
        flushTimerRef.current = window.setInterval(flush, FLUSH_INTERVAL_MS);
      }
    }
    function stopTracking() {
      if (playTimerRef.current != null) {
        window.clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
      // Tally the partial slice between the last tick and the pause.
      if (lastTickAtRef.current != null) {
        const slice = (performance.now() - lastTickAtRef.current) / 1000;
        if (slice > 0 && slice < 60) {
          watchedSinceLastFlushRef.current += slice;
          sceneViewedTotalRef.current += slice;
        }
        lastTickAtRef.current = null;
      }
      flush();
      if (flushTimerRef.current != null) {
        window.clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    }
    // While playing, every timeupdate event adds the elapsed wall-clock since
    // the last event (capped at 1s per tick so big seeks don't get counted as
    // watched seconds).
    function onTimeUpdateForActivity() {
      if (!v || v.paused || lastTickAtRef.current == null) return;
      const now = performance.now();
      const slice = (now - lastTickAtRef.current) / 1000;
      lastTickAtRef.current = now;
      if (slice > 0 && slice <= 1.5) {
        watchedSinceLastFlushRef.current += slice;
        sceneViewedTotalRef.current += slice;
      }
    }
    // Belt-and-suspenders: also flush when the page is hidden or about to
    // unload. Catches the "user closed the tab without scrolling away"
    // case where component unmount may not have time to fire a mutation.
    const onPageHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    v.addEventListener("play", startTracking);
    v.addEventListener("pause", stopTracking);
    v.addEventListener("ended", stopTracking);
    v.addEventListener("timeupdate", onTimeUpdateForActivity);
    document.addEventListener("visibilitychange", onPageHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      v.removeEventListener("play", startTracking);
      v.removeEventListener("pause", stopTracking);
      v.removeEventListener("ended", stopTracking);
      v.removeEventListener("timeupdate", onTimeUpdateForActivity);
      document.removeEventListener("visibilitychange", onPageHidden);
      window.removeEventListener("pagehide", flush);
      stopTracking();
      // Skip-learning: when this tile leaves (user scrolled away or
      // navigated off the feed), if they spent less than the threshold on
      // it, treat it as a skip and bump every tag's skip count. Top buckets
      // exclude scenes whose tags accumulate too many skips.
      if (
        sceneViewedTotalRef.current < SKIP_THRESHOLD_SEC &&
        scene.tags &&
        scene.tags.length > 0
      ) {
        recordTagSkips(scene.tags.map((t) => t.id));
      }
    };
  }, [scene.id, scene.tags]);

  const handleLike = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      // Optimistic UI bump. The mutation result replaces this with the real count.
      setLikeCount((prev) => prev + 1);
      setLiking(true);
      window.setTimeout(() => setLiking(false), 600);

      const rect = e.currentTarget.getBoundingClientRect();
      onSpawnHearts(rect.left + rect.width / 2, rect.top + rect.height / 2, 5);

      bumpLike(scene.id).then((next) => {
        setLikeCount(next);
        if (next === LIKE_THRESHOLD) {
          for (let wave = 0; wave < 4; wave++) {
            window.setTimeout(() => {
              onSpawnHearts(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
                5
              );
            }, 80 * wave);
          }
          setSceneRating(scene.id, 100);
        }
      });
    },
    [scene.id, onSpawnHearts]
  );

  const [oCooldownUntil, setOCooldownUntil] = useState<number>(() =>
    getLastOAt(scene.id) + O_COOLDOWN_MS
  );
  const handleO = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const now = Date.now();
      if (now < oCooldownUntil) return; // 1-hour rate-limit per scene
      setOing(true);
      window.setTimeout(() => setOing(false), 600);
      setOCount((c) => c + 1);
      setLastOAt(scene.id, now);
      setOCooldownUntil(now + O_COOLDOWN_MS);
      // Splash on a wide area, burst from the button, plus secondary bursts
      // around the viewport centre so it feels like the whole screen reacts.
      const rect = e.currentTarget.getBoundingClientRect();
      const bx = rect.left + rect.width / 2;
      const by = rect.top + rect.height / 2;
      onSpawnDrops(bx, by, 18);
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      onSpawnDrops(cx, cy, 16);
      // A couple of delayed sub-bursts for the wave-after-wave feel
      window.setTimeout(
        () => onSpawnDrops(cx + (Math.random() - 0.5) * 200, cy + (Math.random() - 0.5) * 200, 12),
        90
      );
      window.setTimeout(
        () => onSpawnDrops(cx + (Math.random() - 0.5) * 300, cy + (Math.random() - 0.5) * 300, 10),
        180
      );
      const newCount = await incrementSceneO(scene.id);
      if (typeof newCount === "number") setOCount(newCount);
    },
    [scene.id, oCooldownUntil, onSpawnDrops]
  );

  const handleVideoClick = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
    const v = videoRef.current;
    if (!v) return;
    e.preventDefault();
    // Edge-tap seek: left 10% rewinds 10s, right 10% advances 10s. Middle
    // 80% keeps the original play/pause toggle. Resolves from the video
    // element's own bounding rect so the hit zones scale with the tile.
    const rect = v.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = rect.width > 0 ? x / rect.width : 0.5;
    if (ratio < 0.1) {
      if (Number.isFinite(v.duration)) {
        v.currentTime = Math.max(0, v.currentTime - 10);
      }
      setPulse("back");
    } else if (ratio > 0.9) {
      if (Number.isFinite(v.duration)) {
        v.currentTime = Math.min(v.duration - 0.1, v.currentTime + 10);
      }
      setPulse("fwd");
    } else if (v.paused) {
      v.play().catch(() => {});
      setPulse("play");
    } else {
      v.pause();
      setPulse("pause");
    }
    if (pulseTimerRef.current != null) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => setPulse(null), 600);
  }, []);

  const performer = scene.performers?.[0];
  const performerImage = performer?.image_path ? relativize(performer.image_path) : "";
  const tags = scene.tags ?? [];
  const title =
    scene.title || scene.files?.[0]?.basename || `Scene ${scene.id}`;

  return (
    <div className="feed-item" ref={itemRef} data-scene-id={scene.id}>
      <div className="feed-stage">
        <div
          className={`feed-video-wrap${loading ? " is-loading" : ""}`}
          ref={wrapRef}
        >
          <video
            className="feed-video"
            ref={videoRef}
            poster={posterSrc || undefined}
            data-src={previewSrc}
            muted={muted}
            playsInline
            loop
            preload="metadata"
            onClick={handleVideoClick}
          />
          <div className="feed-progress" ref={progressRef}>
            <div className="feed-progress-bar" ref={barRef} />
          </div>
          {pulse && (
            <div className={`feed-pulse feed-pulse-${pulse}`} aria-hidden="true">
              {pulse === "play" && (
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              )}
              {pulse === "pause" && (
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              )}
              {pulse === "fwd" && (
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <polygon points="3 4 13 12 3 20 3 4" />
                  <polygon points="13 4 22 12 13 20 13 4" />
                </svg>
              )}
              {pulse === "back" && (
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <polygon points="21 4 11 12 21 20 21 4" />
                  <polygon points="11 4 2 12 11 20 11 4" />
                </svg>
              )}
            </div>
          )}
          <div className="feed-overlay">
            <div className="feed-meta">
              <div className="feed-title">{title}</div>
              {tags.length > 0 && (
                <div className="feed-tags">
                  {tags.map((t) => (
                    <span key={t.id}>#{t.name}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="feed-actions">
          {performerImage && performer && (
            <Link
              className="feed-avatar"
              to={`/performers/${performer.id}`}
              title={performer.name}
            >
              <img src={performerImage} alt={performer.name} loading="lazy" />
            </Link>
          )}

          <button
            type="button"
            className={`feed-action feed-like-btn${liking ? " liking" : ""}`}
            title="Like"
            onClick={handleLike}
          >
            <HeartIcon filled={likeCount > 0} />
            <span className="feed-count">{likeCount}</span>
          </button>

          <button
            type="button"
            className={`feed-action feed-o-btn${oing ? " liking" : ""}${
              Date.now() < oCooldownUntil ? " cooldown" : ""
            }`}
            title={
              Date.now() < oCooldownUntil
                ? "Cooldown (1 per hour)"
                : "O (+1)"
            }
            disabled={Date.now() < oCooldownUntil}
            onClick={handleO}
          >
            <DropIcon />
            <span className="feed-count">{oCount}</span>
          </button>

          <div className="feed-action feed-play-count" title="Play count">
            <EyeIcon />
            <span className="feed-count">{playCount}</span>
          </div>

          <Link
            className="feed-action feed-open-btn"
            to={`/scenes/${scene.id}`}
            title="Open scene"
          >
            <OpenSceneIcon />
          </Link>

          <button
            type="button"
            className="feed-action feed-mute-toggle"
            title="Toggle sound"
            onClick={(e) => {
              e.preventDefault();
              onToggleMute();
            }}
          >
            {muted ? <MuteOffIcon /> : <MuteOnIcon />}
          </button>

          <button
            type="button"
            className="feed-action feed-fs-btn"
            title="Fullscreen (double-click video for video-only fullscreen)"
            onClick={(e) => {
              e.preventDefault();
              // Try document-fullscreen first (desktop, modern Android).
              // iOS Safari rejects requestFullscreen on non-video elements, so
              // fall back to the video's webkitEnterFullscreen, which is the
              // only fullscreen path iOS actually exposes.
              const docEl = document.documentElement as HTMLElement & {
                webkitRequestFullscreen?: () => Promise<void> | void;
                mozRequestFullScreen?: () => Promise<void> | void;
                msRequestFullscreen?: () => Promise<void> | void;
              };
              const doc = document as Document & {
                fullscreenElement?: Element | null;
                webkitFullscreenElement?: Element | null;
                exitFullscreen?: () => Promise<void>;
                webkitExitFullscreen?: () => Promise<void>;
              };
              if (doc.fullscreenElement || doc.webkitFullscreenElement) {
                (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
                return;
              }
              const req =
                docEl.requestFullscreen ||
                docEl.webkitRequestFullscreen ||
                docEl.mozRequestFullScreen ||
                docEl.msRequestFullscreen;
              if (req) {
                Promise.resolve(req.call(docEl)).catch(() => {
                  // iOS Safari throws here. Fall back to video element.
                  toggleFullscreen(videoRef.current);
                });
              } else {
                // No document-fullscreen support at all (older iOS Safari).
                toggleFullscreen(videoRef.current);
              }
            }}
          >
            <FullscreenIcon />
          </button>

          <button
            type="button"
            className="feed-action feed-skip-btn"
            title="Skip"
            onClick={(e) => {
              e.preventDefault();
              markViewed(scene.id);
              onSkip();
            }}
          >
            <SkipIcon />
          </button>
        </div>
      </div>
    </div>
  );
};

export const Feed: React.FC = () => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const loadingMoreRef = useRef(false);
  const currentVisibleRef = useRef<HTMLDivElement | null>(null);

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loadedIds] = useState<Set<string>>(() => new Set());
  const [feedState, setFeedState] = useState<"loading" | "ready" | "empty">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [debugInfo, setDebugInfo] = useState<string>("");
  const [muted, setMuted] = useState<boolean>(
    () => sessionStorage.getItem(MUTED_KEY) !== "0"
  );
  const [hearts, setHearts] = useState<HeartParticle[]>([]);
  const [drops, setDrops] = useState<DropParticle[]>([]);
  const dropIdRef = useRef(0);
  const [dailyWrap, setDailyWrap] = useState<DailyWrap | null>(null);

  // Filter chips. Chip defs live in Stash's server-side UI config and the
  // UI for choosing/toggling them lives in the FeedChipIsland (top-right).
  // Here we only need to (a) keep the algorithm.settings localStorage blob
  // in sync from the server so buildQueue picks up the latest chip set, and
  // (b) rebuild the queue any time the chip-active state changes.
  useEffect(() => {
    let cancelled = false;
    function mirrorServerChips(server: FilterChip[]) {
      try {
        const cur = JSON.parse(
          localStorage.getItem("algorithm.settings") || "{}"
        );
        localStorage.setItem(
          "algorithm.settings",
          JSON.stringify({ ...cur, filterChips: server })
        );
      } catch {
        /* ignore */
      }
    }
    loadFilterChipsFromServer().then((server) => {
      if (cancelled || !server) return;
      mirrorServerChips(server);
      setReloadKey((k) => k + 1);
    });
    function onSettingsChange() {
      loadFilterChipsFromServer().then((server) => {
        if (cancelled || !server) return;
        mirrorServerChips(server);
        setReloadKey((k) => k + 1);
      });
    }
    function onActiveChange() {
      // The chip island already wrote the new active list to localStorage.
      // Just rebuild the queue, the algorithm reads chips and active from
      // localStorage at the top of buildQueue.
      setReloadKey((k) => k + 1);
    }
    window.addEventListener(ALGORITHM_SETTINGS_EVENT, onSettingsChange);
    window.addEventListener(
      "stashhub:feed-chip-active-changed",
      onActiveChange as EventListener
    );
    return () => {
      cancelled = true;
      window.removeEventListener(ALGORITHM_SETTINGS_EVENT, onSettingsChange);
      window.removeEventListener(
        "stashhub:feed-chip-active-changed",
        onActiveChange as EventListener
      );
    };
  }, []);

  // Persist mute per tab
  useEffect(() => {
    sessionStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  }, [muted]);

  // Daily wrap: once per local-calendar-day, fetch yesterday's stats and
  // show a small card. Mark today as shown so it doesn't reappear until
  // the next day. Auto-dismiss after WRAP_DISMISS_MS or on first swipe.
  useEffect(() => {
    const today = todayKey();
    if (localStorage.getItem(WRAP_LAST_SHOWN_KEY) === today) return;
    let cancelled = false;
    fetchYesterdayWrap().then((wrap) => {
      if (cancelled || !wrap) return;
      setDailyWrap(wrap);
      try {
        localStorage.setItem(WRAP_LAST_SHOWN_KEY, today);
      } catch {
        /* ignore */
      }
      window.setTimeout(() => setDailyWrap(null), WRAP_DISMISS_MS);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Dismiss the card on first scroll within the feed.
  useEffect(() => {
    if (!dailyWrap) return;
    const t = trackRef.current;
    if (!t) return;
    const onScroll = () => setDailyWrap(null);
    t.addEventListener("scroll", onScroll, { once: true, passive: true });
    return () => t.removeEventListener("scroll", onScroll);
  }, [dailyWrap]);

  // Initial load. Resumes the saved scene if one is present.
  useEffect(() => {
    let cancelled = false;
    setFeedState("loading");
    setDebugInfo("");
    (async () => {
      const viewed = getViewed();
      const savedId = localStorage.getItem(CURRENT_KEY) || "";

      // Build the queue with the saved id excluded; it is prepended below.
      const exclude = new Set(viewed);
      if (savedId) exclude.add(savedId);
      let debug = `viewed:${viewed.size} savedId:${savedId || "(none)"}`;
      const ids = await buildQueue({ targetCount: QUEUE_TARGET, exclude });
      if (cancelled) return;
      debug += ` | buildQueue→${ids.length} ids`;

      const finalIds = savedId ? [savedId, ...ids] : ids;
      const details = await fetchSceneDetails(finalIds);
      if (cancelled) return;
      debug += ` | fetchSceneDetails(${finalIds.length})→${details.length}`;
      setDebugInfo(debug);

      // Clear the saved id if its scene is no longer present in the response.
      if (savedId && !details.some((s) => s.id === savedId)) {
        try { localStorage.removeItem(CURRENT_KEY); } catch { /* ignore */ }
      }

      details.forEach((s) => loadedIds.add(s.id));
      setScenes(details);
      setFeedState(details.length ? "ready" : "empty");

      // After paint, jump-scroll to the saved scene
      if (savedId && details.length) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const target = trackRef.current?.querySelector<HTMLDivElement>(
              `.feed-item[data-scene-id="${CSS.escape(savedId)}"]`
            );
            if (target && trackRef.current) {
              trackRef.current.scrollTo({ top: target.offsetTop, behavior: "auto" });
            }
          });
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Persist the active scene id
  const persistCurrent = useCallback((sceneId: string | undefined) => {
    if (!sceneId) return;
    try { localStorage.setItem(CURRENT_KEY, sceneId); } catch { /* ignore */ }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const viewed = getViewed();
      const exclude = new Set([...viewed, ...loadedIds]);
      const ids = await buildQueue({ targetCount: 20, exclude });
      const details = await fetchSceneDetails(ids);
      details.forEach((s) => loadedIds.add(s.id));
      setScenes((prev) => [...prev, ...details]);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [loadedIds]);

  // IntersectionObserver: play/pause + lazy src + load more + meta show
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    ioRef.current?.disconnect();

    // Per-item 10s meta-fade timers (clear on un-mount or re-trigger)
    const fadeTimers = new WeakMap<HTMLDivElement, number>();

    function showMetaAndScheduleFade(item: HTMLDivElement) {
      item.classList.remove("meta-faded");
      // Force reflow so a transition restarts even when class was just removed
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void item.offsetWidth;
      const prev = fadeTimers.get(item);
      if (prev) window.clearTimeout(prev);
      const t = window.setTimeout(() => {
        item.classList.add("meta-faded");
      }, 10000);
      fadeTimers.set(item, t);
    }

    // Live-transcode pre-warm. Stash builds the streaming MP4 on demand:
    // CIFS open + ffmpeg startup + first GOP encoded before any bytes
    // reach the browser. Issuing a Range request for the first ~512 KB
    // ahead of time kicks that whole chain off, so by the time the user
    // scrolls onto the tile the transcode is already running and bytes
    // are already in the kernel buffer. Dedupe in-flight by URL, abort
    // when we slide past so we don't keep transcoding scenes the user
    // already left behind.
    const warmedUrls: Map<string, AbortController> = (window as any).__feedWarmedUrls
      ?? new Map<string, AbortController>();
    (window as any).__feedWarmedUrls = warmedUrls;
    function warmStreamUrl(url: string) {
      if (warmedUrls.has(url)) return;
      const ac = new AbortController();
      warmedUrls.set(url, ac);
      // GET with a small Range. The fetch is deliberately not awaited;
      // we just want the request on the wire. Errors are silent: any
      // failure mode (offline, 403 expired token) is better handled by
      // the actual video element when it gets its turn.
      fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-524287" },
        cache: "no-store",
        signal: ac.signal,
        credentials: "same-origin",
      })
        .then((r) => r.arrayBuffer().catch(() => null))
        .catch(() => null);
    }
    function abortFarWarms(keepUrls: Set<string>) {
      for (const [url, ac] of Array.from(warmedUrls.entries())) {
        if (!keepUrls.has(url)) {
          try { ac.abort(); } catch { /* ignore */ }
          warmedUrls.delete(url);
        }
      }
    }

    function ensureNeighborSrcs(activeItem: HTMLDivElement) {
      // Prime: active + N ahead use preload="auto" so a swipe-down has no
      // buffer pause. N is bumped on desktop because we can spare the
      // bandwidth there; on mobile we stay conservative.
      const items = Array.from(track!.querySelectorAll<HTMLDivElement>(".feed-item"));
      const idx = items.indexOf(activeItem);
      if (idx === -1) return;
      const isDesktop = typeof window.matchMedia === "function"
        && window.matchMedia("(hover: hover)").matches;
      const aheadAggressive = isDesktop ? 3 : 2;
      const aheadSrcOnly = aheadAggressive + 1;
      const start = Math.max(0, idx - 1);
      const end = Math.min(items.length - 1, idx + aheadSrcOnly);
      const keepWarm = new Set<string>();
      for (let i = start; i <= end; i++) {
        const it = items[i];
        const v = it.querySelector<HTMLVideoElement>("video.feed-video");
        if (!v) continue;
        const aggressive = i >= idx && i <= idx + aheadAggressive;
        const desiredPreload = aggressive ? "auto" : "metadata";
        if (v.preload !== desiredPreload) v.preload = desiredPreload;
        const src = v.dataset.src;
        if (src && !v.src) {
          v.src = src;
          try { v.load(); } catch { /* ignore */ }
        }
        // Pre-warm the stream URL for the active item and the next ones.
        // Skip the already-active tile (its <video> is already pulling).
        if (src && i > idx && i <= idx + aheadAggressive) {
          keepWarm.add(src);
          warmStreamUrl(src);
        }
      }
      abortFarWarms(keepWarm);
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const item = entry.target as HTMLDivElement;
          const video = item.querySelector<HTMLVideoElement>("video.feed-video");
          if (!video) return;
          if (entry.intersectionRatio >= 0.7) {
            ensureNeighborSrcs(item);
            video.muted = muted;
            video.play().catch(() => {});
            currentVisibleRef.current = item;
            const id = item.dataset.sceneId;
            if (id) {
              markViewed(id);
              persistCurrent(id);
            }
            // Reset meta visibility for the new active item
            showMetaAndScheduleFade(item);
            // Refill if near end
            const items = track.querySelectorAll(".feed-item");
            const idx = Array.from(items).indexOf(item);
            if (items.length - idx <= REFILL_AT) loadMore();
          } else if (entry.intersectionRatio < 0.3) {
            video.pause();
          }
        });
      },
      { root: track, threshold: [0, 0.3, 0.5, 0.7, 0.9, 1] }
    );
    ioRef.current = io;
    track.querySelectorAll(".feed-item").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [scenes, muted, loadMore, persistCurrent]);

  // Keyboard nav
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = trackRef.current;
      if (!t) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        t.scrollBy({ top: t.clientHeight, behavior: "smooth" });
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        t.scrollBy({ top: -t.clientHeight, behavior: "smooth" });
      } else if (e.key === "ArrowRight" || e.key === "l" || e.key === "L") {
        // Seek the currently-visible video forward 10s and fire the same
        // pulse chip the edge-tap shows, so keyboard nav gets the same
        // visual confirmation as touch.
        e.preventDefault();
        const item = currentVisibleRef.current;
        const v = item?.querySelector<HTMLVideoElement>("video");
        if (v && Number.isFinite(v.duration)) {
          v.currentTime = Math.min(v.duration - 0.1, v.currentTime + 10);
        }
        item?.dispatchEvent(
          new CustomEvent("feed-pulse-trigger", { detail: "fwd" })
        );
      } else if (e.key === "ArrowLeft" || e.key === "h" || e.key === "H") {
        e.preventDefault();
        const item = currentVisibleRef.current;
        const v = item?.querySelector<HTMLVideoElement>("video");
        if (v) {
          v.currentTime = Math.max(0, v.currentTime - 10);
        }
        item?.dispatchEvent(
          new CustomEvent("feed-pulse-trigger", { detail: "back" })
        );
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setMuted((m) => !m);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const scrollBy = useCallback((dir: 1 | -1) => {
    const t = trackRef.current;
    if (!t) return;
    t.scrollBy({ top: dir * t.clientHeight, behavior: "smooth" });
  }, []);

  const handleSkip = useCallback(() => scrollBy(1), [scrollBy]);
  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  // Drop splash spawner, burst outward in a radial pattern, with a downward
  // bias and rotation for a "wet" feel. Travels far so the whole viewport sees
  // it, not just a small area near the button.
  const spawnDrops = useCallback((x: number, y: number, count: number) => {
    const fresh: DropParticle[] = [];
    for (let i = 0; i < count; i++) {
      const id = dropIdRef.current++;
      const baseAngle = (i / count) * Math.PI * 2;
      const angle = baseAngle + (Math.random() - 0.5) * 0.6;
      const distance = 220 + Math.random() * 420;
      fresh.push({
        id,
        x: x + (Math.random() - 0.5) * 40,
        y: y + (Math.random() - 0.5) * 40,
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance + 120, // downward bias = gravity
        rot: (Math.random() - 0.5) * 540,
        size: 28 + Math.random() * 32,
        color: DROP_COLORS[Math.floor(Math.random() * DROP_COLORS.length)],
        dur: 800 + Math.random() * 700,
      });
    }
    setDrops((prev) => [...prev, ...fresh]);
    fresh.forEach((p) => {
      window.setTimeout(() => {
        setDrops((prev) => prev.filter((d) => d.id !== p.id));
      }, p.dur + 60);
    });
  }, []);

  // Heart particle spawner
  const heartIdRef = useRef(0);
  const spawnHearts = useCallback((x: number, y: number, count: number) => {
    const fresh: HeartParticle[] = [];
    for (let i = 0; i < count; i++) {
      const id = heartIdRef.current++;
      fresh.push({
        id,
        x: x + (Math.random() - 0.5) * 20,
        y: y + (Math.random() - 0.5) * 10,
        driftX: (Math.random() - 0.5) * 120,
        rise: 140 + Math.random() * 80,
        rot: (Math.random() - 0.5) * 80,
        size: 22 + Math.random() * 18,
        color: HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)],
        dur: 900 + Math.random() * 500,
      });
    }
    setHearts((prev) => [...prev, ...fresh]);
    fresh.forEach((p) => {
      window.setTimeout(() => {
        setHearts((prev) => prev.filter((h) => h.id !== p.id));
      }, p.dur + 60);
    });
  }, []);

  return (
    <div className="feed-root">
      {dailyWrap && (
        <DailyWrapCard data={dailyWrap} onDismiss={() => setDailyWrap(null)} />
      )}
      <div className="feed-track" ref={trackRef}>
        {scenes.map((s) => (
          <FeedItem
            key={s.id}
            scene={s}
            muted={muted}
            onToggleMute={toggleMute}
            onSkip={handleSkip}
            onSpawnHearts={spawnHearts}
            onSpawnDrops={spawnDrops}
          />
        ))}
        {scenes.length === 0 && feedState === "loading" && (
          <div className="feed-loading">Loading…</div>
        )}
        {scenes.length === 0 && feedState === "empty" && (
          <div className="feed-empty">
            <div className="feed-empty-msg">No videos in queue.</div>
            <div className="feed-empty-debug">{debugInfo}</div>
            <button
              type="button"
              className="feed-empty-retry"
              onClick={() => {
                try { localStorage.removeItem(CURRENT_KEY); } catch { /* ignore */ }
                setReloadKey((k) => k + 1);
              }}
            >
              Clear saved scene + Retry
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        className="feed-nav-btn feed-nav-up"
        title="Scroll up"
        aria-label="Previous video"
        onClick={() => scrollBy(-1)}
      >
        <ChevronIcon dir="up" />
      </button>
      <button
        type="button"
        className="feed-nav-btn feed-nav-down"
        title="Scroll down"
        aria-label="Next video"
        onClick={() => scrollBy(1)}
      >
        <ChevronIcon dir="down" />
      </button>

      {hearts.map((h) => (
        <span
          key={h.id}
          className="feed-heart-particle"
          style={
            {
              left: h.x,
              top: h.y,
              width: h.size,
              height: h.size,
              color: h.color,
              animationDuration: `${h.dur}ms`,
              ["--drift-x" as any]: `${h.driftX}px`,
              ["--rise" as any]: `${-h.rise}px`,
              ["--rot" as any]: `${h.rot}deg`,
            } as React.CSSProperties
          }
        >
          <HeartIcon filled />
        </span>
      ))}

      {drops.map((d) => (
        <span
          key={d.id}
          className="feed-drop-particle"
          style={
            {
              left: d.x,
              top: d.y,
              width: d.size,
              height: d.size,
              color: d.color,
              animationDuration: `${d.dur}ms`,
              ["--dx" as any]: `${d.dx}px`,
              ["--dy" as any]: `${d.dy}px`,
              ["--rot" as any]: `${d.rot}deg`,
            } as React.CSSProperties
          }
        >
          <DropIcon />
        </span>
      ))}
    </div>
  );
};

export default Feed;
