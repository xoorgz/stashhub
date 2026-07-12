import React, { useCallback } from "react";
import { ConnectionState } from "src/hooks/Interactive/context";
import { ButtplugStatus } from "src/hooks/Interactive/buttplug";
import { InteractiveIcon } from "./icons";

interface Props {
  sceneId: string;
  hasFunscript: boolean;
  interactiveOn: boolean;
  connectionState: ConnectionState;
  buttplugStatus?: ButtplugStatus;
  deviceName?: string | null;
  onToggle: () => void;
}

/** Toy sync toggle. Dimmed and inert on scenes without a funscript; active
 *  (synced) by default on scenes that have one. Funscripts are produced
 *  externally by FunGen, so there is no in-feed generation. */
export const FeedInteractiveButton: React.FC<Props> = ({
  hasFunscript,
  interactiveOn,
  connectionState,
  buttplugStatus,
  deviceName,
  onToggle,
}) => {
  const busy =
    connectionState === ConnectionState.Connecting ||
    connectionState === ConnectionState.Uploading ||
    connectionState === ConnectionState.Syncing ||
    buttplugStatus === "connecting" ||
    buttplugStatus === "scanning";

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!hasFunscript || busy) return;
      onToggle();
    },
    [hasFunscript, busy, onToggle]
  );

  let cls = "feed-action feed-interactive-toggle";
  let title: string;

  if (!hasFunscript) {
    cls += " no-funscript";
    title = "No funscript for this scene";
  } else if (busy) {
    cls += " is-busy";
    title = "Connecting device...";
  } else if (interactiveOn) {
    cls += " is-synced";
    title =
      buttplugStatus === "ready" && deviceName
        ? `${deviceName} synced`
        : "Toy synced";
  } else {
    title = "Sync toy";
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
      disabled={!hasFunscript || busy}
      tabIndex={hasFunscript ? undefined : -1}
    >
      <InteractiveIcon />
    </button>
  );
};

export default FeedInteractiveButton;
