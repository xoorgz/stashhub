import React from "react";

const wrap = (path: React.ReactNode, size = 20): React.ReactElement => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {path}
  </svg>
);

export const ChevronIcon: React.FC<{ dir?: "up" | "down" }> = ({ dir }) =>
  wrap(
    <polyline
      points="6 9 12 15 18 9"
      style={{ transform: dir === "up" ? "rotate(180deg)" : undefined, transformOrigin: "center" }}
    />,
    20
  );

export const HeartIcon: React.FC<{ filled?: boolean }> = ({ filled }) => (
  <svg
    width={22}
    height={22}
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);

export const DropIcon: React.FC = () => (
  <svg
    width={22}
    height={22}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth={1.2}
    strokeLinejoin="round"
  >
    <path d="M12 2.5s-7 8.2-7 13.1A7 7 0 0 0 12 22a7 7 0 0 0 7-6.4C19 10.7 12 2.5 12 2.5z" />
  </svg>
);

export const EyeIcon: React.FC = () =>
  wrap(
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  );

export const FullscreenIcon: React.FC = () =>
  wrap(
    <>
      <polyline points="4 9 4 4 9 4" />
      <polyline points="20 9 20 4 15 4" />
      <polyline points="4 15 4 20 9 20" />
      <polyline points="20 15 20 20 15 20" />
    </>,
    18
  );

export const SkipIcon: React.FC = () =>
  wrap(
    <>
      <polygon points="5 4 15 12 5 20 5 4" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </>,
    18
  );

export const MuteOffIcon: React.FC = () =>
  wrap(
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </>,
    18
  );

export const MuteOnIcon: React.FC = () =>
  wrap(
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </>,
    18
  );

export const CcOnIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden="true">
    <path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 5.5c-1.7 0-2.8 1.3-2.8 3s1.1 3 2.8 3c1 0 1.8-.5 2.2-1.3l-1.3-.6c-.2.4-.5.6-.9.6-.7 0-1.1-.6-1.1-1.7s.4-1.7 1.1-1.7c.4 0 .7.2.9.6l1.3-.6c-.4-.8-1.2-1.3-2.2-1.3Zm7 0c-1.7 0-2.8 1.3-2.8 3s1.1 3 2.8 3c1 0 1.8-.5 2.2-1.3l-1.3-.6c-.2.4-.5.6-.9.6-.7 0-1.1-.6-1.1-1.7s.4-1.7 1.1-1.7c.4 0 .7.2.9.6l1.3-.6c-.4-.8-1.2-1.3-2.2-1.3Z" />
  </svg>
);

export const CcOffIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="1" />
    <line x1="4" y1="20" x2="20" y2="4" />
  </svg>
);

// "Generate captions" prompt: the same filled CC pill as CcOnIcon
// (so it reads as a closed-caption mark at a glance), with a clear
// "+" badge in the top-right corner to signal that activation will
// create something rather than just toggle visibility.
export const CcGenerateIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" fill="currentColor">
    <path d="M3 7h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Zm4 4.5c-1.45 0-2.45 1.1-2.45 2.5s1 2.5 2.45 2.5c.85 0 1.55-.4 1.9-1.1l-1.1-.5c-.15.3-.4.5-.8.5-.6 0-.95-.5-.95-1.4s.35-1.4.95-1.4c.4 0 .65.2.8.5l1.1-.5c-.35-.7-1.05-1.1-1.9-1.1Zm6 0c-1.45 0-2.45 1.1-2.45 2.5s1 2.5 2.45 2.5c.85 0 1.55-.4 1.9-1.1l-1.1-.5c-.15.3-.4.5-.8.5-.6 0-.95-.5-.95-1.4s.35-1.4.95-1.4c.4 0 .65.2.8.5l1.1-.5c-.35-.7-1.05-1.1-1.9-1.1Z" />
    <circle cx="20" cy="5" r="4" />
    <path d="M20 3v4M18 5h4" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** Handy / interactive toy sync. Sextoy icon for the feed action bar. */
export const InteractiveIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width={18} height={18} fill="currentColor" aria-hidden="true">
    <path d="M35.35,55.39l-8,10c-.73.9-.8,2.26-.2,3.84a11.65,11.65,0,0,0,3.63,4.73c3.4,2.74,7.57,3.45,9.11,1.55l8.05-10A31.71,31.71,0,0,1,35.35,55.39Z"/>
    <path d="M52.35,87.69l.63-.78,0,0C52.75,87.16,52.56,87.43,52.35,87.69Z"/>
    <path d="M42.1,92c-5.85,0-12.45-2.62-18.12-7.2a31.51,31.51,0,0,1-10.24-14C12,65.65,12.49,61,15.16,57.66c.21-.26.44-.5.68-.74l-.05,0-.63.78L13.23,60C7.84,66.72,11.8,78.9,22.05,87.17c5.67,4.58,12.27,7.2,18.12,7.2,4.37,0,8-1.53,10.26-4.3l1.92-2.38C50.11,90.47,46.47,92,42.1,92Z"/>
    <path d="M24.6,84c5.68,4.59,12.11,7,17.5,7,3.95,0,7.34-1.28,9.48-3.93C55.34,82.4,54.13,74.81,49.2,68l-6.57,8.14a4.35,4.35,0,0,1-3.52,1.47,11.73,11.73,0,0,1-7-2.87,12.67,12.67,0,0,1-3.94-5.16c-.73-1.93-.6-3.64.36-4.83l6.57-8.14a24.69,24.69,0,0,0-9.71-2.22c-3.94,0-7.33,1.28-9.47,3.93C10.88,64.55,14.76,76.07,24.6,84Z"/>
    <path d="M82.37,6.62a5.75,5.75,0,0,0-3.24,1l-40.07,27A11.26,11.26,0,0,0,34.12,46c.92,4.92,4.25,10.31,9.48,14.53,5,4,10.62,6.13,15.47,6.21h.18a11.43,11.43,0,0,0,10.56-7.23l18-44.85A5.83,5.83,0,0,0,82.37,6.62ZM66,62.09H66A39.51,39.51,0,0,1,49,54.36c-6.7-5.41-10.51-12.43-11.44-15.83a.5.5,0,0,1,1-.26c.9,3.28,4.59,10.06,11.11,15.32A38.44,38.44,0,0,0,66.14,61.1a.5.5,0,0,1-.09,1ZM85,17.62a4.38,4.38,0,0,1-1.15.15,7.05,7.05,0,0,1-4.29-1.67c-1.89-1.52-2.9-3.66-2.58-5.45a.5.5,0,0,1,1,.18c-.25,1.41.64,3.21,2.22,4.49a5.47,5.47,0,0,0,4.55,1.33.5.5,0,0,1,.26,1Z"/>
  </svg>
);

/** Same sextoy icon with a small "+" badge in the top-right corner —
    signals that clicking will generate a funscript rather than toggle sync. */
export const InteractiveGenerateIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width={18} height={18} aria-hidden="true">
    <path fill="currentColor" d="M35.35,55.39l-8,10c-.73.9-.8,2.26-.2,3.84a11.65,11.65,0,0,0,3.63,4.73c3.4,2.74,7.57,3.45,9.11,1.55l8.05-10A31.71,31.71,0,0,1,35.35,55.39Z"/>
    <path fill="currentColor" d="M52.35,87.69l.63-.78,0,0C52.75,87.16,52.56,87.43,52.35,87.69Z"/>
    <path fill="currentColor" d="M42.1,92c-5.85,0-12.45-2.62-18.12-7.2a31.51,31.51,0,0,1-10.24-14C12,65.65,12.49,61,15.16,57.66c.21-.26.44-.5.68-.74l-.05,0-.63.78L13.23,60C7.84,66.72,11.8,78.9,22.05,87.17c5.67,4.58,12.27,7.2,18.12,7.2,4.37,0,8-1.53,10.26-4.3l1.92-2.38C50.11,90.47,46.47,92,42.1,92Z"/>
    <path fill="currentColor" d="M24.6,84c5.68,4.59,12.11,7,17.5,7,3.95,0,7.34-1.28,9.48-3.93C55.34,82.4,54.13,74.81,49.2,68l-6.57,8.14a4.35,4.35,0,0,1-3.52,1.47,11.73,11.73,0,0,1-7-2.87,12.67,12.67,0,0,1-3.94-5.16c-.73-1.93-.6-3.64.36-4.83l6.57-8.14a24.69,24.69,0,0,0-9.71-2.22c-3.94,0-7.33,1.28-9.47,3.93C10.88,64.55,14.76,76.07,24.6,84Z"/>
    <path fill="currentColor" d="M82.37,6.62a5.75,5.75,0,0,0-3.24,1l-40.07,27A11.26,11.26,0,0,0,34.12,46c.92,4.92,4.25,10.31,9.48,14.53,5,4,10.62,6.13,15.47,6.21h.18a11.43,11.43,0,0,0,10.56-7.23l18-44.85A5.83,5.83,0,0,0,82.37,6.62ZM66,62.09H66A39.51,39.51,0,0,1,49,54.36c-6.7-5.41-10.51-12.43-11.44-15.83a.5.5,0,0,1,1-.26c.9,3.28,4.59,10.06,11.11,15.32A38.44,38.44,0,0,0,66.14,61.1a.5.5,0,0,1-.09,1ZM85,17.62a4.38,4.38,0,0,1-1.15.15,7.05,7.05,0,0,1-4.29-1.67c-1.89-1.52-2.9-3.66-2.58-5.45a.5.5,0,0,1,1,.18c-.25,1.41.64,3.21,2.22,4.49a5.47,5.47,0,0,0,4.55,1.33.5.5,0,0,1,.26,1Z"/>
    <circle cx="78" cy="18" r="16" fill="currentColor"/>
    <path d="M78 12v12M72 18h12" stroke="#000" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>
);

/** Lightning bolt: fast-mode indicator. Filled when this tile is playing the
    small/fast-start copy, outline when the user has bumped it to full
    quality for this scene. */
export const FastModeIcon: React.FC<{ filled?: boolean }> = ({ filled }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={filled ? 0 : 1.8}
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
  </svg>
);

/** TikTok-style forward arrow (open scene) */
export const OpenSceneIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
    <path
      fillRule="evenodd"
      d="M10.938 3.175a.674.674 0 0 1 1.138-.488l6.526 6.215c.574.547.554 1.47-.043 1.991l-6.505 5.676a.674.674 0 0 1-1.116-.508V13.49s-6.985-1.258-9.225 2.854c-.209.384-1.023.518-.857-1.395.692-3.52 2.106-9.017 10.082-9.017z"
      clipRule="evenodd"
    />
  </svg>
);
