import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
const client = getClient();
import { buildQueue, fetchSceneDetails } from "./algorithm";
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
}

const FeedItem: React.FC<FeedItemProps> = ({
  scene,
  muted,
  onToggleMute,
  onSkip,
  onSpawnHearts,
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
  const [pulse, setPulse] = useState<"play" | "pause" | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [bufferedPct, setBufferedPct] = useState(0);

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

  // Double-click → fullscreen
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
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
      // either paused, or its readyState is below HAVE_FUTURE_DATA (3) — i.e.
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
    const onProgressEv = () => {
      if (!v.buffered.length || !isFinite(v.duration) || v.duration <= 0) return;
      const end = v.buffered.end(v.buffered.length - 1);
      const pct = Math.min(100, Math.max(0, Math.round((end / v.duration) * 100)));
      setBufferedPct(pct);
    };
    const onLoadStart = () => {
      setBufferedPct(0);
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
    v.addEventListener("progress", onProgressEv);
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
      v.removeEventListener("progress", onProgressEv);
      v.removeEventListener("loadstart", onLoadStart);
      v.removeEventListener("play", onPlay);
      if (stuckTimer != null) window.clearTimeout(stuckTimer);
      if (loaderTimer != null) window.clearTimeout(loaderTimer);
      window.clearInterval(watchdog);
    };
  }, [scene.id]);

  // Register a play with Stash after 3s of continuous playback
  const playTimerRef = useRef<number | null>(null);
  const playRegisteredRef = useRef(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function startTracking() {
      if (playRegisteredRef.current) return;
      if (playTimerRef.current != null) {
        window.clearTimeout(playTimerRef.current);
      }
      playTimerRef.current = window.setTimeout(async () => {
        if (!playRegisteredRef.current) {
          playRegisteredRef.current = true;
          // Optimistic update: bump UI immediately
          setPlayCount((c) => c + 1);
          const serverCount = await registerScenePlay(scene.id);
          if (typeof serverCount === "number") {
            setPlayCount(serverCount);
          }
        }
      }, 3000);
    }
    function stopTracking() {
      if (playTimerRef.current != null) {
        window.clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    }
    v.addEventListener("play", startTracking);
    v.addEventListener("pause", stopTracking);
    v.addEventListener("ended", stopTracking);
    return () => {
      v.removeEventListener("play", startTracking);
      v.removeEventListener("pause", stopTracking);
      v.removeEventListener("ended", stopTracking);
      stopTracking();
    };
  }, [scene.id]);

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
      const newCount = await incrementSceneO(scene.id);
      if (typeof newCount === "number") setOCount(newCount);
    },
    [scene.id]
  );

  const handleVideoClick = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
    const v = videoRef.current;
    if (!v) return;
    e.preventDefault();
    if (v.paused) {
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
          {loading && (
            <div className="feed-loader" aria-hidden="true">
              <svg className="feed-loader-ring" viewBox="0 0 50 50">
                <circle className="track" cx="25" cy="25" r="20" />
                <circle
                  className="fill"
                  cx="25"
                  cy="25"
                  r="20"
                  strokeDasharray={`${(bufferedPct / 100) * 125.66} 125.66`}
                />
                <circle className="spin" cx="25" cy="25" r="20" />
              </svg>
              <div className="feed-loader-pct">{bufferedPct}%</div>
            </div>
          )}
          {pulse && (
            <div className={`feed-pulse feed-pulse-${pulse}`} aria-hidden="true">
              {pulse === "play" ? (
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
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
            title="Fullscreen"
            onClick={(e) => {
              e.preventDefault();
              toggleFullscreen(videoRef.current);
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

  // Persist mute per tab
  useEffect(() => {
    sessionStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  }, [muted]);

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

    function ensureNeighborSrcs(activeItem: HTMLDivElement) {
      // Prime: active + 2 ahead use preload="auto" so a swipe-down has no
      // buffer pause. 1 back + 3 ahead get src set but preload="metadata".
      // The further-back items stay untouched to limit bandwidth.
      const items = Array.from(track!.querySelectorAll<HTMLDivElement>(".feed-item"));
      const idx = items.indexOf(activeItem);
      if (idx === -1) return;
      const start = Math.max(0, idx - 1);
      const end = Math.min(items.length - 1, idx + 3);
      for (let i = start; i <= end; i++) {
        const it = items[i];
        const v = it.querySelector<HTMLVideoElement>("video.feed-video");
        if (!v) continue;
        // Active + the next 2 get aggressive preload; everything else metadata.
        const aggressive = i >= idx && i <= idx + 2;
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
        // Seek the currently-visible video forward 10s
        e.preventDefault();
        const v = currentVisibleRef.current?.querySelector<HTMLVideoElement>("video");
        if (v && Number.isFinite(v.duration)) {
          v.currentTime = Math.min(v.duration - 0.1, v.currentTime + 10);
        }
      } else if (e.key === "ArrowLeft" || e.key === "h" || e.key === "H") {
        // Seek the currently-visible video back 10s
        e.preventDefault();
        const v = currentVisibleRef.current?.querySelector<HTMLVideoElement>("video");
        if (v) {
          v.currentTime = Math.max(0, v.currentTime - 10);
        }
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
            onSkip={handleSkip}
            onSpawnHearts={spawnHearts}
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
    </div>
  );
};

export default Feed;
