import React, { useCallback } from "react";
import { useHistory } from "react-router-dom";
import { NotificationBell } from "./NotificationBell";
import { EmbedClose } from "../Embed/EmbedBar";
import "./TopRightBar.scss";

const scenesSvg = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
  </svg>
);

const feedSvg = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

export const TopRightBar: React.FC = () => {
  const history = useHistory();

  const onScenes = useCallback(() => {
    history.push("/scenes");
  }, [history]);

  const onFeed = useCallback(() => {
    history.push("/");
  }, [history]);

  return (
    <div className="topright-bar">
      <NotificationBell />

      <span className="topright-divider" />

      <button
        type="button"
        className="topright-action"
        title="Scenes"
        onClick={onScenes}
        aria-label="Scenes"
      >
        {scenesSvg}
        <span className="topright-label">Scenes</span>
      </button>

      <span className="topright-divider" />

      <button
        type="button"
        className="topright-pill"
        title="Feed"
        onClick={onFeed}
      >
        {feedSvg}
        <span>Feed</span>
      </button>
      <EmbedClose />
    </div>
  );
};

export default TopRightBar;
