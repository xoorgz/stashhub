import React, { useCallback, useEffect, useRef, useState } from "react";
import { useHistory, useLocation } from "react-router-dom";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import { ListFilterModel } from "src/models/list-filter/filter";
import { PerformerIsMissingCriterionOption } from "src/models/list-filter/criteria/is-missing";
import { OrganizedCriterionOption } from "src/models/list-filter/criteria/organized";
import {
  Criterion,
  createMandatoryTimestampCriterionOption,
} from "src/models/list-filter/criteria/criterion";

// The concrete criteria carry value/modifier, the abstract base does not.
type MutableCriterion = Criterion & {
  value: unknown;
  modifier?: CriterionModifier;
};

const CreatedAtCriterionOption = createMandatoryTimestampCriterionOption("created_at");
import { FilterMode, CriterionModifier } from "src/core/generated-graphql";
import {
  loadNotificationSettings,
  NOTIFICATIONS_SETTINGS_EVENT,
  NotificationSettings,
} from "../Settings/SettingsNotificationsPanel";

const REFRESH_MS = 30_000;

interface Counts {
  unorganized: number;
  performersMissingImage: number;
  newVideos: number;
}

const ZERO: Counts = { unorganized: 0, performersMissingImage: 0, newVideos: 0 };

async function fetchCounts(s: NotificationSettings): Promise<Counts> {
  const client = getClient();
  try {
    const since = new Date(Date.now() - s.newVideosWindowHours * 3600_000)
      .toISOString();

    const tasks: Promise<unknown>[] = [];

    const sceneTask = s.unorganizedEnabled
      ? client.query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
          query: GQL.FindScenesDocument,
          variables: {
            filter: { per_page: 1, page: 1 },
            scene_filter: { organized: false },
          },
          fetchPolicy: "network-only",
        })
      : Promise.resolve(null);

    const performerTask = s.performersMissingImageEnabled
      ? client.query<GQL.FindPerformersQuery, GQL.FindPerformersQueryVariables>({
          query: GQL.FindPerformersDocument,
          variables: {
            filter: { per_page: 1, page: 1 },
            performer_filter: { is_missing: "image" },
          },
          fetchPolicy: "network-only",
        })
      : Promise.resolve(null);

    const newVideosTask = s.newVideosEnabled
      ? client.query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
          query: GQL.FindScenesDocument,
          variables: {
            filter: { per_page: 1, page: 1 },
            scene_filter: {
              created_at: {
                value: since,
                modifier: CriterionModifier.GreaterThan,
              },
            },
          },
          fetchPolicy: "network-only",
        })
      : Promise.resolve(null);

    tasks.push(sceneTask, performerTask, newVideosTask);
    const [scenesRes, performersRes, newRes] = await Promise.all(tasks);

    return {
      unorganized:
        (scenesRes as any)?.data?.findScenes?.count ?? 0,
      performersMissingImage:
        (performersRes as any)?.data?.findPerformers?.count ?? 0,
      newVideos:
        (newRes as any)?.data?.findScenes?.count ?? 0,
    };
  } catch (e) {
    console.warn("[notifications] fetch failed", e);
    return ZERO;
  }
}

function buildUnorganizedScenesUrl(): string {
  const f = new ListFilterModel(FilterMode.Scenes);
  const c = OrganizedCriterionOption.makeCriterion() as MutableCriterion;
  c.value = false;
  f.criteria = [c];
  const qp = f.makeQueryParameters();
  return qp ? `/scenes?${qp}` : "/scenes";
}

function buildPerformersMissingImageUrl(): string {
  const f = new ListFilterModel(FilterMode.Performers);
  const c = PerformerIsMissingCriterionOption.makeCriterion() as MutableCriterion;
  c.value = "image";
  f.criteria = [c];
  const qp = f.makeQueryParameters();
  return qp ? `/performers?${qp}` : "/performers";
}

function buildNewVideosUrl(windowHours: number): string {
  const f = new ListFilterModel(FilterMode.Scenes);
  const c = CreatedAtCriterionOption.makeCriterion() as MutableCriterion;
  const since = new Date(Date.now() - windowHours * 3600_000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD. Stash UI uses date-only for created_at criterion
  c.modifier = CriterionModifier.GreaterThan;
  c.value = { value: since, value2: undefined };
  f.criteria = [c];
  f.sortBy = "created_at";
  f.sortDirection = GQL.SortDirectionEnum.Desc;
  const qp = f.makeQueryParameters();
  return qp ? `/scenes?${qp}` : "/scenes";
}

const bellSvg = (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export const NotificationBell: React.FC = () => {
  const history = useHistory();
  const location = useLocation();
  const [settings, setSettings] = useState<NotificationSettings>(() => loadNotificationSettings());
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    fetchCounts(settings).then(setCounts);
  }, [settings]);

  // Initial + periodic
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Route change → refresh (catches delete-and-navigate flows)
  useEffect(() => {
    refresh();
  }, [location.pathname, refresh]);

  // Tab focus / visibility → refresh
  useEffect(() => {
    function onWake() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  // React to settings changes from the Settings page (same tab)
  useEffect(() => {
    function onSettingsChange() {
      setSettings(loadNotificationSettings());
    }
    window.addEventListener(NOTIFICATIONS_SETTINGS_EVENT, onSettingsChange);
    window.addEventListener("storage", onSettingsChange);
    return () => {
      window.removeEventListener(NOTIFICATIONS_SETTINGS_EVENT, onSettingsChange);
      window.removeEventListener("storage", onSettingsChange);
    };
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const total =
    (settings.newVideosEnabled ? counts.newVideos : 0) +
    (settings.unorganizedEnabled ? counts.unorganized : 0) +
    (settings.performersMissingImageEnabled ? counts.performersMissingImage : 0);

  const goNewVideos = useCallback(() => {
    setOpen(false);
    history.push(buildNewVideosUrl(settings.newVideosWindowHours));
  }, [history, settings.newVideosWindowHours]);

  const goUnorganized = useCallback(() => {
    setOpen(false);
    history.push(buildUnorganizedScenesUrl());
  }, [history]);

  const goPerformersMissingImage = useCallback(() => {
    setOpen(false);
    history.push(buildPerformersMissingImageUrl());
  }, [history]);

  return (
    <div className="topright-bell-wrap" ref={wrapRef}>
      <button
        type="button"
        className="topright-bell"
        onClick={() => {
          setOpen((o) => !o);
          refresh();
        }}
        title="Library notifications"
        aria-label="Library notifications"
      >
        {bellSvg}
        {total > 0 && (
          <span className="topright-bell-badge">{total > 99 ? "99+" : total}</span>
        )}
      </button>
      {open && (
        <div className="topright-bell-pop" role="menu">
          {settings.newVideosEnabled && (
            <button
              type="button"
              className="topright-bell-item"
              onClick={goNewVideos}
              disabled={counts.newVideos === 0}
            >
              <span className="topright-bell-item-label">
                New videos (last {settings.newVideosWindowHours}h)
              </span>
              <span className="topright-bell-item-count">{counts.newVideos}</span>
            </button>
          )}
          {settings.unorganizedEnabled && (
            <button
              type="button"
              className="topright-bell-item"
              onClick={goUnorganized}
              disabled={counts.unorganized === 0}
            >
              <span className="topright-bell-item-label">Unorganized scenes</span>
              <span className="topright-bell-item-count">{counts.unorganized}</span>
            </button>
          )}
          {settings.performersMissingImageEnabled && (
            <button
              type="button"
              className="topright-bell-item"
              onClick={goPerformersMissingImage}
              disabled={counts.performersMissingImage === 0}
            >
              <span className="topright-bell-item-label">Performers missing image</span>
              <span className="topright-bell-item-count">{counts.performersMissingImage}</span>
            </button>
          )}
          {total === 0 && <div className="topright-bell-empty">All clean ✓</div>}
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
