import React, { useCallback, useRef } from "react";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import { useToast } from "src/hooks/Toast";
import { ConnectionState } from "src/hooks/Interactive/context";
import { InteractiveIcon, InteractiveGenerateIcon } from "./icons";

interface Props {
  sceneId: string;
  hasFunscript: boolean;
  interactiveOn: boolean;
  connectionState: ConnectionState;
  onToggle: () => void;
  onCaptionsAppeared?: () => void;
}

/** Handy sync toggle / funscript generate button. Shows the sextoy icon for
 *  scenes with funscripts (toggles sync) and a "+" variant for scenes
 *  without (triggers generation). Same size circle, no layout jump. */
export const FeedInteractiveButton: React.FC<Props> = ({
  sceneId,
  hasFunscript,
  interactiveOn,
  connectionState,
  onToggle,
  onCaptionsAppeared,
}) => {
  const Toast = useToast();
  const generatingRef = useRef<Set<string>>(new Set());
  const generating = generatingRef.current.has(sceneId);

  const busy =
    generating ||
    connectionState === ConnectionState.Connecting ||
    connectionState === ConnectionState.Uploading ||
    connectionState === ConnectionState.Syncing;

  const triggerGenerate = useCallback(async () => {
    if (generatingRef.current.has(sceneId)) return;
    generatingRef.current.add(sceneId);
    try {
      await getClient().mutate<GQL.RunPluginTaskMutation>({
        mutation: GQL.RunPluginTaskDocument,
        variables: {
          plugin_id: "funscript-gen",
          task_name: "Generate funscript: this scene",
          args_map: { scene_id: sceneId, mode: "single" },
        },
      });
      Toast.success("Generating funscript in the background.");
      // Poll for the funscript to appear so the icon flips to the toggle state.
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const r = await getClient().query<GQL.FindSceneQuery>({
            query: GQL.FindSceneDocument,
            variables: { id: sceneId },
            fetchPolicy: "no-cache",
          });
          if (r.data.findScene?.interactive) {
            generatingRef.current.delete(sceneId);
            clearInterval(poll);
            onCaptionsAppeared?.();
            window.dispatchEvent(
              new CustomEvent("stashhub:scene-funscript-appeared", {
                detail: { sceneId },
              })
            );
          }
        } catch { /* ignore */ }
        if (attempts > 180) { // 30 min timeout
          generatingRef.current.delete(sceneId);
          clearInterval(poll);
        }
      }, 10000);
    } catch (e) {
      generatingRef.current.delete(sceneId);
      Toast.error(e);
    }
  }, [sceneId, Toast, onCaptionsAppeared]);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (busy) return;
      if (hasFunscript) {
        onToggle();
      } else {
        triggerGenerate();
      }
    },
    [busy, hasFunscript, onToggle, triggerGenerate]
  );

  let cls = "feed-action feed-interactive-toggle";
  let title: string;
  let icon: React.ReactNode;

  if (generating) {
    cls += " is-generating";
    title = "Generating funscript...";
    icon = <InteractiveGenerateIcon />;
  } else if (!hasFunscript) {
    cls += " no-funscript";
    title = "Generate funscript";
    icon = <InteractiveGenerateIcon />;
  } else if (busy) {
    cls += " is-busy";
    title = "Connecting...";
    icon = <InteractiveIcon />;
  } else if (interactiveOn) {
    cls += " is-synced";
    title = "Handy synced";
    icon = <InteractiveIcon />;
  } else {
    title = "Sync Handy";
    icon = <InteractiveIcon />;
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      aria-pressed={hasFunscript ? interactiveOn : undefined}
      aria-busy={busy}
      onClick={onClick}
      disabled={busy}
    >
      {icon}
    </button>
  );
};

export default FeedInteractiveButton;
