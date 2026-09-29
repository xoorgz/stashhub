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
  ImmersiveIcon,
  PipIcon,
  TrashIcon,
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
import { TITLE, TITLE_SEPARATOR } from "src/hooks/title";
import "./Feed.scss";

const VIEWED_KEY = "feed.viewedIds";
const VIEWED_LIMIT = 500;
// How many just-served scenes to hold back when a new cycle starts, so nothing
// repeats right at the boundary.
const RECYCLE_KEEP = 200;
const LIKES_KEY = "feed.likes";
const LIKE_THRESHOLD = 5;
const MUTED_KEY = "feed.muted";
const CAPTIONS_KEY = "feed.captions";
const HQ_KEY = "feed.hq";
const CURRENT_KEY = "feed.currentSceneId";
/** Display name for a scene. Shared so the browser tab and the on-screen
 *  caption can never disagree about what is playing. */
function sceneTitle(scene: {
  id: string;
  title?: string | null;
  files?: Array<{ path?: string | null }> | null;
}): string {
  return (
    scene.title ||
    scene.files?.[0]?.path?.split("/").pop() ||
    `Scene ${scene.id}`
  );
}

// Seconds of playback before a view counts. Matches what a person would call
// "actually watched" rather than a glance while scrolling past.
const PLAY_COUNT_AFTER_MS = 5000;
const IMMERSIVE_KEY = "feed.immersive";
const SKIPPED_TAGS_KEY = "feed.skips.tags";
const SCENE_SKIPS_KEY = "feed.skips.scenes";
const SCENE_SKIPS_MAX = 3000;
const QUEUE_TARGET = 30;
const REFILL_AT = 10;

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
/** Envelope height at a bucket, as a percentage of the strip. The floor keeps
 *  a continuous spine through silence. */
function waveHeightAt(peaks: number[], i: number): number {
  const at = peaks[Math.max(0, Math.min(peaks.length - 1, i))] || 0;
  return Math.max(6, Math.min(100, at));
}

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

// Removes the scene and its video file. delete_generated clears stash's own
// previews and sprites. Sidecars are untouched: pkg/scene/delete.go no longer
// removes the funscript, and subtitles were never in its remit, so both stay
// on disk and are picked back up if the video is ever re-added.
async function destroyScene(id: string): Promise<boolean> {
  try {
    await client.mutate<
      GQL.SceneDestroyMutation,
      GQL.SceneDestroyMutationVariables
    >({
      mutation: GQL.SceneDestroyDocument,
      variables: { id, delete_file: true, delete_generated: true },
    });
    return true;
  } catch (e) {
    console.warn("[feed] sceneDestroy failed", e);
    return false;
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

type FsDoc = Document & {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void>;
};

function isFullscreen(): boolean {
  const doc = document as FsDoc;
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

function exitFullscreen(): Promise<void> {
  const doc = document as FsDoc;
  if (!isFullscreen()) return Promise.resolve();
  const fn = doc.exitFullscreen || doc.webkitExitFullscreen;
  if (!fn) return Promise.resolve();
  return Promise.resolve(fn.call(doc)).catch(() => undefined);
}

/** Hand the video to the platform's own player. Immersive mode may already
 *  hold document fullscreen, and a video cannot enter its own fullscreen from
 *  inside that, so stand down first and only then ask. That was the whole
 *  reason the button appeared to do nothing: it was toggling the page's
 *  fullscreen off rather than opening the native player. */
async function enterNativeVideoFullscreen(video: HTMLVideoElement | null) {
  if (!video) return;
  const v = video as HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  if (isFullscreen()) await exitFullscreen();
  try {
    // webkitEnterFullscreen first: on iPhone it is the only one that exists,
    // and it is the one that opens the native player.
    if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    else if (v.requestFullscreen) await v.requestFullscreen();
    else v.webkitRequestFullscreen?.();
  } catch {
    /* refused, nothing sensible to do */
  }
}

type PipVideo = HTMLVideoElement & {
  webkitSetPresentationMode?: (mode: string) => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
  disablePictureInPicture?: boolean;
};

/** iPhone Safari never implemented requestPictureInPicture, but has had
 *  webkitSetPresentationMode since iOS 14, and neither needs fullscreen. */
function pipSupported(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  const v = video as PipVideo;
  if (v.webkitSupportsPresentationMode) {
    return v.webkitSupportsPresentationMode("picture-in-picture");
  }
  return (
    typeof v.requestPictureInPicture === "function" &&
    !!(document as Document & { pictureInPictureEnabled?: boolean })
      .pictureInPictureEnabled
  );
}

function togglePip(video: HTMLVideoElement | null) {
  if (!video) return;
  const v = video as PipVideo;
  const doc = document as Document & {
    pictureInPictureElement?: Element | null;
    exitPictureInPicture?: () => Promise<void>;
  };
  try {
    if (v.webkitSetPresentationMode) {
      const anyV = v as unknown as { webkitPresentationMode?: string };
      v.webkitSetPresentationMode(
        anyV.webkitPresentationMode === "picture-in-picture"
          ? "inline"
          : "picture-in-picture"
      );
      return;
    }
    if (doc.pictureInPictureElement) {
      doc.exitPictureInPicture?.();
    } else {
      v.requestPictureInPicture?.().catch(() => {});
    }
  } catch {
    /* browser refused, nothing sensible to do */
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
  hqOverride: boolean;
  onToggleHq: () => void;
  muted: boolean;
  onToggleMute: () => void;
  captionsOn: boolean;
  onToggleCaptions: () => void;
  interactiveOn: boolean;
  interactiveState: ConnectionState;
  interactiveInitialised: boolean;
  onToggleInteractive: () => void;
  onDeleted: (sceneId: string) => void;
  onSpawnHearts: (x: number, y: number, count: number) => void;
  onSpawnDrops: (x: number, y: number, count: number) => void;
  immersive: boolean;
  onToggleImmersive: () => void;
}

const FeedItem: React.FC<FeedItemProps> = ({
  scene,
  fastModeEnabled,
  hqOverride,
  onToggleHq,
  muted,
  onToggleMute,
  captionsOn,
  onToggleCaptions,
  interactiveOn,
  interactiveState,
  interactiveInitialised,
  onToggleInteractive,
  onDeleted,
  onSpawnHearts,
  onSpawnDrops,
  immersive,
  onToggleImmersive,
}) => {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<HTMLDivElement | null>(null);

  // Use scene.like_count when available; fall back to local cache.
  const [likeCount, setLikeCount] = useState<number>(
    () => (scene as any).like_count ?? getLikeCount(scene.id)
  );
  const [oCount, setOCount] = useState<number>(scene.o_counter ?? 0);
  const [playCount, setPlayCount] = useState<number>(scene.play_count ?? 0);
  const [playBumped, setPlayBumped] = useState(false);
  // The wink is a one-shot, the accent is not: once this scene has been
  // counted the eye stays lit for the rest of the session, so a glance at the
  // rail says whether the play landed.
  const [playCounted, setPlayCounted] = useState(false);
  const prevPlayCountRef = useRef(playCount);
  useEffect(() => {
    if (playCount <= prevPlayCountRef.current) {
      prevPlayCountRef.current = playCount;
      return;
    }
    prevPlayCountRef.current = playCount;
    setPlayCounted(true);
    setPlayBumped(true);
    // Timed rather than onAnimationEnd: reduced-motion viewers get no
    // animationend event and the highlight would never clear.
    const t = window.setTimeout(() => setPlayBumped(false), 1100);
    return () => window.clearTimeout(t);
  }, [playCount]);

  const [liking, setLiking] = useState(false);
  const [oing, setOing] = useState(false);
  const [pulse, setPulse] = useState<"play" | "pause" | "back" | "fwd" | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [canPip, setCanPip] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  // The Delete key is handled at the feed root, which has no access to this
  // tile's state, so it arrives as an event on the item, the same way keyboard
  // seeks reach the pulse chip. It opens the confirmation rather than deleting
  // outright: a key that destroys a file on one press is not something to have
  // under a thumb resting on the keyboard.
  useEffect(() => {
    const item = itemRef.current;
    if (!item) return;
    const onDeleteRequest = () => setConfirmDelete(true);
    item.addEventListener("feed-delete-request", onDeleteRequest);
    return () => item.removeEventListener("feed-delete-request", onDeleteRequest);
  }, []);

  // While the confirmation is open it owns Escape, so a cancel does not also
  // drop out of fullscreen. Capture phase to beat the root handler.
  useEffect(() => {
    if (!confirmDelete) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        setConfirmDelete(false);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirmDelete]);

  // Fast mode streams a pre-generated small/fast-start copy. The HQ override
  // is owned by the feed now, so it survives a swipe to the next video.
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

  // Loudness envelope for the seek bar, pre-generated next to the fast copy.
  // Missing for a scene that has none, in which case the bar stays flat.
  const waveformSrc = useMemo(() => {
    const shot = relativize(scene.paths.screenshot);
    if (!shot) return "";
    return shot.replace(/\/screenshot(?=$|[?#])/, "/waveform");
  }, [scene.paths.screenshot]);

  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    if (!waveformSrc) return;
    let cancelled = false;
    fetch(waveformSrc)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && Array.isArray(d) && d.length) setPeaks(d as number[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [waveformSrc]);

  // One silhouette masks both the track and the played fill, so they cannot
  // drift apart: the played element is clipped by its width inside a wrapper
  // that always spans the full bar.
  const waveMask = useMemo(() => {
    if (!peaks || peaks.length < 8) return "";
    const n = peaks.length;
    // One filled shape traced along the top and back along the bottom, the way
    // an audio editor draws it. Discrete bars left gaps the whole strip through.
    // Half-heights, so the viewBox is 200 tall and every coordinate is a whole
    // number: shorter to serialise and nothing to round.
    const h = (i: number) => waveHeightAt(peaks, i);
    let top = "";
    let bottom = "";
    for (let i = 0; i < n; i++) {
      top += `${i === 0 ? "M" : "L"}${i} ${100 - h(i)}`;
      bottom = `L${i} ${100 + h(i)}` + bottom;
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n - 1} 200"` +
      ` preserveAspectRatio="none">` +
      `<path d="${top}${bottom}Z" fill="#fff"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }, [peaks]);

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
    // Checked here rather than during render: the ref is still null on the
    // first pass, so asking then would hide the button permanently. Safari
    // only reports support once the element has media attached.
    setCanPip(pipSupported(v));
    function applyAspect() {
      if (!v || !w) return;
      setCanPip(pipSupported(v));
      if (v.videoWidth && v.videoHeight) {
        w.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
        // Drives the fit in immersive mode. Upright clips fill the screen the
        // way a reel should; wide ones keep their whole frame, because
        // cropping a landscape video to a portrait screen throws away most of
        // the picture. Ordinary mode ignores this entirely.
        const item = itemRef.current;
        if (item) {
          // Strictly taller than wide fills the screen. Square counts as
          // wide: cropping a 1:1 clip to a tall phone throws away nearly half
          // the frame, which reads as a stretched, zoomed-in mess.
          item.dataset.fit = v.videoWidth < v.videoHeight ? "fill" : "whole";
        }
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

    // Hover preview: everything left of the pointer lightens, the way a video
    // player shows where a click would land. Pointer devices only, since a
    // touch fires a synthetic mousemove that would leave the fill stuck on.
    function hoverAt(clientX: number) {
      const h = hoverRef.current;
      if (!h) return;
      const rect = p!.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      h.style.width = `${ratio * 100}%`;
    }
    function hoverMove(ev: MouseEvent) {
      hoverAt(ev.clientX);
    }
    function hoverLeave() {
      if (hoverRef.current) hoverRef.current.style.width = "0";
    }
    const canHover =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover)").matches;

    p.addEventListener("mousedown", mouseDown);
    p.addEventListener("touchstart", touchStart, { passive: true });
    if (canHover) {
      p.addEventListener("mousemove", hoverMove);
      p.addEventListener("mouseleave", hoverLeave);
    }
    return () => {
      p.removeEventListener("mousedown", mouseDown);
      p.removeEventListener("touchstart", touchStart);
      p.removeEventListener("mousemove", hoverMove);
      p.removeEventListener("mouseleave", hoverLeave);
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseUp);
      detachTouch();
    };
  }, []);

  // Pinch to zoom the picture itself. Applied as a transform on the <video> so
  // only the frame scales and the overlay stays put. Two fingers zoom, one
  // finger pans while zoomed, and releasing near 1x snaps back to fit. The
  // feed's vertical swipe is only suppressed while actually zoomed in.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    let scale = 1;
    let tx = 0;
    let ty = 0;
    const pts = new Map<number, { x: number; y: number }>();
    let startDist = 0;
    let startScale = 1;
    let panFrom: { x: number; y: number } | null = null;

    const apply = () => {
      v.style.transform =
        scale === 1 && tx === 0 && ty === 0
          ? ""
          : `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
      v.style.touchAction = scale > 1.01 ? "none" : "";
      // On the root, not the item: the nav arrows are fixed and live outside
      // the tile, and they have to fade with the rail.
      v.closest(".feed-root")?.classList.toggle("is-zoomed", scale > 1.01);
    };

    const dist = () => {
      const [a, b] = Array.from(pts.values());
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    // Keep the frame covering its box so zooming never exposes empty edges.
    const clampPan = () => {
      const r = v.getBoundingClientRect();
      const maxX = Math.max(0, (r.width * scale - r.width) / 2);
      const maxY = Math.max(0, (r.height * scale - r.height) / 2);
      tx = Math.min(maxX, Math.max(-maxX, tx));
      ty = Math.min(maxY, Math.max(-maxY, ty));
    };

    const onDown = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        startDist = dist();
        startScale = scale;
        panFrom = null;
      } else if (pts.size === 1 && scale > 1.01) {
        panFrom = { x: e.clientX, y: e.clientY };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && startDist > 0) {
        e.preventDefault();
        scale = Math.min(5, Math.max(1, (dist() / startDist) * startScale));
        clampPan();
        apply();
      } else if (pts.size === 1 && panFrom && scale > 1.01) {
        e.preventDefault();
        tx += e.clientX - panFrom.x;
        ty += e.clientY - panFrom.y;
        panFrom = { x: e.clientX, y: e.clientY };
        clampPan();
        apply();
      }
    };

    const onUp = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) startDist = 0;
      if (pts.size === 0) {
        panFrom = null;
        // Anything near fit returns to exactly fit, so the feed is never left
        // a hair zoomed and unable to scroll.
        if (scale < 1.05) {
          scale = 1;
          tx = 0;
          ty = 0;
          v.style.transition = "transform 160ms ease";
          apply();
          window.setTimeout(() => {
            v.style.transition = "";
          }, 180);
        }
      }
    };

    // Keyboard zoom lands on the item, dispatched by the feed root, and drives
    // the same scale the pinch does so the two cannot disagree.
    const item = itemRef.current;
    const onZoom = (e: Event) => {
      const dir = (e as CustomEvent<string>).detail;
      if (dir === "reset") {
        scale = 1;
        tx = 0;
        ty = 0;
      } else {
        scale = Math.min(5, Math.max(1, dir === "in" ? scale * 1.25 : scale / 1.25));
        if (scale <= 1.001) {
          scale = 1;
          tx = 0;
          ty = 0;
        }
        clampPan();
      }
      v.style.transition = "transform 140ms ease";
      apply();
      window.setTimeout(() => {
        v.style.transition = "";
      }, 160);
    };
    item?.addEventListener("feed-zoom", onZoom);

    v.addEventListener("pointerdown", onDown);
    v.addEventListener("pointermove", onMove, { passive: false });
    v.addEventListener("pointerup", onUp);
    v.addEventListener("pointercancel", onUp);
    return () => {
      v.closest(".feed-root")?.classList.remove("is-zoomed");
      item?.removeEventListener("feed-zoom", onZoom);
      v.removeEventListener("pointerdown", onDown);
      v.removeEventListener("pointermove", onMove);
      v.removeEventListener("pointerup", onUp);
      v.removeEventListener("pointercancel", onUp);
      v.style.transform = "";
      v.style.touchAction = "";
    };
  }, [scene.id]);

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

  // Register a play after 5s, and push watched seconds every 3s so the count
  // visibly climbs rather than jumping in ten second steps. The scene player
  // ticks every second but only sends every ten, which is why play time used
  // to look frozen while watching. The Top Watched and Watched Tags buckets
  // have no other source for this.
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
    const FLUSH_INTERVAL_MS = 3_000;
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
      }, PLAY_COUNT_AFTER_MS);
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
  const title = sceneTitle(scene);

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
          <div
            className={`feed-progress${waveMask ? " has-wave" : ""}`}
            ref={progressRef}
          >
            <div
              className="feed-progress-wave"
              style={
                waveMask
                  ? { WebkitMaskImage: waveMask, maskImage: waveMask }
                  : undefined
              }
            >
              <div className="feed-progress-track" />
              <div className="feed-progress-hover" ref={hoverRef} />
              <div className="feed-progress-bar" ref={barRef} />
            </div>
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

          <div
            className={`feed-action feed-play-count${
              playCounted ? " is-counted" : ""
            }${playBumped ? " is-bumped" : ""}`}
            title="Play count"
          >
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
                  : "Full quality. Tap to go back to fast mode."
              }
              onClick={(e) => {
                e.preventDefault();
                onToggleHq();
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

          {/* These two render before the toggle on purpose. The rail packs to
              the bottom, so anything after a button lifts it: with the pair
              below, turning immersive on shifted the toggle out from under the
              user's thumb. Rendered above, the toggle never moves. */}
          {/* Both only while immersive: they are watching tools, and the rail
              is long enough already when simply browsing. */}
          {immersive && canPip && (
            <button
              type="button"
              className="feed-action feed-pip-btn"
              title="Picture in picture"
              onClick={(e) => {
                e.preventDefault();
                togglePip(videoRef.current);
              }}
            >
              <PipIcon />
            </button>
          )}

          {/* Hands the video to the platform's own player. On iPhone this is
              the only route to real fullscreen, and it was previously reachable
              only by double-click, which is gated to devices with a pointer. */}
          {immersive && (
            <button
              type="button"
              className="feed-action feed-nativefs-btn"
              title="Native player fullscreen"
              onClick={(e) => {
                e.preventDefault();
                enterNativeVideoFullscreen(videoRef.current);
              }}
            >
              <FullscreenIcon />
            </button>
          )}

          <button
            type="button"
            className={`feed-action feed-immersive-btn${immersive ? " is-on" : ""}`}
            title={
              immersive
                ? "Leave fullscreen, or F"
                : "Fullscreen, or F (double-click video for video-only fullscreen)"
            }
            onClick={(e) => {
              e.preventDefault();
              onToggleImmersive();
            }}
          >
            <ImmersiveIcon on={immersive} />
          </button>

          <button
            type="button"
            className="feed-action feed-delete-btn"
            title="Delete scene"
            onClick={(e) => {
              e.preventDefault();
              setConfirmDelete(true);
            }}
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* Confirmation is inline rather than a Bootstrap modal: the feed is a
          self-contained fixed-position layer, and a modal's own positioning
          and backdrop fight the immersive layout. */}
      {confirmDelete && (
        <div className="feed-confirm" role="dialog" aria-modal="true">
          <div className="feed-confirm-box">
            <h4>Delete this scene?</h4>
            <p className="feed-confirm-name">{title}</p>
            <p className="feed-confirm-note">
              The video file is removed. Any funscript or subtitle files stay
              on disk.
            </p>
            <div className="feed-confirm-actions">
              <button
                type="button"
                className="feed-confirm-cancel"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="feed-confirm-delete"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  const ok = await destroyScene(scene.id);
                  setDeleting(false);
                  setConfirmDelete(false);
                  // Only drop the tile once the server confirms, so a failed
                  // delete never makes a scene silently vanish from the feed.
                  if (ok) onDeleted(scene.id);
                }}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const Feed: React.FC = () => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const loadingMoreRef = useRef(false);
  // Consecutive refills that came back empty. See loadMore.
  const emptyBuildsRef = useRef(0);
  const currentVisibleRef = useRef<HTMLDivElement | null>(null);

  // Where the picture actually is inside the video element. With contain the
  // element still fills its box and the frame is letterboxed inside it, so
  // controls anchored to the element land on the black bars rather than on the
  // video. Published as CSS vars on the root, which is the one place both the
  // per-item rail and the fixed nav arrows can read.
  const syncPictureBox = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const v = currentVisibleRef.current?.querySelector<HTMLVideoElement>("video");
    let pillar = 0;
    let letterbox = 0;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      const r = v.getBoundingClientRect();
      // Read the resolved fit rather than guessing from the viewport: mobile
      // and portrait clips still use cover, where there are no bars at all.
      if (
        r.width > 0 &&
        r.height > 0 &&
        window.getComputedStyle(v).objectFit === "contain"
      ) {
        const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        pillar = Math.max(0, (r.width - v.videoWidth * k) / 2);
        letterbox = Math.max(0, (r.height - v.videoHeight * k) / 2);
      }
    }
    root.style.setProperty("--feed-pillar", `${Math.round(pillar)}px`);
    root.style.setProperty("--feed-letterbox", `${Math.round(letterbox)}px`);
  }, []);

  const [scenes, setScenes] = useState<QueuedScene[]>([]);
  // Pixels removed from above the viewport by a trim, applied to scrollTop
  // before the browser paints so the view never jumps.
  const pendingTrimRef = useRef(0);
  // The tile being watched when a trim was queued, and how far the scroller
  // sat from its top. Restoring that pair is immune to the browser clamping
  // scrollTop, which arithmetic on scrollTop is not. See the trim effect.
  const trimAnchorRef = useRef<{ el: HTMLElement; delta: number } | null>(null);
  const slideRafRef = useRef<number | null>(null);
  // Start and destination of an in-flight slide, held in refs rather than the
  // animation's closure so a trim can shift both. Stepping from the live
  // scrollTop also meant a second press during the 220ms animation rounded back
  // to the tile being left and re-targeted it, swallowing quick presses.
  const slideStartRef = useRef(0);
  const slideTargetRef = useRef<number | null>(null);
  // The key handler is installed before scrollBy exists, so it calls through a
  // ref rather than duplicating the stepping maths.
  const scrollByRef = useRef<(dir: 1 | -1) => void>(() => {});
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
  // Full-quality override for fast mode. Lifted to the feed so it holds across
  // videos instead of snapping back to fast mode on every swipe.
  const [hqOverride, setHqOverride] = useState<boolean>(
    () => sessionStorage.getItem(HQ_KEY) === "1"
  );
  // Immersive mode sticks across sessions: it is a way of watching, not a
  // per-visit toggle. Also takes real fullscreen where the browser allows it,
  // which iPhone Safari does not for anything but a bare video.
  const [immersive, setImmersive] = useState<boolean>(
    () => localStorage.getItem(IMMERSIVE_KEY) === "1"
  );
  const toggleImmersive = useCallback(() => {
    setImmersive((on) => {
      const next = !on;
      try {
        localStorage.setItem(IMMERSIVE_KEY, next ? "1" : "0");
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const t = trackRef.current;
    // A frame late, so the immersive class has been applied and the element
    // has its new size before anything is measured.
    const tick = () => requestAnimationFrame(syncPictureBox);
    tick();
    window.addEventListener("resize", tick);
    document.addEventListener("fullscreenchange", tick);
    // loadedmetadata does not bubble, so it is caught on the way down.
    t?.addEventListener("loadedmetadata", tick, true);
    return () => {
      window.removeEventListener("resize", tick);
      document.removeEventListener("fullscreenchange", tick);
      t?.removeEventListener("loadedmetadata", tick, true);
    };
  }, [syncPictureBox, immersive]);
  // The side nav lives outside this component and sits above it (z-index 150
  // against the feed's 50), so a class on <body> is the only way to reach it.
  // Cleared on unmount so leaving the feed always gives the nav back.
  useEffect(() => {
    document.body.classList.toggle("feed-immersive", immersive);
    return () => document.body.classList.remove("feed-immersive");
  }, [immersive]);

  // Tiles are exactly 100dvh, and entering or leaving fullscreen changes what
  // that is. The scroll offset does not follow, so the feed ends up parked
  // between two tiles: you see the current one plus a slice of its neighbour,
  // which reads as a second avatar and second button rail. Realign on the next
  // frame, once the new viewport height has settled.
  useEffect(() => {
    const t = trackRef.current;
    const item = currentVisibleRef.current;
    if (!t || !item) return;
    const id = window.requestAnimationFrame(() => {
      t.scrollTo({ top: item.offsetTop, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [immersive]);

  // Same correction for fullscreen changes the app did not initiate, and for
  // rotating the device or resizing the window.
  useEffect(() => {
    let raf: number | null = null;
    function realign() {
      const t = trackRef.current;
      const item = currentVisibleRef.current;
      if (!t || !item) return;
      if (raf != null) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        t.scrollTo({ top: item.offsetTop, behavior: "auto" });
      });
    }
    window.addEventListener("resize", realign);
    window.addEventListener("orientationchange", realign);
    document.addEventListener("fullscreenchange", realign);
    document.addEventListener("webkitfullscreenchange", realign);
    return () => {
      if (raf != null) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", realign);
      window.removeEventListener("orientationchange", realign);
      document.removeEventListener("fullscreenchange", realign);
      document.removeEventListener("webkitfullscreenchange", realign);
    };
  }, []);

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
  useEffect(() => {
    sessionStorage.setItem(HQ_KEY, hqOverride ? "1" : "0");
  }, [hqOverride]);

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

  // Name the browser tab after whatever is playing. Set imperatively rather
  // than through state and Helmet: this fires on every scene change, and a
  // state update here would re-render every tile in the feed, which is exactly
  // the work the scrolling path avoids doing.
  const scenesRef = useRef(scenes);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);

  const setFeedTitle = useCallback((sceneId: string | undefined) => {
    const scene = sceneId
      ? scenesRef.current.find((s) => s.id === sceneId)
      : undefined;
    document.title = scene
      ? `${sceneTitle(scene)}${TITLE_SEPARATOR}${TITLE}`
      : TITLE;
  }, []);

  // Hand the tab back when leaving the feed, so another route does not inherit
  // the name of the last scene watched.
  useEffect(() => {
    return () => {
      document.title = TITLE;
    };
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
      if (details.length === 0) {
        // Buckets draw a page each; one page can come back fully watched. A
        // wider draw reseeds the random bucket and pulls deeper ranked pages,
        // which is nearly always enough to avoid replaying anything.
        ids = await buildQueue({ targetCount: 60, exclude });
        details = await fetchSceneDetails(ids);
      }
      // An empty build is far more often a failure than an exhausted library.
      // Every bucket query sits behind a 30s timeout that resolves to an empty
      // list, so a slow server returns nothing at all. Recycling on that wiped
      // the viewed history for good and replayed everything already watched:
      // a transient slowdown became a permanent loop. So an empty build now
      // just ends this attempt and the next scroll tries again, and only a
      // run of them in a row is taken to mean the library is spent.
      if (details.length === 0) {
        emptyBuildsRef.current += 1;
        if (emptyBuildsRef.current < 3) return;
      } else {
        emptyBuildsRef.current = 0;
      }
      if (details.length === 0) {
        emptyBuildsRef.current = 0;
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
    const anchor = trimAnchorRef.current;
    trimAnchorRef.current = null;
    const track = trackRef.current;
    if (!track) return;
    // Put the watched tile back where it was on screen. Subtracting the removed
    // height from scrollTop went wrong near the end of the list, which is
    // exactly where holding a key down leaves you: the list shrinks below the
    // scroll position, the browser clamps scrollTop to the new maximum on its
    // own, and subtracting again pinned the feed at 0, a full KEEP_BEHIND of
    // tiles back. Reproduced headless: 14 backward jumps in one run.
    if (anchor && anchor.el.isConnected) {
      track.scrollTop = anchor.el.offsetTop + anchor.delta;
    } else {
      track.scrollTop = Math.max(0, track.scrollTop - px);
    }
    // A slide in flight holds coordinates from before the trim. Without this
    // its next frame writes the old scrollTop straight back and the feed lands
    // several tiles above where it was, replaying what was just watched.
    if (slideRafRef.current != null) {
      slideStartRef.current -= px;
      if (slideTargetRef.current != null) slideTargetRef.current -= px;
    }
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

    // Any press brings the overlay back and restarts its countdown. Without
    // this the chrome faded after ten seconds and, in immersive mode where the
    // buttons fade too, there was no way to get them back short of changing
    // scene. Passive and non-capturing, so it never interferes with the taps
    // the buttons and the scrubber already handle.
    function revealOnPress() {
      const item = currentVisibleRef.current;
      if (item) showMetaAndScheduleFade(item);
    }
    track.addEventListener("pointerdown", revealOnPress, { passive: true });

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
    function isDesktopClient() {
      return typeof window.matchMedia === "function"
        && window.matchMedia("(hover: hover)").matches;
    }

    function cacheAhead(activeItem: HTMLDivElement) {
      if (!fastModeRef.current) return;
      const items = Array.from(track!.querySelectorAll<HTMLDivElement>(".feed-item"));
      const idx = items.indexOf(activeItem);
      if (idx === -1) return;
      // The scene playing plus the ones after it. Caching the current one does
      // mean fetching it a second time, which is why it was dropped before, but
      // without it every seek inside the video you are actually watching goes
      // to the network: measured at 32 seconds on one jump. This only runs once
      // playback is under way, and the worker abandons it the moment you move
      // on, so it no longer competes with a cold start.
      //
      // Two ahead on desktop: the uplink sits around 2% used and bulk clients
      // are capped at the proxy now, so the bytes are free, and holding a key
      // down used to outrun a single-tile lookahead. Phones stay at one, where
      // the cost is battery and heat rather than bandwidth. The worker cancels
      // whatever is no longer wanted, so overshooting on a fast scroll is
      // abandoned rather than paid for.
      const ahead = isDesktopClient() ? 2 : 1;
      const urls: string[] = [];
      for (let i = idx; i <= Math.min(items.length - 1, idx + ahead); i++) {
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
        setFeedTitle(id);
      }
      showMetaAndScheduleFade(item);
      const items = track.querySelectorAll(".feed-item");
      const idx = Array.from(items).indexOf(item);
      if (items.length - idx <= REFILL_AT) loadMore();
      // Drop tiles far above the active one, each holds a <video> and a poster.
      // Only runs on a settled tile, never mid-fling.
      const excess = idx - KEEP_BEHIND;
      if (excess >= TRIM_CHUNK && pendingTrimRef.current === 0) {
        // Sum the real heights of the tiles being dropped, not excess x one
        // height. Any tile can differ and a wrong total is what made the
        // scroller visibly jump back over already-seen videos.
        const dropped = Array.from(items).slice(0, excess);
        const droppedH = dropped.reduce(
          (sum, el) => sum + (el as HTMLElement).offsetHeight,
          0
        );
        if (droppedH > 0) {
          pendingTrimRef.current += droppedH;
          trimAnchorRef.current = {
            el: item,
            delta: track.scrollTop - item.offsetTop,
          };
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
            // A different scene means a different shape, so the bars move.
            requestAnimationFrame(syncPictureBox);
            // Refill here rather than only in activate(): that sits behind the
            // settle timer, so a held key never triggers it and the feed runs
            // out of tiles with nothing left to scroll onto.
            {
              const all = track.querySelectorAll(".feed-item");
              const at = Array.prototype.indexOf.call(all, item);
              if (at !== -1 && all.length - at <= REFILL_AT) loadMore();
            }
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
      track.removeEventListener("pointerdown", revealOnPress);
      io.disconnect();
    };
  }, [scenes, muted, loadMore, persistCurrent, syncPictureBox]);

  // Keyboard nav. A ~220 ms ease-out-cubic slide, quicker than the browser's
  // ~300 ms smooth scroll, cancelling any in-flight slide so presses chain.
  const fastSlide = useCallback((track: HTMLElement, target: number) => {
    if (slideRafRef.current != null) {
      cancelAnimationFrame(slideRafRef.current);
      slideRafRef.current = null;
    }
    const startTop = track.scrollTop;
    if (target === startTop) {
      // Nothing to animate, but a cancelled slide may have left snapping off.
      track.style.scrollSnapType = "";
      slideTargetRef.current = null;
      return;
    }
    slideStartRef.current = startTop;
    slideTargetRef.current = target;
    // scroll-snap-type: mandatory re-snaps every frame and would teleport the
    // animated scrollTop, so turn it off for the duration. Never save and
    // restore the old inline value: a second press mid-slide read back the
    // "none" the first one had just set, restored that on finishing, and
    // snapping stayed off for the rest of the session. The feed could then rest
    // between two tiles, where neither reaches the 0.7 ratio the observer needs,
    // so nothing played and it sat there until enough presses shoved it over.
    // Clearing the inline value instead hands control back to the stylesheet.
    track.style.scrollSnapType = "none";
    const duration = 220;
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const elapsed = ts - startTs;
      const p = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - p, 3);
      // Read both ends back each frame: a trim between frames rewrites them.
      const from = slideStartRef.current;
      const to = slideTargetRef.current ?? target;
      track.scrollTop = from + (to - from) * ease;
      if (p < 1) {
        slideRafRef.current = requestAnimationFrame(step);
      } else {
        slideRafRef.current = null;
        slideTargetRef.current = null;
        track.style.scrollSnapType = "";
      }
    };
    slideRafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Cmd/Ctrl with plus, minus or zero zooms the picture instead of the
      // page. Browsers do let these be intercepted, which is how drawing apps
      // bind the same keys to their canvas.
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const zoom =
          e.key === "+" || e.key === "=" ? "in"
          : e.key === "-" || e.key === "_" ? "out"
          : e.key === "0" ? "reset"
          : "";
        if (zoom) {
          e.preventDefault();
          currentVisibleRef.current?.dispatchEvent(
            new CustomEvent("feed-zoom", { detail: zoom })
          );
          return;
        }
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = trackRef.current;
      if (!t) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        scrollByRef.current(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        scrollByRef.current(-1);
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
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleImmersive();
      } else if (e.key === "Delete") {
        // Ask the visible tile to open its confirmation. Backspace is
        // deliberately not bound: on some keyboards it is the back gesture.
        e.preventDefault();
        currentVisibleRef.current?.dispatchEvent(
          new CustomEvent("feed-delete-request")
        );
      } else if (e.key === "Escape") {
        // Immersive is a page mode, so the browser will not undo it for us.
        // Not prevented: Escape has to keep working for anything else
        // listening, and it still leaves a native video fullscreen.
        if (localStorage.getItem(IMMERSIVE_KEY) === "1") {
          setImmersive(false);
          try {
            localStorage.setItem(IMMERSIVE_KEY, "0");
          } catch { /* ignore */ }
        }
        exitFullscreen();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const scrollBy = useCallback((dir: 1 | -1) => {
    const t = trackRef.current;
    if (!t) return;
    // Step by the tile's measured height and round to the nearest boundary, so
    // a slide always lands on a snap point. clientHeight differs from the tile
    // height when dvh and the real viewport disagree, which left the scroller
    // just off-snap and let mandatory snapping jump it back a tile.
    const item = t.querySelector<HTMLElement>(".feed-item");
    const step = item?.offsetHeight || t.clientHeight;
    // Count from where the current slide is going, not where it is now, so a
    // press during the animation advances a further tile. Only while one is
    // actually running: a native touch scroll would leave the target stale.
    const base =
      slideRafRef.current != null && slideTargetRef.current != null
        ? slideTargetRef.current
        : t.scrollTop;
    fastSlide(t, (Math.round(base / step) + dir) * step);
  }, [fastSlide]);
  useEffect(() => {
    scrollByRef.current = scrollBy;
  }, [scrollBy]);

  // One wheel gesture, one video. Without this a notch scrolls part of a tile
  // and snap decides where it lands, and a trackpad flick runs through
  // several. Pointer devices only: touch scrolling is already a swipe.
  useEffect(() => {
    const t = trackRef.current;
    if (!t) return;
    if (!window.matchMedia("(hover: hover)").matches) return;

    // Momentum arrives as a continuous stream, a real gesture as a burst with
    // a gap in front of it. Re-arming only after the stream goes quiet is what
    // stops one flick from running through the queue.
    const QUIET_MS = 140;
    let lastAt = 0;
    let armed = true;

    function onWheel(e: WheelEvent) {
      // Leave the browser's own zoom gesture alone.
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastAt > QUIET_MS) armed = true;
      lastAt = now;
      if (!armed || Math.abs(e.deltaY) < 2) return;
      armed = false;
      scrollBy(e.deltaY > 0 ? 1 : -1);
    }

    t.addEventListener("wheel", onWheel, { passive: false });
    return () => t.removeEventListener("wheel", onWheel);
  }, [scrollBy]);

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
  const toggleHq = useCallback(() => {
    setHqOverride((v) => {
      const next = !v;
      try { sessionStorage.setItem(HQ_KEY, next ? "1" : "0"); } catch { /* ignore */ }
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
    <div
      className={`feed-root${immersive ? " is-immersive" : ""}`}
      ref={rootRef}
    >
      <div className="feed-track" ref={trackRef}>
        {scenes.map((s) => (
          <FeedItem
            key={s.__uid}
            scene={s}
            fastModeEnabled={fastModeEnabled}
            hqOverride={hqOverride}
            onToggleHq={toggleHq}
            muted={muted}
            onToggleMute={toggleMute}
            captionsOn={captionsOn}
            onToggleCaptions={toggleCaptions}
            interactiveOn={interactiveOn}
            interactiveState={interactiveState}
            interactiveInitialised={interactiveInitialised}
            onToggleInteractive={toggleInteractive}
            onSpawnHearts={spawnHearts}
            onSpawnDrops={spawnDrops}
            onDeleted={(sid) =>
              setScenes((prev) => prev.filter((x) => x.id !== sid))
            }
            immersive={immersive}
            onToggleImmersive={toggleImmersive}
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
