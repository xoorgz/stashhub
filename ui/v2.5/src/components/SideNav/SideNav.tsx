import React from "react";
import { NavLink, useLocation } from "react-router-dom";
import { baseURL } from "src/core/createClient";
import "./SideNav.scss";

const wrap = (path: React.ReactNode, size = 22): React.ReactElement => (
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

const Icons = {
  feed: wrap(<polygon points="5 3 19 12 5 21 5 3" />),
  dashboard: wrap(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  scenes: wrap(
    <>
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
    </>
  ),
  performers: wrap(
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  tags: wrap(
    <>
      <path d="M20.59 13.41 13.41 20.59a2 2 0 0 1-2.82 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </>
  ),
  studios: wrap(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />),
  images: wrap(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </>
  ),
  markers: wrap(
    <>
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  galleries: wrap(
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 11l6 6 4-4 8 8" />
    </>
  ),
  logout: wrap(
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>,
    18
  ),
  settings: wrap(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  stats: wrap(
    <>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </>
  ),
};

interface ItemDef {
  key: keyof typeof Icons;
  label: string;
  to: string;
  exact?: boolean;
  /** custom predicate for active state (when react-router-dom NavLink isn't enough) */
  isActive?: (path: string, hash: string) => boolean;
}

const items: ItemDef[] = [
  {
    key: "feed",
    label: "Feed",
    to: "/",
    exact: true,
    isActive: (p) => p === "/",
  },
  {
    key: "dashboard",
    label: "Dashboard",
    to: "/dashboard",
  },
  { key: "scenes", label: "Scenes", to: "/scenes" },
  { key: "performers", label: "Performers", to: "/performers" },
  { key: "tags", label: "Tags", to: "/tags" },
  { key: "studios", label: "Studios", to: "/studios" },
  { key: "galleries", label: "Galleries", to: "/galleries" },
  { key: "images", label: "Images", to: "/images" },
  { key: "markers", label: "Markers", to: "/scenes/markers" },
  { key: "stats", label: "Stats", to: "/stats" },
  { key: "settings", label: "Settings", to: "/settings" },
];

export const SideNav: React.FC = () => {
  const location = useLocation();

  return (
    <aside className="sidenav">
      <NavLink to="/" exact className="sidenav-logo" activeClassName="">
        <span className="sidenav-logo-text">
          stash<em>hub</em>
        </span>
      </NavLink>

      <nav className="sidenav-items">
        {items.map((it) => {
          const active = it.isActive
            ? it.isActive(location.pathname, location.hash)
            : location.pathname === it.to ||
              (it.to !== "/" && location.pathname.startsWith(it.to));
          return (
            <NavLink
              key={it.key}
              to={it.to}
              exact={it.exact}
              className={`sidenav-item${active ? " sidenav-active" : ""}`}
              title={it.label}
            >
              <span className="sidenav-icon">{Icons[it.key]}</span>
              <span className="sidenav-label">{it.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <a
        className="sidenav-logout"
        href={`${baseURL}logout`}
        title="Log out"
      >
        <span className="sidenav-icon">{Icons.logout}</span>
        <span className="sidenav-label">Log out</span>
      </a>
    </aside>
  );
};

export default SideNav;
