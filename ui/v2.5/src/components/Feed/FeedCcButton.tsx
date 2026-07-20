import React, { useCallback, useEffect, useRef, useState } from "react";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import { useToast } from "src/hooks/Toast";
import { CcOnIcon, CcOffIcon, CcGenerateIcon } from "./icons";

// localStorage Set of scene IDs whose caption-generation we have
// triggered. Tracking it here means the user can close the tab,
// reopen, and the button still shows the "generating" state until
// the VTT actually lands.
const GEN_KEY = "feed.captions.generating";
const FAILED_KEY = "feed.captions.failed";
// Hard ceiling: if a generating entry has no job to track (older entry, or the
// job id was lost) we still forget it after this long so the spinner cannot
// run forever. The job-status path below normally resolves far sooner.
const GEN_TTL_MS = 40 * 60 * 1000;
const FAILED_TTL_MS = 24 * 60 * 60 * 1000; // keep the retry hint for a day
// A successful transcribe ends the plugin job, then fires a metadataScan whose
// captions land a moment later. Don't call failure until this grace after the
// job leaves the queue, or a success would flash as failed.
const DONE_GRACE_MS = 90 * 1000;

interface GenEntry {
  at: number;
  jobId?: string;
  // First time the plugin job was seen gone/finished; starts the grace window.
  jobDoneAt?: number;
}

function readMap(key: string, ttl: number): Record<string, GenEntry> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const cutoff = Date.now() - ttl;
    const out: Record<string, GenEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const e = v as GenEntry;
      if (e && typeof e.at === "number" && e.at >= cutoff) out[k] = e;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(key: string, m: Record<string, GenEntry>) {
  try { localStorage.setItem(key, JSON.stringify(m)); } catch { /* ignore */ }
}

const readGenMap = () => readMap(GEN_KEY, GEN_TTL_MS);
const writeGenMap = (m: Record<string, GenEntry>) => writeMap(GEN_KEY, m);
const readFailedMap = () => readMap(FAILED_KEY, FAILED_TTL_MS);
const writeFailedMap = (m: Record<string, GenEntry>) => writeMap(FAILED_KEY, m);

interface Props {
  sceneId: string;
  sceneTitle?: string;
  hasCaptions: boolean;
  captionsOn: boolean;
  onToggle: () => void;
  // Called when the polling detects new captions for this scene so
  // the parent can refetch the scene record and re-render captions.
  onCaptionsAppeared?: () => void;
}

export const FeedCcButton: React.FC<Props> = ({
  sceneId,
  sceneTitle,
  hasCaptions,
  captionsOn,
  onToggle,
  onCaptionsAppeared,
}) => {
  const Toast = useToast();
  const [gen, setGen] = useState<Record<string, GenEntry>>(() => readGenMap());
  const [failed, setFailed] = useState<Record<string, GenEntry>>(() => readFailedMap());
  const generating = !!gen[sceneId];
  const hasFailed = !generating && !hasCaptions && !!failed[sceneId];

  // Once captions actually exist (backfill caught up, or another tab made
  // them), drop any stale generating / failed marker so the button self-heals.
  useEffect(() => {
    if (!hasCaptions) return;
    if (gen[sceneId]) {
      const m = readGenMap();
      delete m[sceneId];
      setGen(m);
      writeGenMap(m);
    }
    if (failed[sceneId]) {
      const m = readFailedMap();
      delete m[sceneId];
      setFailed(m);
      writeFailedMap(m);
    }
  }, [hasCaptions, sceneId, gen, failed]);

  const markFailed = useCallback(() => {
    const g = readGenMap();
    delete g[sceneId];
    setGen(g);
    writeGenMap(g);
    const f = readFailedMap();
    f[sceneId] = { at: Date.now() };
    setFailed(f);
    writeFailedMap(f);
  }, [sceneId]);

  // Background polling for THIS scene's captions while we're in
  // generating mode. Polls every 10 s, max ~30 min. Once the scene
  // gains a caption, removes from the set and signals the parent.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (!generating || hasCaptions) {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const succeed = () => {
      const next = readGenMap();
      delete next[sceneId];
      setGen(next);
      writeGenMap(next);
      onCaptionsAppeared?.();
      // Also notify any Feed listener so the parent can refetch this scene and
      // surface the new <track>s.
      window.dispatchEvent(
        new CustomEvent("stashhub:scene-captions-appeared", {
          detail: { sceneId },
        })
      );
    };
    const poll = async () => {
      try {
        const r = await getClient().query<GQL.FindSceneQuery>({
          query: GQL.FindSceneDocument,
          variables: { id: sceneId },
          fetchPolicy: "no-cache",
        });
        if ((r.data.findScene?.captions?.length ?? 0) > 0) {
          succeed();
          return;
        }
      } catch {
        return; // network blip, try again next tick
      }
      // No captions yet. Decide whether the job is still working or gave up.
      const entry = readGenMap()[sceneId];
      if (!entry) return;
      if (!entry.jobId) {
        // No job to track (older entry). Fall back to the TTL ceiling.
        if (Date.now() - entry.at > GEN_TTL_MS) markFailed();
        return;
      }
      let job: { status?: GQL.JobStatus } | null | undefined;
      try {
        const jr = await getClient().query<GQL.FindJobQuery>({
          query: GQL.FindJobDocument,
          variables: { input: { id: entry.jobId } },
          fetchPolicy: "no-cache",
        });
        job = jr.data.findJob;
      } catch {
        return;
      }
      const alive =
        job &&
        (job.status === GQL.JobStatus.Ready ||
          job.status === GQL.JobStatus.Running ||
          job.status === GQL.JobStatus.Stopping);
      if (alive) {
        // Still running (includes waiting for the transcription lock). Clear any
        // grace stamp we set from a transient miss.
        if (entry.jobDoneAt) {
          const m = readGenMap();
          if (m[sceneId]) { delete m[sceneId].jobDoneAt; writeGenMap(m); }
        }
        return;
      }
      // Job is gone or finished, but the success path fires a trailing
      // metadataScan whose captions land a beat later. Wait out the grace
      // before declaring failure.
      const doneAt = entry.jobDoneAt ?? Date.now();
      if (!entry.jobDoneAt) {
        const m = readGenMap();
        if (m[sceneId]) { m[sceneId].jobDoneAt = doneAt; writeGenMap(m); }
        return;
      }
      if (Date.now() - doneAt > DONE_GRACE_MS) markFailed();
    };
    poll();
    pollRef.current = window.setInterval(poll, 5000);
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [generating, hasCaptions, sceneId, onCaptionsAppeared, markFailed]);

  // Refresh from localStorage when other tabs / windows / scenes update it.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === GEN_KEY) setGen(readGenMap());
      if (e.key === FAILED_KEY) setFailed(readFailedMap());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);


  const onClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      if (generating) return; // ignore clicks while generating
      if (hasCaptions) {
        onToggle();
        return;
      }
      // A previous attempt failed: this click is a retry, clear the marker.
      if (failed[sceneId]) {
        const f = readFailedMap();
        delete f[sceneId];
        setFailed(f);
        writeFailedMap(f);
      }
      // Flip to the generating state NOW, before any network round-trip, so a
      // single press registers instantly (spinner) and further presses are
      // ignored. Without this the button looked dead until two awaited calls
      // finished, so users mashed it and queued a pile of duplicate generate
      // tasks that the serial job queue then chewed through one by one.
      const optimistic = { ...readGenMap(), [sceneId]: { at: Date.now() } };
      setGen(optimistic);
      writeGenMap(optimistic);
      const rollback = () => {
        const m = readGenMap();
        delete m[sceneId];
        setGen(m);
        writeGenMap(m);
      };
      // Defensive: the feed's cached scene record may be stale if the captions
      // were generated elsewhere (scene detail button, cron, a previous tab's
      // poll). Confirm against the server before firing another generate.
      try {
        const r = await getClient().query<GQL.FindSceneQuery>({
          query: GQL.FindSceneDocument,
          variables: { id: sceneId },
          fetchPolicy: "no-cache",
        });
        if ((r.data.findScene?.captions?.length ?? 0) > 0) {
          // Hard reload lands the user back on /feed/:id with fresh data.
          Toast.success("Captions exist, reloading.");
          window.setTimeout(() => window.location.reload(), 400);
          return; // keep the state; the reload replaces it anyway
        }
      } catch {
        /* fall through and start generation */
      }
      try {
        const res = await getClient().mutate<GQL.RunPluginTaskMutation>({
          mutation: GQL.RunPluginTaskDocument,
          variables: {
            plugin_id: "ai-subtitler",
            task_name: "Generate captions: this scene",
            // Shown in the task queue instead of the generic task name, so a
            // queue of these is legible by scene rather than N identical rows.
            description: `Generate captions: ${sceneTitle || `scene ${sceneId}`}`,
            args_map: { scene_id: sceneId },
          },
        });
        // Remember the job id so the poller can tell "still working" (job
        // RUNNING, includes the transcription-lock wait) from "gave up".
        const jobId = res.data?.runPluginTask;
        if (jobId) {
          const m = readGenMap();
          if (m[sceneId]) { m[sceneId].jobId = jobId; writeGenMap(m); setGen(m); }
        }
        Toast.success("Generating captions in the background.");
      } catch (e) {
        rollback(); // undo the optimistic spinner so the user can retry
        Toast.error(e);
      }
    },
    [generating, hasCaptions, onToggle, sceneId, failed, Toast]
  );

  let icon: React.ReactNode;
  let title: string;
  let cls = "feed-action feed-cc-toggle";
  if (generating) {
    icon = <CcOnIcon />;
    title = "Generating captions...";
    cls += " is-generating";
  } else if (hasFailed) {
    icon = <CcGenerateIcon />;
    title = "Caption generation failed, tap to retry";
    cls += " generation-failed";
  } else if (!hasCaptions) {
    icon = <CcGenerateIcon />;
    title = "Generate captions";
    cls += " no-captions";
  } else if (captionsOn) {
    icon = <CcOnIcon />;
    title = "Hide captions";
    cls += " captions-on";
  } else {
    icon = <CcOffIcon />;
    title = "Show captions";
    cls += " captions-off";
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      aria-pressed={hasCaptions && captionsOn}
      aria-busy={generating}
      onClick={onClick}
      disabled={generating}
    >
      {icon}
      {generating && (
        <svg
          className="feed-cc-progress"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray="22 78"
          />
        </svg>
      )}
    </button>
  );
};

export default FeedCcButton;
