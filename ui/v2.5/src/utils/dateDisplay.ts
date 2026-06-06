/**
 * Date display utilities. Settings are persisted in localStorage under
 * "display.dateSettings" and edited from the Notifications panel. A custom
 * event "stashhub:date-settings-changed" is dispatched on change so consumers
 * re-render. useDateDisplay returns a label (relative or absolute, depending
 * on the toggle) and a tooltip with the absolute form.
 */

import { useEffect, useState } from "react";

export const DATE_SETTINGS_KEY = "display.dateSettings";
export const DATE_SETTINGS_EVENT = "stashhub:date-settings-changed";

export interface DateSettings {
  relative: boolean;
  // Date format string. Tokens: dd/mm/yyyy, yyyy-mm-dd, etc.
  // Supported tokens: yyyy, mm, dd, hh, MM (minutes). Anything else is preserved.
  dateFormat: string;
  // Format for date+time (e.g. tooltip on relative)
  dateTimeFormat: string;
}

export const DEFAULT_DATE_SETTINGS: DateSettings = {
  relative: true,
  dateFormat: "dd.mm.yyyy",
  dateTimeFormat: "dd.mm.yyyy hh:MM",
};

export function loadDateSettings(): DateSettings {
  try {
    const raw = localStorage.getItem(DATE_SETTINGS_KEY);
    if (!raw) return DEFAULT_DATE_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_DATE_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_DATE_SETTINGS;
  }
}

export function saveDateSettings(s: DateSettings) {
  try {
    localStorage.setItem(DATE_SETTINGS_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent(DATE_SETTINGS_EVENT));
  } catch {
    /* ignore */
  }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function formatAbsolute(iso: string | null | undefined, format?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const fmt = format ?? loadDateSettings().dateFormat;
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/mm/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/hh/g, pad(d.getHours()))
    .replace(/MM/g, pad(d.getMinutes()));
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 30) return `${day} days ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} month${mon === 1 ? "" : "s"} ago`;
  const yr = Math.round(day / 365);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

/** Render-time hook: returns label + tooltip and re-renders on settings change. */
export function useDateDisplay(iso: string | null | undefined): {
  label: string;
  tooltip: string;
} {
  const [settings, setSettings] = useState<DateSettings>(() => loadDateSettings());
  useEffect(() => {
    const onChange = () => setSettings(loadDateSettings());
    window.addEventListener(DATE_SETTINGS_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(DATE_SETTINGS_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  const tooltip = formatAbsolute(iso, settings.dateTimeFormat);
  const label = settings.relative
    ? formatRelative(iso)
    : formatAbsolute(iso, settings.dateFormat);
  return { label, tooltip };
}
