import React, { useCallback, useState } from "react";
import cx from "classnames";
import { Button, Spinner } from "react-bootstrap";
import { Icon } from "src/components/Shared/Icon";
import { faClosedCaptioning } from "@fortawesome/free-solid-svg-icons";
import { useToast } from "src/hooks/Toast";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";

interface Props {
  sceneId: string;
  hasCaptions: boolean;
  onCompleted?: () => void;
}

// Posts the AI Subtitler "Generate captions: this scene" task to Stash's
// plugin runner. The plugin shim sees scene_id in the args, dispatches to
// the worker, and writes a sidecar VTT, which a subsequent metadata scan
// surfaces on scene.captions. We don't watch the job ourselves because
// the user can see it in the Stash task panel; we just toast and call
// onCompleted (which refetches the scene) when the mutation returns.
export const GenerateCaptionsButton: React.FC<Props> = ({
  sceneId,
  hasCaptions,
  onCompleted,
}) => {
  const Toast = useToast();
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await getClient().mutate<GQL.RunPluginTaskMutation>({
        mutation: GQL.RunPluginTaskDocument,
        variables: {
          plugin_id: "ai-subtitler",
          task_name: "Generate captions: this scene",
          args_map: { scene_id: sceneId },
        },
      });
      Toast.success(
        hasCaptions
          ? "Re-generating captions; rescan when done."
          : "Caption generation queued; check Tasks for progress."
      );
      onCompleted?.();
    } catch (e) {
      Toast.error(e);
    } finally {
      setBusy(false);
    }
  }, [busy, sceneId, hasCaptions, onCompleted, Toast]);

  if (busy) return <Spinner animation="border" role="status" />;

  return (
    <Button
      variant="secondary"
      title={hasCaptions ? "Re-generate captions" : "Generate captions"}
      className={cx(
        "minimal",
        "captions-button",
        hasCaptions ? "has-captions" : "no-captions"
      )}
      onClick={onClick}
    >
      <Icon icon={faClosedCaptioning} />
    </Button>
  );
};

export default GenerateCaptionsButton;
