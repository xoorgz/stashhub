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
import { FeedCcButton } from "./FeedCcButton";
import "./Feed.scss";

const VIEWED_KEY = "feed.viewedIds";
const VIEWED_LIMIT = 500;
const LIKES_KEY = "feed.likes";
const LIKE_THRESHOLD = 5;
const MUTED_KEY = "feed.muted";
const CAPTIONS_KEY = "feed.captions";
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

function resolutionLabel(height: number): string | null {
  if (!height || !Number.isFinite(height)) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  if (height >= 240) return "240p";
  return `${Math.round(height)}p`;
}

function videoCodecLabel(codec: string | undefined | null): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c === "h264" || c === "avc" || c === "avc1") return "H.264";
  if (c === "hevc" || c === "h265") return "HEVC";
  if (c === "av1") return "AV1";
  if (c === "vp9") return "VP9";
  if (c === "vp8") return "VP8";
  if (c === "mpeg4") return "MPEG-4";
  return codec.toUpperCase();
}

function audioCodecLabel(codec: string | undefined | null): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c === "ac3") return "Dolby";
  if (c === "eac3") return "Dolby+";
  if (c === "truehd") return "TrueHD";
  if (c === "dts" || c.startsWith("dts")) return "DTS";
  return null;
}

const FeedTitleTags: React.FC<{
  file?: { height?: number; video_codec?: string; audio_codec?: string };
}> = ({ file }) => {
  if (!file) return null;
  const res = resolutionLabel(file.height ?? 0);
  const vCodec = videoCodecLabel(file.video_codec);
  const aCodec = audioCodecLabel(file.audio_codec);
  if (!res && !vCodec && !aCodec) return null;
  return (
    <span className="feed-title-tags">
      {res && <span className="feed-title-tag">{res}</span>}
      {vCodec && <span className="feed-title-tag">{vCodec}</span>}
      {aCodec && (
        <span className="feed-title-tag feed-title-tag-dolby">{aCodec}</span>
      )}
    </span>
  );
};

interface FeedItemProps {
  scene: Scene;
  muted: boolean;
  onToggleMute: () => void;
  captionsOn: boolean;
  onToggleCaptions: () => void;
  onSkip: () => void;
  onSpawnHearts: (x: number, y: number, count: number) => void;
  onSpawnDrops: (x: number, y: number, count: number) => void;
}

const FeedItem: React.FC<FeedItemProps> = ({
  scene,
  muted,
  onToggleMute,
  captionsOn,
  onToggleCaptions,
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

  // Captions toggle: imperatively drive track.mode so the user's preference
  // wins over the browser's default-track heuristics. `disabled` removes the
  // cue rendering entirely; `showing` paints them in the video element.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = captionsOn && i === 0 ? "showing" : "disabled";
      }
    };
    apply();
    v.textTracks.addEventListener("addtrack", apply);
    v.textTracks.addEventListener("removetrack", apply);
    return () => {
      v.textTracks.removeEventListener("addtrack", apply);
      v.textTracks.removeEventListener("removetrack", apply);
    };
  }, [captionsOn, scene.captions?.length]);

  // Read cue start-times from the first caption track and render them
  // as small ticks on the progress bar (one per spoken utterance).
  // VTT loads asynchronously; the tracks list fires addtrack and the
  // individual TextTrack fires load + cuechange when cues parse. Read
  // on each of those so we catch the cues regardless of timing.
  const [cueStarts, setCueStarts] = useState<number[]>([]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    let detach: Array<() => void> = [];
    function read() {
      const v2 = videoRef.current;
      if (!v2 || !v2.textTracks?.length) return;
      const track = v2.textTracks[0];
      // Tracks default to "disabled" which doesn't populate cues; flip
      // to "hidden" just so the cues parse, then back to whatever the
      // captionsOn effect wants.
      if (track.mode === "disabled") track.mode = "hidden";
      const cues = track.cues;
      if (!cues || !cues.length) return;
      const starts: number[] = [];
      for (let i = 0; i < cues.length; i++) starts.push(cues[i].startTime);
      setCueStarts(starts);
    }
    function onTrackAdded(ev: Event) {
      const track = (ev as TrackEvent).track as TextTrack | undefined;
      if (!track) return;
      track.addEventListener("cuechange", read);
      track.addEventListener("load", read);
      detach.push(() => track.removeEventListener("cuechange", read));
      detach.push(() => track.removeEventListener("load", read));
      read();
    }
    // Wire existing tracks (if any are present at mount).
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      t.addEventListener("cuechange", read);
      t.addEventListener("load", read);
      detach.push(() => t.removeEventListener("cuechange", read));
      detach.push(() => t.removeEventListener("load", read));
    }
    read();
    v.textTracks.addEventListener("addtrack", onTrackAdded);
    detach.push(() => v.textTracks.removeEventListener("addtrack", onTrackAdded));
    return () => detach.forEach((d) => d());
  }, [scene.id, scene.captions?.length]);

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
    // Track user-initiated seeks. The browser fires `waiting` while it
    // buffers the new position, which used to trip the stuck-load
    // recovery, which then v.load()'d the element and reset currentTime
    // to 0. Result: scrubbing snapped back to the start. While `seeking`
    // is true, we treat the wait as expected and skip the recovery.
    let seeking = false;
    const onSeeking = () => { seeking = true; };
    const onSeeked = () => { seeking = false; };
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
    // Cap how aggressively we retry load() while stuck on a transcoded
    // stream. Each retry calls v.load(), which resets the element back
    // to the poster and triggers a fresh transcode session; doing it
    // every 3 s indefinitely thrashes ffmpeg on long / HEVC sources
    // where startup naturally takes 5-10 s, producing the "poster to
    // black to poster" flicker the user reported in v1.3.6. After
    // MAX_LOAD_ATTEMPTS retries we leave the poster pulsing and wait
    // patiently for `canplay` / `playing` to fire on its own.
    const MAX_LOAD_ATTEMPTS = 3;
    let loadAttempts = 0;
    const onWaiting = () => {
      waitingSince = performance.now();
      showLoader();
      if (stuckTimer != null) window.clearTimeout(stuckTimer);
      if (loadAttempts >= MAX_LOAD_ATTEMPTS) return;
      stuckTimer = window.setTimeout(() => {
        // Skip the recovery while the user is seeking; v.load() would
        // reset currentTime to 0 and snap the scrubber to start.
        if (seeking || v.seeking) return;
        if (v.readyState < 3 && performance.now() - waitingSince >= 2900) {
          if (loadAttempts >= MAX_LOAD_ATTEMPTS) return;
          loadAttempts++;
          try { v.load(); } catch { /* ignore */ }
          tryPlay();
        }
      }, 3000);
    };
    const onPlaying = () => {
      waitingSince = 0;
      loadAttempts = 0;
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
    const onLoadStart = () => {
      if (v.paused && v.readyState < 3) showLoader();
    };
    // Hard guarantee: any time the element transitions out of paused into
    // playing, the loader is off. This covers cases where `waiting` fires
    // alongside `playing` (Chrome occasionally emits waiting on segment
    // boundaries for transcoded streams).
    const onPlay = () => hideLoader();
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("loadeddata", onCanPlay);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("stalled", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("error", onError);
    v.addEventListener("loadstart", onLoadStart);
    v.addEventListener("play", onPlay);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("seeked", onSeeked);
    return () => {
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("loadeddata", onCanPlay);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("stalled", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("error", onError);
      v.removeEventListener("loadstart", onLoadStart);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("seeking", onSeeking);
      v.removeEventListener("seeked", onSeeked);
      if (stuckTimer != null) window.clearTimeout(stuckTimer);
      if (loaderTimer != null) window.clearTimeout(loaderTimer);
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
          >
            {(scene.captions ?? []).map((c, i) => (
              <track
                key={`${c.language_code}-${c.caption_type}-${i}`}
                kind="captions"
                srcLang={c.language_code}
                label={c.language_code}
                src={`${scene.paths.caption}?lang=${c.language_code}&type=${c.caption_type}`}
                default={i === 0}
              />
            ))}
          </video>
          <div className="feed-progress" ref={progressRef}>
            <div className="feed-progress-bar" ref={barRef} />
            {cueStarts.length > 0 && scene.files?.[0]?.duration ? (
              <div className="feed-progress-markers" aria-hidden="true">
                {cueStarts.map((t, i) => (
                  <span
                    key={i}
                    className="feed-progress-marker"
                    style={{
                      left: `${(t / (scene.files![0].duration || 1)) * 100}%`,
                    }}
                  />
                ))}
              </div>
            ) : null}
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
              <div className="feed-title">
                <span className="feed-title-text">{title}</span>
                <FeedTitleTags file={scene.files?.[0]} />
              </div>
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

          <FeedCcButton
            sceneId={scene.id}
            hasCaptions={(scene.captions?.length ?? 0) > 0}
            captionsOn={captionsOn}
            onToggle={onToggleCaptions}
          />

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
  // Captions ON by default; toggle persists per tab like mute does.
  const [captionsOn, setCaptionsOn] = useState<boolean>(
    () => sessionStorage.getItem(CAPTIONS_KEY) !== "0"
  );
  const [hearts, setHearts] = useState<HeartParticle[]>([]);
  const [drops, setDrops] = useState<DropParticle[]>([]);
  const dropIdRef = useRef(0);

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

  // FeedCcButton dispatches "stashhub:scene-captions-appeared" when its
  // background poll (or click defensive check) detects new captions on a
  // scene. Refetch that scene bypassing Apollo's cache so the <track>
  // nodes actually appear; cache-first would just hand back the stale
  // captions=null record the feed loaded with.
  useEffect(() => {
    async function onCaptionsAppeared(e: Event) {
      const id = (e as CustomEvent<{ sceneId: string }>).detail?.sceneId;
      if (!id) return;
      try {
        const r = await client.query<GQL.FindScenesQuery>({
          query: GQL.FindScenesDocument,
          variables: {
            filter: { per_page: 1, page: 1 },
            scene_filter: {},
            scene_ids: [parseInt(id, 10)],
          },
          fetchPolicy: "no-cache",
        });
        const fresh = r.data.findScenes.scenes[0];
        if (!fresh) return;
        setScenes((prev) => prev.map((s) => (s.id === fresh.id ? fresh : s)));
      } catch {
        /* swallow */
      }
    }
    window.addEventListener(
      "stashhub:scene-captions-appeared",
      onCaptionsAppeared as EventListener
    );
    return () =>
      window.removeEventListener(
        "stashhub:scene-captions-appeared",
        onCaptionsAppeared as EventListener
      );
  }, []);

  // Persist mute per tab
  useEffect(() => {
    sessionStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  }, [muted]);
  useEffect(() => {
    sessionStorage.setItem(CAPTIONS_KEY, captionsOn ? "1" : "0");
  }, [captionsOn]);

  // Initial load. Resumes the saved scene if one is present.
  useEffect(() => {
    let cancelled = false;
    setFeedState("loading");
    setDebugInfo("");
    (async () => {
      const viewed = getViewed();
      // Deep link in: pretty form /feed/:id wins; legacy /?scene=ID for
      // backward compat with anything already shared. Both override the
      // persisted CURRENT_KEY for this initial load.
      let urlScene = "";
      try {
        const m = window.location.pathname.match(/^\/feed\/(\d+)/);
        if (m) urlScene = m[1];
        else urlScene = new URLSearchParams(window.location.search).get("scene") || "";
      } catch { /* ignore */ }
      const savedId = urlScene || localStorage.getItem(CURRENT_KEY) || "";

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
    // Update the URL to /feed/:id without a navigation so the user can
    // copy/share the address of the scene they're currently looking at.
    // Only fire when path differs to avoid spamming history.replaceState
    // on every IntersectionObserver tick.
    try {
      const target = `/feed/${sceneId}`;
      if (window.location.pathname !== target) {
        window.history.replaceState(null, "", target + window.location.search);
      }
    } catch { /* ignore */ }
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

    function ensureNeighborSrcs(activeItem: HTMLDivElement) {
      // Prime active + N ahead with preload="auto" so a swipe-down has no
      // buffer pause. N is bumped on desktop because we can spare the
      // bandwidth there; on mobile we stay conservative. v1.3.0's extra
      // fetch()-based Range pre-warm is gone: it raced Stash's live
      // transcoder for the same scene and occasionally left tiles stuck
      // on a black frame when the abort cancelled an in-flight session
      // before the <video> element had taken over.
      const items = Array.from(track!.querySelectorAll<HTMLDivElement>(".feed-item"));
      const idx = items.indexOf(activeItem);
      if (idx === -1) return;
      const isDesktop = typeof window.matchMedia === "function"
        && window.matchMedia("(hover: hover)").matches;
      const aheadAggressive = isDesktop ? 3 : 2;
      const aheadSrcOnly = aheadAggressive + 1;
      const start = Math.max(0, idx - 1);
      const end = Math.min(items.length - 1, idx + aheadSrcOnly);
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
      }
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
  // Custom snap-slide animation for arrow / j-k navigation. Browser
  // behavior:"smooth" runs ~300 ms; this is ~220 ms ease-out-cubic so
  // the page lands on the next tile faster and feels like a TikTok swipe.
  // Cancels any in-flight slide so quick double-presses chain instead of
  // queueing up.
  const slideRafRef = useRef<number | null>(null);
  const fastSlide = useCallback((track: HTMLElement, target: number) => {
    if (slideRafRef.current != null) {
      cancelAnimationFrame(slideRafRef.current);
      slideRafRef.current = null;
    }
    const startTop = track.scrollTop;
    const dist = target - startTop;
    if (dist === 0) return;
    const duration = 220;
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const elapsed = ts - startTs;
      const p = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - p, 3);
      track.scrollTop = startTop + dist * ease;
      if (p < 1) slideRafRef.current = requestAnimationFrame(step);
      else slideRafRef.current = null;
    };
    slideRafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = trackRef.current;
      if (!t) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        fastSlide(t, t.scrollTop + t.clientHeight);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        fastSlide(t, t.scrollTop - t.clientHeight);
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
    fastSlide(t, t.scrollTop + dir * t.clientHeight);
  }, [fastSlide]);

  const handleSkip = useCallback(() => scrollBy(1), [scrollBy]);
  const toggleMute = useCallback(() => setMuted((m) => !m), []);
  const toggleCaptions = useCallback(() => {
    setCaptionsOn((c) => {
      const next = !c;
      try { sessionStorage.setItem(CAPTIONS_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

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
      <div className="feed-track" ref={trackRef}>
        {scenes.map((s) => (
          <FeedItem
            key={s.id}
            scene={s}
            muted={muted}
            onToggleMute={toggleMute}
            captionsOn={captionsOn}
            onToggleCaptions={toggleCaptions}
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
