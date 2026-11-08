import React, { useContext, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ConfigurationContext } from "src/hooks/Config";
import { MuteOffIcon, MuteOnIcon, NewIcon } from "../Feed/icons";
import { ACTIVE_EVENT, NEW_KEY, readFlag, writeFlag } from "../TopRightBar/FeedChipIsland";
import "./EmbedBar.scss";

/** True when another app shows stashhub in a frame. */
export const EMBEDDED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();
// Before the first render, so the feed measures its tiles at the framed height.
if (EMBEDDED) document.documentElement.classList.add("is-embedded");

/** Asks the feed to act on the video on screen. Dispatched inside the click,
 *  so picture-in-picture and unmuting keep the tap's user activation. */
export const FEED_COMMAND_EVENT = "stashhub:feed-command";
export const FEED_MUTED_EVENT = "stashhub:feed-muted";
export type FeedCommand = "back10" | "fwd10" | "mute" | "pip";

const command = (cmd: FeedCommand) =>
  document.dispatchEvent(new CustomEvent(FEED_COMMAND_EVENT, { detail: { cmd } }));

const icon = (path: React.ReactNode) => (
  <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const skipIcon = (dir: "back" | "fwd") =>
  icon(
    <>
      <path d={dir === "back" ? "M3 12a9 9 0 1 0 3-6.7L3 8" : "M21 12a9 9 0 1 1-3-6.7L21 8"} />
      <path d={dir === "back" ? "M3 3v5h5" : "M21 3v5h-5"} />
      <text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="700"
        fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">10</text>
    </>
  );

/** The close for the app around stashhub, under the Feed pill. */
export const EmbedClose: React.FC = () =>
  EMBEDDED ? (
    <button type="button" className="embed-close" aria-label="Close" title="Close"
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => window.parent.postMessage({ stashhub: "close" }, "*")}>
      <span><svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
        strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg></span>
    </button>
  ) : null;

/** The feed's controls when framed, where nothing of the page may sit near the phone's home indicator. */
export const EmbedBar: React.FC = () => {
  const { pathname } = useLocation();
  const onFeed = pathname === "/" || pathname.startsWith("/feed/");
  const { configuration } = useContext(ConfigurationContext);
  const showNew = configuration?.ui?.showFeedNewFilter ?? false;
  const [newOn, setNewOn] = useState(() => readFlag(NEW_KEY));
  const [muted, setMuted] = useState(() => sessionStorage.getItem("feed.muted") !== "0");

  useEffect(() => {
    const syncNew = () => setNewOn(readFlag(NEW_KEY));
    const syncMuted = (e: Event) => setMuted((e as CustomEvent<boolean>).detail);
    window.addEventListener(ACTIVE_EVENT, syncNew);
    window.addEventListener(FEED_MUTED_EVENT, syncMuted);
    return () => {
      window.removeEventListener(ACTIVE_EVENT, syncNew);
      window.removeEventListener(FEED_MUTED_EVENT, syncMuted);
    };
  }, []);

  const btn = (label: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, child: React.ReactNode, active = false, extra = "") => (
    <button type="button" className={`embed-bar-btn${active ? " is-active" : ""}${extra}`}
      aria-label={label} title={label} aria-pressed={active || undefined} onClick={onClick}>
      {child}
    </button>
  );

  if (!onFeed) return null;
  return (
    <nav className="embed-bar" onContextMenu={(e) => e.preventDefault()}>
      <div className="embed-bar-pill">
        {btn("Back 10 seconds", () => command("back10"), skipIcon("back"))}
        {btn("Forward 10 seconds", () => command("fwd10"), skipIcon("fwd"))}
        {btn(muted ? "Unmute" : "Mute", () => command("mute"), muted ? <MuteOffIcon /> : <MuteOnIcon />)}
        {btn("Picture in picture", () => command("pip"),
          icon(<><rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" /></>))}
        {showNew && btn("New videos only", () => writeFlag(NEW_KEY, !readFlag(NEW_KEY)), <NewIcon />, newOn)}
      </div>
    </nav>
  );
};
