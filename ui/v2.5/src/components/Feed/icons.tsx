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
