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
const GEN_TTL_MS = 30 * 60 * 1000; // forget entries older than 30 min

interface GenEntry { at: number }

function readGenMap(): Record<string, GenEntry> {
  try {
    const raw = localStorage.getItem(GEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const cutoff = Date.now() - GEN_TTL_MS;
    const out: Record<string, GenEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const at = (v as { at?: number })?.at;
      if (typeof at === "number" && at >= cutoff) out[k] = { at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeGenMap(m: Record<string, GenEntry>) {
  try { localStorage.setItem(GEN_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

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
  const generating = !!gen[sceneId];

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
    const poll = async () => {
      try {
        const r = await getClient().query<GQL.FindSceneQuery>({
          query: GQL.FindSceneDocument,
          variables: { id: sceneId },
          fetchPolicy: "no-cache",
        });
        const has = (r.data.findScene?.captions?.length ?? 0) > 0;
        if (has) {
          const next = { ...gen };
          delete next[sceneId];
          setGen(next);
          writeGenMap(next);
          onCaptionsAppeared?.();
          // Also notify any Feed listener so the parent can refetch
          // this scene and surface the new <track>s.
          window.dispatchEvent(
            new CustomEvent("stashhub:scene-captions-appeared", {
              detail: { sceneId },
            })
          );
        }
      } catch {
        /* swallow */
      }
    };
    poll();
    pollRef.current = window.setInterval(poll, 10000);
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [generating, hasCaptions, sceneId, gen, onCaptionsAppeared]);

  // Refresh from localStorage when other tabs / windows / scenes update it.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== GEN_KEY) return;
      setGen(readGenMap());
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
      // Flip to the generating state NOW, before any network round-trip, so a
      // single press registers instantly (spinner) and further presses are
      // ignored. Without this the button looked dead until two awaited calls
      // finished, so users mashed it and queued a pile of duplicate generate
      // tasks that the serial job queue then chewed through one by one.
      const optimistic = { ...gen, [sceneId]: { at: Date.now() } };
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
        await getClient().mutate<GQL.RunPluginTaskMutation>({
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
        Toast.success("Generating captions in the background.");
      } catch (e) {
        rollback(); // undo the optimistic spinner so the user can retry
        Toast.error(e);
      }
    },
    [generating, hasCaptions, onToggle, sceneId, gen, Toast]
  );

  let icon: React.ReactNode;
  let title: string;
  let cls = "feed-action feed-cc-toggle";
  if (generating) {
    icon = <CcOnIcon />;
    title = "Generating captions...";
    cls += " is-generating";
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
