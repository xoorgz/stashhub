import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
const client = getClient();
import { buildQueue, fetchSceneDetails, FeedScene } from "./algorithm";
import {
  loadFilterChipsFromServer,
  loadAlgorithmSettings,
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
  FastModeIcon,
} from "./icons";
import { FeedCcButton } from "./FeedCcButton";
import { FeedInteractiveButton } from "./FeedInteractiveButton";
import {
  InteractiveContext,
  ConnectionState,
} from "src/hooks/Interactive/context";
import {
  buttplug,
  useButtplug,
  loadInteractiveConfig,
} from "src/hooks/Interactive/buttplug";
import {
  loadFastModeConfig,
  saveFastModeConfig,
  fastModeFromConfigUi,
  FAST_MODE_EVENT,
  FAST_MODE_MAX_HEIGHT,
  FAST_MODE_VIDEO_CODEC,
} from "src/hooks/FastMode/fastMode";
import {
  registerVideoCache,
  precacheVideos,
} from "src/hooks/FastMode/videoCache";
import { ConfigurationContext } from "src/hooks/Config";
import "./Feed.scss";

const VIEWED_KEY = "feed.viewedIds";
const VIEWED_LIMIT = 500;
// How many just-served scenes to hold back when a new cycle starts, so nothing
// repeats right at the boundary.
const RECYCLE_KEEP = 25;
const LIKES_KEY = "feed.likes";
const LIKE_THRESHOLD = 5;
const MUTED_KEY = "feed.muted";
const CAPTIONS_KEY = "feed.captions";
const CURRENT_KEY = "feed.currentSceneId";
const SKIPPED_TAGS_KEY = "feed.skips.tags";
const SCENE_SKIPS_KEY = "feed.skips.scenes";
const SCENE_SKIPS_MAX = 3000;
const QUEUE_TARGET = 30;
const REFILL_AT = 5;

const HEART_COLORS = ["#ff3b6b", "#ff1744", "#ff5070", "#ff7090", "#ff2d55", "#ff6086"];

type Scene = FeedScene;

// A scene id can legitimately repeat in the queue, so tiles key on a per-slot
// serial that survives trimming rather than on the array index.
type QueuedScene = Scene & { __uid: number };
let sceneUid = 0;
const withUid = (s: Scene): QueuedScene => ({ ...s, __uid: ++sceneUid });

// How many watched tiles to keep above the active one before trimming, and the
// minimum excess required to bother. Trimming in batches keeps the scroll
// compensation rare rather than firing on every single swipe.
const KEEP_BEHIND = 12;
const TRIM_CHUNK = 8;

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
/** Begin a fresh pass over the library. Trimming the viewed history to a short
 *  tail lets the next cycle de-duplicate instead of recycling a tiny pool. */
function startNewViewedCycle(keep: string[]) {
  try {
    localStorage.setItem(
      VIEWED_KEY,
      JSON.stringify(keep.slice(-RECYCLE_KEEP))
    );
  } catch {
    /* ignore */
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
    const days = Math.max(1, loadAlgorithmSettings().tagSkipDecayDays);
    const cutoff = Date.now() - days * 86_400_000;
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

/** localStorage map of sceneId -> {c: skips, m: fewest seconds ever watched,
 *  t: last skip}. The algorithm turns this into a decaying demotion, so a
 *  scene that gets bounced fast is shown less, not never. */
type SceneSkipEntry = { c: number; m: number; t: number };
function recordSceneSkip(id: string, watchedSec: number) {
  try {
    const raw = localStorage.getItem(SCENE_SKIPS_KEY);
    const map: Record<string, SceneSkipEntry> = raw ? JSON.parse(raw) : {};
    const prev = map[id];
    const sec = Math.max(0, watchedSec);
    map[id] = {
      c: (prev?.c ?? 0) + 1,
      m: prev ? Math.min(prev.m, sec) : sec,
      t: Date.now(),
    };
    const keys = Object.keys(map);
    if (keys.length > SCENE_SKIPS_MAX) {
      keys
        .sort((a, b) => map[a].t - map[b].t)
        .slice(0, keys.length - SCENE_SKIPS_MAX)
        .forEach((k) => delete map[k]);
    }
    localStorage.setItem(SCENE_SKIPS_KEY, JSON.stringify(map));
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
  fastModeEnabled: boolean;
  muted: boolean;
  onToggleMute: () => void;
  captionsOn: boolean;
  onToggleCaptions: () => void;
  interactiveOn: boolean;
  interactiveState: ConnectionState;
  interactiveInitialised: boolean;
  onToggleInteractive: () => void;
  onSkip: () => void;
  onSpawnHearts: (x: number, y: number, count: number) => void;
  onSpawnDrops: (x: number, y: number, count: number) => void;
}

const FeedItem: React.FC<FeedItemProps> = ({
  scene,
  fastModeEnabled,
  muted,
  onToggleMute,
  captionsOn,
  onToggleCaptions,
  interactiveOn,
  interactiveState,
  interactiveInitialised,
  onToggleInteractive,
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
  // True once playback has actually started; drives the poster→video crossfade.
  const [revealed, setRevealed] = useState(false);

  // Handy interactive sync
  const {
    interactive: interactiveClient,
    uploadScript,
  } = React.useContext(InteractiveContext);
  const interactiveSceneRef = useRef<string | null>(null);
  // Visual funscript indicator: position (0-100) interpolated from current video time.
  const [funscriptPos, setFunscriptPos] = useState<number>(50);
  const funscriptActionsRef = useRef<Array<{ at: number; pos: number }> | null>(null);
  const [funscriptReady, setFunscriptReady] = useState(false);
  // Intiface/buttplug device status (Kiiroo, Lovense, Handy-over-BT).
  const { status: buttplugStatus, deviceName: buttplugDeviceName } =
    useButtplug();

  // Mirror Feed's `feed-pulse-trigger` into pulse state, so a keyboard seek
  // shows the same centred chip as an edge-tap.
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

  // Fast mode streams a pre-generated small/fast-start copy. A per-scene HQ
  // override beats the global setting until the user swipes away.
  const [hqOverride, setHqOverride] = useState(false);
  const useFast = fastModeEnabled && !hqOverride;
  const fullSrc = useMemo(
    () => relativize(scene.paths.stream || scene.paths.preview),
    [scene.paths.stream, scene.paths.preview]
  );
  const fastSrc = useMemo(() => {
    // GetStreamURL always ends the path in exactly "/stream" before the query
    // string (apikey), so this swap is safe and never touches stream.mp4 /
    // .webm / .m3u8 etc, which are unrelated endpoints.
    if (!fullSrc || !scene.paths.stream) return fullSrc;
    return fullSrc.replace(/\/stream(?=$|[?#])/, "/stream.fast");
  }, [fullSrc, scene.paths.stream]);
  const previewSrc = useFast ? fastSrc : fullSrc;
  // First frame rather than the normal cover, which is taken 20% in and makes
  // the picture jump when playback starts. The route falls back to the cover
  // for any scene without a still yet.
  const posterSrc = useMemo(() => {
    const shot = relativize(scene.paths.screenshot);
    if (!shot) return shot;
    return shot.replace(/\/screenshot(?=$|[?#])/, "/poster.fast");
  }, [scene.paths.screenshot]);

  // Swap the live <video> source when the effective mode changes (global
  // setting flips, or the user hits the per-scene HQ toggle), preserving
  // playback position and play state instead of restarting the scene.
  const prevUseFastRef = useRef(useFast);
  useEffect(() => {
    if (prevUseFastRef.current === useFast) return;
    prevUseFastRef.current = useFast;
    const v = videoRef.current;
    if (!v || !v.src) return; // nothing loaded yet, the normal src assignment will pick this up
    const nextSrc = useFast ? fastSrc : fullSrc;
    if (!nextSrc) return;
    const wasPlaying = !v.paused;
    const resumeAt = v.currentTime;
    const onLoaded = () => {
      v.currentTime = resumeAt;
      if (wasPlaying) v.play().catch(() => {});
      v.removeEventListener("loadedmetadata", onLoaded);
    };
    v.addEventListener("loadedmetadata", onLoaded);
    v.src = nextSrc;
    v.dataset.src = nextSrc;
    v.load();
  }, [useFast, fastSrc, fullSrc]);

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

  // Seek on the progress bar. Touch waits for the gesture to declare itself, so
  // a vertical swipe that starts on the bar still scrolls the feed.
  useEffect(() => {
    const p = progressRef.current;
    const v = videoRef.current;
    if (!p || !v) return;
    const SLOP = 6;
    let scrubbing = false;

    function seekToX(clientX: number) {
      const rect = p!.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (v!.duration && isFinite(v!.duration)) {
        v!.currentTime = ratio * v!.duration;
        if (barRef.current) barRef.current.style.width = `${ratio * 100}%`;
      }
    }

    // Mouse: no scroll ambiguity, scrub straight away.
    function mouseMove(ev: MouseEvent) {
      if (!scrubbing) return;
      seekToX(ev.clientX);
    }
    function mouseUp() {
      scrubbing = false;
      p!.classList.remove("scrubbing");
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseUp);
    }
    function mouseDown(ev: MouseEvent) {
      ev.stopPropagation();
      scrubbing = true;
      p!.classList.add("scrubbing");
      seekToX(ev.clientX);
      window.addEventListener("mousemove", mouseMove);
      window.addEventListener("mouseup", mouseUp);
    }

    // Touch: wait for the gesture to declare itself before claiming it.
    let startX = 0;
    let startY = 0;
    let intent: "none" | "scrub" | "scroll" = "none";

    function detachTouch() {
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
    }
    function touchMove(ev: TouchEvent) {
      const t = ev.touches[0];
      if (!t) return;
      if (intent === "none") {
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (dx < SLOP && dy < SLOP) return;
        if (dy > dx) {
          // Vertical: a feed swipe that merely began on the bar. Let go of it
          // entirely and never preventDefault, so the native scroll continues.
          intent = "scroll";
          detachTouch();
          return;
        }
        intent = "scrub";
        scrubbing = true;
        p!.classList.add("scrubbing");
      }
      if (intent === "scrub") {
        if (ev.cancelable) ev.preventDefault();
        seekToX(t.clientX);
      }
    }
    function touchEnd(ev: TouchEvent) {
      if (intent === "none") {
        const t = ev.changedTouches[0];
        if (t) seekToX(t.clientX); // tap to seek
      }
      scrubbing = false;
      p!.classList.remove("scrubbing");
      detachTouch();
    }
    function touchStart(ev: TouchEvent) {
      const t = ev.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      intent = "none";
      window.addEventListener("touchmove", touchMove, { passive: false });
      window.addEventListener("touchend", touchEnd);
      window.addEventListener("touchcancel", touchEnd);
    }

    p.addEventListener("mousedown", mouseDown);
    p.addEventListener("touchstart", touchStart, { passive: true });
    return () => {
      p.removeEventListener("mousedown", mouseDown);
      p.removeEventListener("touchstart", touchStart);
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseUp);
      detachTouch();
    };
  }, []);

  // Double-click to fullscreen. Gated on `hover: hover` so a double-tap on a
  // touch-only device stays edge-tap seek.
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

  // Cues render in a React overlay so iOS accessibility caption prefs cannot
  // restyle them. Track 0 stays "hidden" so cues parse without being painted.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = i === 0 ? "hidden" : "disabled";
      }
    };
    apply();
    v.textTracks.addEventListener("addtrack", apply);
    v.textTracks.addEventListener("removetrack", apply);
    return () => {
      v.textTracks.removeEventListener("addtrack", apply);
      v.textTracks.removeEventListener("removetrack", apply);
    };
  }, [scene.captions?.length]);

  // Active cue text for the overlay. Hidden tracks still fire cuechange, so
  // tracking continuously lets a captions toggle paint the current cue at once.
  const [activeCue, setActiveCue] = useState<string>("");
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    let detach: Array<() => void> = [];
    const read = () => {
      const v2 = videoRef.current;
      if (!v2 || !v2.textTracks?.length) {
        setActiveCue("");
        return;
      }
      const track = v2.textTracks[0];
      const active = track.activeCues;
      if (!active || !active.length) {
        setActiveCue("");
        return;
      }
      const parts: string[] = [];
      for (let i = 0; i < active.length; i++) {
        const c = active[i] as VTTCue;
        if (c.text) parts.push(c.text);
      }
      setActiveCue(parts.join("\n"));
    };
    const wireTrack = (t: TextTrack) => {
      t.addEventListener("cuechange", read);
      detach.push(() => t.removeEventListener("cuechange", read));
    };
    for (let i = 0; i < v.textTracks.length; i++) wireTrack(v.textTracks[i]);
    const onAdd = (ev: Event) => {
      const t = (ev as TrackEvent).track as TextTrack | undefined;
      if (t) wireTrack(t);
      read();
    };
    v.textTracks.addEventListener("addtrack", onAdd);
    detach.push(() => v.textTracks.removeEventListener("addtrack", onAdd));
    read();
    return () => {
      detach.forEach((d) => d());
      setActiveCue("");
    };
  }, [scene.id, scene.captions?.length]);

  // Cue start-times drive the progress-bar ticks. VTT parses asynchronously, so
  // read on addtrack, load and cuechange alike to catch them whenever they land.
  const [cueStarts, setCueStarts] = useState<number[]>([]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    let detach: Array<() => void> = [];
    function read() {
      const v2 = videoRef.current;
      if (!v2 || !v2.textTracks?.length) return;
      const track = v2.textTracks[0];
      // We don't touch track.mode here. The captions effect above owns it and
      // keeps track 0 in "hidden" mode always, so cues are parsed regardless of
      // whether captions are shown, and these progress markers work either way.
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

  // The IO handler's play() rejects when src was only just assigned, leaving the
  // tile on its poster, so retry on every canplay and show a buffering loader.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let loaderTimer: number | null = null;
    const showLoader = () => {
      if (loaderTimer != null) return;
      // Defer 250ms so a quick load never flashes a loader frame, then commit
      // only if the video is paused or below HAVE_FUTURE_DATA (3).
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
      const item = itemRef.current;
      if (!item) return;
      // Only the tile marked active may decode. Covering most of the viewport is
      // the fallback when a fast fling skipped the settle that sets the marker.
      if (item.dataset.active !== "1") {
        const r = item.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if (visible < vh * 0.7) return;
      }
      v.play().catch(() => {});
    };
    const onCanPlay = () => {
      hideLoader();
      tryPlay();
    };
    // `waiting` means the browser is buffering, which is normal and recovers on
    // its own. It must never trigger v.load(): that discards every byte already
    // downloaded and restarts from zero, so a clip needing longer than the timer
    // can never finish, each retry throwing away the last one's progress. It
    // showed up as one scene refetched every 3 s forever, four of six requests
    // cancelled at zero bytes, the phone burning battery on nothing.
    const onWaiting = () => {
      showLoader();
    };
    const onPlaying = () => {
      errorRecoveries = 0;
      setRevealed(true);
      hideLoader();
    };
    // The poster is hidden once revealed, so a tile whose source was released
    // has to put it back. Otherwise scrolling away and returning shows black
    // until the video reloads.
    const onEmptied = () => setRevealed(false);
    // A real MediaError is different: nothing is in flight to protect, so a
    // reload is the only way back. Strictly capped, since a genuinely broken
    // file would otherwise spin forever.
    const MAX_ERROR_RECOVERIES = 2;
    let errorRecoveries = 0;
    const onError = () => {
      if (errorRecoveries >= MAX_ERROR_RECOVERIES) {
        hideLoader();
        return;
      }
      errorRecoveries++;
      showLoader();
      window.setTimeout(() => {
        if (v.seeking) return;
        try { v.load(); } catch { /* ignore */ }
        tryPlay();
      }, 400 * errorRecoveries);
    };
    const onLoadStart = () => {
      if (v.paused && v.readyState < 3) showLoader();
    };
    // Chrome can emit `waiting` alongside `playing` on transcoded segment
    // boundaries, so clear the loader on play as well.
    const onPlay = () => hideLoader();
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("loadeddata", onCanPlay);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("stalled", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("error", onError);
    v.addEventListener("loadstart", onLoadStart);
    v.addEventListener("play", onPlay);
    v.addEventListener("emptied", onEmptied);
    return () => {
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("loadeddata", onCanPlay);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("stalled", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("error", onError);
      v.removeEventListener("loadstart", onLoadStart);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("emptied", onEmptied);
      if (loaderTimer != null) window.clearTimeout(loaderTimer);
    };
  }, [scene.id]);

  // Handy interactive playback sync: push currentTime on timeupdate, pause on
  // scroll-away / unmount. Mirrors what ScenePlayer does in its timeupdate +
  // pause handlers.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !interactiveOn) return;
    if (interactiveState !== ConnectionState.Ready) return;
    if (interactiveSceneRef.current !== scene.id) return;
    const onTime = () => {
      if (v.currentTime != null && isFinite(v.currentTime)) {
        interactiveClient.play(v.currentTime);
      }
    };
    const onPause = () => interactiveClient.pause();
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      interactiveClient.pause();
    };
  }, [interactiveOn, interactiveState, scene.id, interactiveClient]);

  // Fetch funscript JSON when interactive is toggled on for a scene that has one.
  // Stores the raw action timeline for position interpolation.
  useEffect(() => {
    if (!interactiveOn || !scene.paths.funscript) {
      funscriptActionsRef.current = null;
      setFunscriptReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(scene.paths.funscript!);
        const json = await r.json();
        if (!cancelled && json.actions?.length) {
          funscriptActionsRef.current = json.actions;
          setFunscriptReady(true);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [interactiveOn, scene.paths.funscript]);

  // Interpolate funscript position from current video time on each timeupdate.
  // Binary-searches the action timeline for a smooth 0-100 value to drive the
  // visual indicator bar.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !interactiveOn) return;
    const onTime = () => {
      const actions = funscriptActionsRef.current;
      if (!actions || !actions.length) return;
      const ms = v.currentTime * 1000;
      // binary search for the interval containing `ms`
      let lo = 0, hi = actions.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (actions[mid].at <= ms) lo = mid; else hi = mid;
      }
      const a = actions[lo], b = actions[hi];
      if (ms <= a.at) { setFunscriptPos(a.pos); return; }
      if (ms >= b.at) { setFunscriptPos(b.pos); return; }
      const t = (ms - a.at) / (b.at - a.at);
      setFunscriptPos(a.pos + (b.pos - a.pos) * t);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [interactiveOn]);

  // Drive an Intiface/buttplug device (Kiiroo, Lovense, Handy-over-BT) from the
  // same funscript, in parallel to the Handy cloud path. The manager owns its
  // own rAF loop; we just bind the playing video and release on pause/unmount.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !interactiveOn || buttplugStatus !== "ready") return;
    if (!funscriptReady) return;
    const onPlay = () => {
      if (funscriptActionsRef.current)
        buttplug.bind(v, funscriptActionsRef.current);
    };
    const onPause = () => buttplug.unbind(v);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    if (!v.paused) onPlay();
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      buttplug.unbind(v);
    };
  }, [interactiveOn, buttplugStatus, funscriptReady, scene.id]);

  // Register a play after 3s and flush watched seconds every 10s. The Top
  // Watched and Watched Tags buckets have no other source for this.
  const playTimerRef = useRef<number | null>(null);
  const playRegisteredRef = useRef(false);
  const watchedSinceLastFlushRef = useRef(0);
  // Cumulative seconds the user spent viewing THIS scene this mount. Not
  // reset by flush(), used by skip-learning on unmount to decide whether
  // the user genuinely watched (>= SKIP_THRESHOLD_SEC) or just skipped past.
  const sceneViewedTotalRef = useRef(0);
  // Tiles for scenes further down the queue also mount. Without this, leaving
  // the feed would record a skip for every scene the user never reached.
  const everPlayedRef = useRef(false);
  // Scrubbing, edge-tapping or arrow-keying through a video is engagement, not
  // rejection. The user is hunting for the good part, so it must never be
  // learned as a skip however little of it ends up playing.
  const seekedRef = useRef(false);
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
      everPlayedRef.current = true;
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
    const onSeeking = () => {
      seekedRef.current = true;
    };
    v.addEventListener("play", startTracking);
    v.addEventListener("pause", stopTracking);
    v.addEventListener("ended", stopTracking);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("timeupdate", onTimeUpdateForActivity);
    document.addEventListener("visibilitychange", onPageHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      v.removeEventListener("play", startTracking);
      v.removeEventListener("pause", stopTracking);
      v.removeEventListener("ended", stopTracking);
      v.removeEventListener("seeking", onSeeking);
      v.removeEventListener("timeupdate", onTimeUpdateForActivity);
      document.removeEventListener("visibilitychange", onPageHidden);
      window.removeEventListener("pagehide", flush);
      stopTracking();
      // Skip-learning, only for tiles the user actually reached and never
      // reached into.
      if (!everPlayedRef.current || seekedRef.current) return;
      const viewed = sceneViewedTotalRef.current;
      const threshold = Math.max(1, loadAlgorithmSettings().skipThresholdSec);
      if (viewed >= threshold) return;
      if (scene.tags && scene.tags.length > 0) {
        recordTagSkips(scene.tags.map((t) => t.id));
      }
      recordSceneSkip(scene.id, viewed);
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
    scene.title ||
    scene.files?.[0]?.path?.split("/").pop() ||
    `Scene ${scene.id}`;

  return (
    <div className="feed-item" ref={itemRef} data-scene-id={scene.id}>
      <div className="feed-stage">
        <div
          className={`feed-video-wrap${loading ? " is-loading" : ""}${revealed ? " is-revealed" : ""}`}
          ref={wrapRef}
        >
          {/* Poster backdrop: sits behind the video so an idle / not-yet-playing
              tile shows the scene's still instead of a black tile. The video
              crossfades in over it on play, and a spinner shows while buffering. */}
          <div
            className="feed-video-poster"
            style={posterSrc ? { backgroundImage: `url("${posterSrc}")` } : undefined}
            aria-hidden="true"
          />
          <div className="feed-loader" aria-hidden="true" />
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
          {captionsOn && activeCue ? (
            <div className="feed-caption" aria-live="polite">
              {activeCue
                .replace(/<[^>]+>/g, "")
                .split("\n")
                .filter(Boolean)
                .map((line, i) => (
                  <span key={i} className="feed-caption-line">
                    {line}
                  </span>
                ))}
            </div>
          ) : null}
          {/* Funscript visual indicator: a subtle vertical track on the right
              edge of the video with a glowing dot that moves up/down in sync
              with the funscript timeline, so the user can see the thrust
              motion even without a Handy connected. */}
          {interactiveOn && funscriptActionsRef.current ? (
            <div className="feed-funscript-bar" aria-hidden="true">
              <span className="feed-funscript-label feed-funscript-label-top">100</span>
              <div className="feed-funscript-track" />
              <div
                className="feed-funscript-dot"
                // Inset travel by 6% each end so the dot stops short of 0/100.
                style={{ top: `${6 + (100 - funscriptPos) * 0.88}%` }}
              />
              <span className="feed-funscript-label feed-funscript-label-bot">0</span>
            </div>
          ) : null}
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
                <FeedTitleTags
                  file={
                    useFast
                      ? {
                          // Badge what fast mode encodes, not the source file:
                          // h264, plain stereo AAC, capped at 720p.
                          height: Math.min(
                            FAST_MODE_MAX_HEIGHT,
                            scene.files?.[0]?.height || FAST_MODE_MAX_HEIGHT
                          ),
                          video_codec: FAST_MODE_VIDEO_CODEC,
                          audio_codec: undefined,
                        }
                      : scene.files?.[0]
                  }
                />
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

          {fastModeEnabled && (
            <button
              type="button"
              className={`feed-action feed-fastmode-toggle${useFast ? "" : " is-hq"}`}
              title={
                useFast
                  ? "Playing fast mode. Tap for full quality."
                  : "Full quality for this video. Tap to go back to fast mode."
              }
              onClick={(e) => {
                e.preventDefault();
                setHqOverride((v) => !v);
              }}
            >
              <FastModeIcon filled={useFast} />
            </button>
          )}

          <FeedCcButton
            sceneId={scene.id}
            sceneTitle={title}
            hasCaptions={(scene.captions?.length ?? 0) > 0}
            captionsOn={captionsOn}
            onToggle={onToggleCaptions}
          />

          <FeedInteractiveButton
            sceneId={scene.id}
            hasFunscript={scene.interactive}
            interactiveOn={interactiveOn}
            connectionState={interactiveState}
            buttplugStatus={buttplugStatus}
            deviceName={buttplugDeviceName}
            onToggle={onToggleInteractive}
          />

          <button
            type="button"
            className="feed-action feed-fs-btn"
            title="Fullscreen (double-click video for video-only fullscreen)"
            onClick={(e) => {
              e.preventDefault();
              // iOS Safari rejects requestFullscreen on non-video elements, so
              // fall back to the video's webkitEnterFullscreen.
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

  const [scenes, setScenes] = useState<QueuedScene[]>([]);
  // Pixels removed from above the viewport by a trim, applied to scrollTop
  // before the browser paints so the view never jumps.
  const pendingTrimRef = useRef(0);
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
  const INTERACTIVE_KEY = "feed.interactive";
  const [interactiveOn, setInteractiveOn] = useState<boolean>(
    () => sessionStorage.getItem(INTERACTIVE_KEY) !== "0"
  );
  // ConfigurationContext is the source of truth for the global fast-mode
  // setting; localStorage only supplies first paint and the same-tab channel.
  const { configuration } = React.useContext(ConfigurationContext);
  const [fastModeEnabled, setFastModeEnabled] = useState<boolean>(
    () => loadFastModeConfig().enabled
  );
  useEffect(() => {
    function onChange() {
      setFastModeEnabled(loadFastModeConfig().enabled);
    }
    window.addEventListener(FAST_MODE_EVENT, onChange);
    return () => window.removeEventListener(FAST_MODE_EVENT, onChange);
  }, []);
  useEffect(() => {
    const server = fastModeFromConfigUi(configuration?.ui);
    if (!server) return;
    setFastModeEnabled(server.enabled);
    saveFastModeConfig(server); // mirror so a later mount starts correct offline too
  }, [configuration]);

  // Only worth installing when fast mode is on: it caches the fast copies.
  useEffect(() => {
    if (!fastModeEnabled) return;
    registerVideoCache();
  }, [fastModeEnabled]);

  // Read through a ref inside the observer effect, which deliberately does not
  // depend on this: toggling fast mode should not tear down and rebuild the
  // whole scroll observer.
  const fastModeRef = useRef(fastModeEnabled);
  useEffect(() => {
    fastModeRef.current = fastModeEnabled;
  }, [fastModeEnabled]);
  const {
    state: interactiveState,
    initialised: interactiveInitialised,
  } = React.useContext(InteractiveContext);

  // Auto-connect to Intiface when the interactive toggle is on and the Intiface
  // transport is enabled. One attempt per toggle/config change; the settings
  // panel offers an explicit reconnect if Intiface Central starts up later.
  useEffect(() => {
    function maybeConnect() {
      if (sessionStorage.getItem("feed.interactive") === "0") return;
      const cfg = loadInteractiveConfig();
      if (!cfg.intifaceEnabled) return;
      if (buttplug.status === "disconnected" || buttplug.status === "error") {
        buttplug.connect(cfg.intifaceUrl);
      }
    }
    maybeConnect();
    window.addEventListener("stashhub:interactive-config-changed", maybeConnect);
    return () =>
      window.removeEventListener(
        "stashhub:interactive-config-changed",
        maybeConnect
      );
  }, [interactiveOn]);

  const [hearts, setHearts] = useState<HeartParticle[]>([]);
  const [drops, setDrops] = useState<DropParticle[]>([]);
  const dropIdRef = useRef(0);

  // Mirror the server's chip defs into the algorithm.settings blob buildQueue
  // reads, and rebuild the queue whenever the active chip changes.
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

  // Refetch past Apollo's cache when FeedCcButton reports new captions, since
  // cache-first would hand back the stale captions=null record.
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
        setScenes((prev) =>
          prev.map((s) => (s.id === fresh.id ? { ...fresh, __uid: s.__uid } : s))
        );
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
      // backward compat with anything already shared.
      let urlScene = "";
      try {
        const m = window.location.pathname.match(/^\/feed\/(\d+)/);
        if (m) urlScene = m[1];
        else urlScene = new URLSearchParams(window.location.search).get("scene") || "";
      } catch { /* ignore */ }
      // Deep link only. The feed deliberately does NOT remember where you were:
      // resuming on the last scene made every open replay the same tail, which
      // is half of why the feed felt like it looped. A fresh queue every time.
      const savedId = urlScene;

      // Build the queue with the saved id excluded; it is prepended below.
      const exclude = new Set(viewed);
      if (savedId) exclude.add(savedId);
      let debug = `viewed:${viewed.size} savedId:${savedId || "(none)"}`;
      let ids = await buildQueue({ targetCount: QUEUE_TARGET, exclude });
      if (cancelled) return;
      // Nothing fresh left (everything viewed / recently-played)? Recycle so
      // the feed still opens with a reshuffled library instead of empty.
      if (ids.length === 0) {
        // Same reasoning as the refill path: start a clean cycle so the feed
        // de-duplicates properly again instead of recycling every single time.
        startNewViewedCycle(Array.from(viewed));
        ids = await buildQueue({
          targetCount: QUEUE_TARGET,
          exclude: savedId ? new Set([savedId]) : new Set(),
          recycle: true,
        });
        if (cancelled) return;
      }
      debug += ` | buildQueue→${ids.length} ids`;

      const finalIds = savedId ? [savedId, ...ids] : ids;
      const details = await fetchSceneDetails(finalIds);
      if (cancelled) return;
      debug += ` | fetchSceneDetails(${finalIds.length})→${details.length}`;
      setDebugInfo(debug);

      details.forEach((s) => loadedIds.add(s.id));
      setScenes(details.map(withUid));
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

  // Set true while we scroll in response to a back/forward navigation, so the
  // resulting settle replaces the history entry instead of pushing a new one.
  const navPopRef = useRef(false);

  // Persist the active scene id
  const persistCurrent = useCallback((sceneId: string | undefined) => {
    if (!sceneId) return;
    // Reflect the current scene in the URL as /feed/:id. pushState gives a real
    // history entry (back/forward step through videos) and updates the address
    // bar reliably, iOS Safari included. Only fire on an actual scene change.
    try {
      const target = `/feed/${sceneId}`;
      if (window.location.pathname !== target) {
        const url = target + window.location.search;
        if (navPopRef.current) {
          window.history.replaceState(null, "", url);
        } else {
          window.history.pushState(null, "", url);
        }
      }
    } catch { /* ignore */ }
    navPopRef.current = false;
  }, []);

  // Back/forward: scroll the feed to the scene named in the URL.
  useEffect(() => {
    function onPop() {
      const m = window.location.pathname.match(/^\/feed\/(\d+)/);
      if (!m) return;
      const track = trackRef.current;
      if (!track) return;
      const el = track.querySelector<HTMLElement>(
        `.feed-item[data-scene-id="${m[1]}"]`
      );
      if (el) {
        navPopRef.current = true;
        track.scrollTo({ top: el.offsetTop, behavior: "auto" });
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    try {
      const viewed = getViewed();
      const exclude = new Set([...viewed, ...loadedIds]);
      let ids = await buildQueue({ targetCount: 20, exclude });
      let details = await fetchSceneDetails(ids);
      // Endless feed: when the dedup build returns nothing, reshuffle the whole
      // library and hold back only the last few tiles.
      if (details.length === 0) {
        const recentList = Array.from(loadedIds).slice(-RECYCLE_KEEP);
        const recent = new Set(recentList);
        loadedIds.clear();
        recent.forEach((id) => loadedIds.add(id));
        // Reset the viewed history as well. Without this the very next refill
        // lands here again, because `viewed` still covers the whole library,
        // and the feed just keeps re-drawing the same small recycled pool.
        startNewViewedCycle(recentList);
        ids = await buildQueue({ targetCount: 20, exclude: recent, recycle: true });
        details = await fetchSceneDetails(ids);
      }
      details.forEach((s) => loadedIds.add(s.id));
      setScenes((prev) => [...prev, ...details.map(withUid)]);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [loadedIds]);

  // Rewind the scroller by exactly the height trimming removed, in a layout
  // effect so it lands before paint and the content never yanks upward.
  useLayoutEffect(() => {
    const px = pendingTrimRef.current;
    if (!px) return;
    pendingTrimRef.current = 0;
    const track = trackRef.current;
    if (track) track.scrollTop = Math.max(0, track.scrollTop - px);
  }, [scenes]);

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
      // Prime active + N ahead with preload="auto" so a swipe-down has no buffer
      // pause. N is larger on desktop, where the bandwidth is there to spare.
      const items = Array.from(track!.querySelectorAll<HTMLDivElement>(".feed-item"));
      const idx = items.indexOf(activeItem);
      if (idx === -1) return;
      const isDesktop = typeof window.matchMedia === "function"
        && window.matchMedia("(hover: hover)").matches;
      // Two budgets: preload="auto" is a full download so keep it tiny, and a
      // bare src is a few KB but still holds a media pipeline per element on iOS.
      // Only the tile being watched may download without limit. preload="auto"
      // is unbounded: the browser pulls the whole file, and a scene with no
      // fast copy yet falls back to its original, which can be hundreds of
      // megabytes. Two neighbours doing that put 177 MB in flight at once and
      // starved the video actually playing, stalling it for twenty seconds on
      // a 360 Mbit line. Neighbours get metadata only, a few KB of header;
      // they still start instantly because the moov atom sits at the front,
      // and the next scene is pulled down properly by the video cache.
      const autoAhead = 0;
      const autoBehind = 0;
      // Keep the number of elements holding a src small. preload="metadata" is
      // only a hint and browsers routinely fetch megabytes for it, so a wide
      // window means many downloads at once: seven tiles produced five
      // concurrent transfers each taking 15 to 26 seconds, and the video being
      // watched was just one more of them. One either side is enough, because
      // the moov atom is at the front of every copy so a cold tile still opens
      // on its first packet.
      const srcAhead = 1;
      const srcBehind = 1;
      const start = Math.max(0, idx - srcBehind);
      const end = Math.min(items.length - 1, idx + srcAhead);
      for (let i = start; i <= end; i++) {
        const it = items[i];
        const v = it.querySelector<HTMLVideoElement>("video.feed-video");
        if (!v) continue;
        const aggressive = i >= idx - autoBehind && i <= idx + autoAhead;
        const desiredPreload = aggressive ? "auto" : "metadata";
        if (v.preload !== desiredPreload) v.preload = desiredPreload;
        const src = v.dataset.src;
        if (src && !v.src) {
          v.src = src;
          try { v.load(); } catch { /* ignore */ }
        }
      }
      // Backstop sweep: a fast fling can coalesce the observer callbacks.
      //
      // Between the prime window and full teardown sits a retain zone: src is
      // left in place with preload="none", so the element fetches nothing more
      // but keeps what it already buffered. Dropping src calls load(), which
      // throws that buffer away and aborts any request in flight, and stepping
      // back onto the tile then re-downloads from zero. That is what made
      // moving back and forth stall, visible in the log as requests cancelled
      // at zero bytes. Only past the retain zone is src actually released,
      // since every element holding one costs a media pipeline on iOS.
      const keepBehind = srcBehind + 1;
      const keepAhead = srcAhead + 1;
      const retainBehind = isDesktop ? 6 : 4;
      const retainAhead = isDesktop ? 6 : 4;
      for (let i = 0; i < items.length; i++) {
        if (i === idx) continue;
        const v = items[i].querySelector<HTMLVideoElement>("video.feed-video");
        if (!v) continue;
        if (!v.paused) v.pause();
        const outsidePrime = i < idx - keepBehind || i > idx + keepAhead;
        const outsideRetain = i < idx - retainBehind || i > idx + retainAhead;
        if (outsideRetain) {
          if (v.src) {
            v.removeAttribute("src");
            v.preload = "none";
            try { v.load(); } catch { /* ignore */ }
          }
        } else if (outsidePrime && v.src && v.preload !== "none") {
          // Stop pulling more without discarding what is already there.
          v.preload = "none";
        }
      }
    }

    // Ask the worker to hold the scene being watched plus the next one, and to
    // abandon anything else. Whole files, so a seek inside them costs nothing.
    // Driven from the settle path on purpose: flying past a hundred tiles must
    // not queue a hundred downloads, and the list doubles as the cancel signal
    // for whatever was wanted a moment ago.
    function cacheAhead(activeItem: HTMLDivElement) {
      if (!fastModeRef.current) return;
      const items = Array.from(track!.querySelectorAll<HTMLDivElement>(".feed-item"));
      const idx = items.indexOf(activeItem);
      if (idx === -1) return;
      // Next scene only. The one playing is already being fetched by its video
      // element, and precaching it too downloaded the same file twice over the
      // same connection, competing with the playback it was meant to help.
      const urls: string[] = [];
      for (let i = idx + 1; i <= Math.min(items.length - 1, idx + 1); i++) {
        const v = items[i].querySelector<HTMLVideoElement>("video.feed-video");
        const src = v?.dataset.src;
        if (src && /\/stream\.fast(?:$|[?#])/.test(src)) {
          urls.push(new URL(src, window.location.href).toString());
        }
      }
      if (urls.length) precacheVideos(urls);
    }

    // Only a tile settled on for >~120ms plays and primes its transcode, so
    // fast-skipping loads nothing and skipped tiles just show their posters.
    let settleTimer: number | null = null;
    let pendingItem: HTMLDivElement | null = null;
    let primeRaf: number | null = null;
    const activate = (item: HTMLDivElement) => {
      const video = item.querySelector<HTMLVideoElement>("video.feed-video");
      if (!video) return;
      // Single source of truth for "which tile may decode". FeedItem's canplay
      // recovery refuses to play unless its own tile carries this flag, so no
      // matter how fast the user flings, only one video is ever decoding.
      track.querySelectorAll<HTMLDivElement>(".feed-item[data-active]").forEach((el) => {
        if (el !== item) delete el.dataset.active;
      });
      item.dataset.active = "1";
      // Start the active video before priming neighbours. preload goes first: a
      // torn-down tile carries preload="none", which makes load() fetch nothing.
      video.preload = "auto";
      if (video.dataset.src && !video.src) {
        video.src = video.dataset.src;
        try { video.load(); } catch { /* ignore */ }
      }
      video.muted = muted;
      video.play().catch(() => {});
      // Prefetch neighbours only once this tile plays and is still the settled
      // one, so the burst never competes with a cold video or a skipped-past tile.
      const primeNeighbours = () => {
        if (currentVisibleRef.current !== item) return;
        ensureNeighborSrcs(item);
        cacheAhead(item);
      };
      if (!video.paused && video.readyState >= 3) primeNeighbours();
      else video.addEventListener("playing", primeNeighbours, { once: true });
      const id = item.dataset.sceneId;
      if (id) {
        markViewed(id);
        persistCurrent(id);
      }
      showMetaAndScheduleFade(item);
      const items = track.querySelectorAll(".feed-item");
      const idx = Array.from(items).indexOf(item);
      if (items.length - idx <= REFILL_AT) loadMore();
      // Drop tiles far above the active one, each holds a <video> and a poster.
      // Only runs on a settled tile, never mid-fling.
      const excess = idx - KEEP_BEHIND;
      if (excess >= TRIM_CHUNK) {
        const itemH = item.offsetHeight;
        if (itemH > 0) {
          pendingTrimRef.current += excess * itemH;
          setScenes((prev) => prev.slice(excess));
        }
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const item = entry.target as HTMLDivElement;
          const video = item.querySelector<HTMLVideoElement>("video.feed-video");
          if (!video) return;
          if (entry.intersectionRatio >= 0.7) {
            pendingItem = item;
            currentVisibleRef.current = item; // immediate for keyboard/persist reads
            // Prime upcoming tiles at once, throttled to one rAF, so a swipe
            // that never settles still lands on a buffered video.
            if (primeRaf == null) {
              primeRaf = window.requestAnimationFrame(() => {
                primeRaf = null;
                const cur = currentVisibleRef.current as HTMLDivElement | null;
                if (cur) ensureNeighborSrcs(cur);
              });
            }
            if (settleTimer != null) window.clearTimeout(settleTimer);
            settleTimer = window.setTimeout(() => {
              settleTimer = null;
              if (pendingItem === item) activate(item);
            }, 120);
          } else if (entry.intersectionRatio < 0.3) {
            video.pause();
            // Drop the decode permit as soon as the tile leaves, so a late
            // canplay on a scrolled-past video can't restart it behind us.
            if (item.dataset.active) delete item.dataset.active;
            if (pendingItem === item) pendingItem = null;
          }
        });
      },
      { root: track, threshold: [0, 0.3, 0.5, 0.7, 0.9, 1] }
    );
    ioRef.current = io;
    track.querySelectorAll(".feed-item").forEach((el) => io.observe(el));
    return () => {
      if (settleTimer != null) window.clearTimeout(settleTimer);
      if (primeRaf != null) window.cancelAnimationFrame(primeRaf);
      io.disconnect();
    };
  }, [scenes, muted, loadMore, persistCurrent]);

  // Keyboard nav. A ~220 ms ease-out-cubic slide, quicker than the browser's
  // ~300 ms smooth scroll, cancelling any in-flight slide so presses chain.
  const slideRafRef = useRef<number | null>(null);
  const fastSlide = useCallback((track: HTMLElement, target: number) => {
    if (slideRafRef.current != null) {
      cancelAnimationFrame(slideRafRef.current);
      slideRafRef.current = null;
    }
    const startTop = track.scrollTop;
    const dist = target - startTop;
    if (dist === 0) return;
    // scroll-snap-type: mandatory re-snaps every frame and would teleport the
    // animated scrollTop, so disable snap for the duration and restore after.
    const prevSnap = track.style.scrollSnapType;
    track.style.scrollSnapType = "none";
    const duration = 220;
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const elapsed = ts - startTs;
      const p = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - p, 3);
      track.scrollTop = startTop + dist * ease;
      if (p < 1) {
        slideRafRef.current = requestAnimationFrame(step);
      } else {
        slideRafRef.current = null;
        track.style.scrollSnapType = prevSnap;
      }
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
  const toggleInteractive = useCallback(() => {
    setInteractiveOn((c) => {
      const next = !c;
      try { sessionStorage.setItem(INTERACTIVE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
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
            key={s.__uid}
            scene={s}
            fastModeEnabled={fastModeEnabled}
            muted={muted}
            onToggleMute={toggleMute}
            captionsOn={captionsOn}
            onToggleCaptions={toggleCaptions}
            interactiveOn={interactiveOn}
            interactiveState={interactiveState}
            interactiveInitialised={interactiveInitialised}
            onToggleInteractive={toggleInteractive}
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
                // Nothing is persisted any more; drop any value left behind
                // by an older build so it can never resurface.
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
