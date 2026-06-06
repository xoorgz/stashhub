import React, { useCallback, useEffect, useState } from "react";
import { Form } from "react-bootstrap";
import { SettingSection } from "./SettingSection";
import {
  DateSettings,
  DEFAULT_DATE_SETTINGS,
  loadDateSettings,
  saveDateSettings,
} from "../../utils/dateDisplay";

export const NOTIFICATIONS_SETTINGS_KEY = "notifications.settings";
export const NOTIFICATIONS_SETTINGS_EVENT = "stashhub:notifications-settings-changed";

export interface NotificationSettings {
  newVideosEnabled: boolean;
  newVideosWindowHours: number;
  unorganizedEnabled: boolean;
  performersMissingImageEnabled: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  newVideosEnabled: true,
  newVideosWindowHours: 24,
  unorganizedEnabled: true,
  performersMissingImageEnabled: true,
};

export function loadNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_SETTINGS_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

function saveNotificationSettings(s: NotificationSettings) {
  try {
    localStorage.setItem(NOTIFICATIONS_SETTINGS_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_SETTINGS_EVENT));
  } catch {
    /* ignore */
  }
}

export const SettingsNotificationsPanel: React.FC = () => {
  const [s, setS] = useState<NotificationSettings>(() => loadNotificationSettings());

  // Persist on any change
  useEffect(() => {
    saveNotificationSettings(s);
  }, [s]);

  const update = useCallback(<K extends keyof NotificationSettings>(k: K, v: NotificationSettings[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  }, []);

  return (
    <>
      <SettingSection heading="Notification bell">
        <div className="setting">
          <div>
            <h3>New videos</h3>
            <div className="value">
              Show a count of recently added scenes.
            </div>
          </div>
          <div>
            <Form.Switch
              id="notif-new-videos"
              checked={s.newVideosEnabled}
              onChange={(e) => update("newVideosEnabled", e.target.checked)}
              label=""
            />
          </div>
        </div>

        <div className="setting">
          <div>
            <h3>New videos window (hours)</h3>
            <div className="value">
              Hours window applied to <code>created_at</code>.
            </div>
          </div>
          <div>
            <Form.Control
              type="number"
              min={1}
              max={720}
              step={1}
              value={s.newVideosWindowHours}
              disabled={!s.newVideosEnabled}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 720) {
                  update("newVideosWindowHours", n);
                }
              }}
              style={{ width: 100 }}
            />
          </div>
        </div>

        <div className="setting">
          <div>
            <h3>Unorganized scenes</h3>
            <div className="value">
              Count scenes with <code>organized = false</code>.
            </div>
          </div>
          <div>
            <Form.Switch
              id="notif-unorganized"
              checked={s.unorganizedEnabled}
              onChange={(e) => update("unorganizedEnabled", e.target.checked)}
              label=""
            />
          </div>
        </div>

        <div className="setting">
          <div>
            <h3>Performers missing image</h3>
            <div className="value">
              Count performers where <code>is_missing = "image"</code>.
            </div>
          </div>
          <div>
            <Form.Switch
              id="notif-performers"
              checked={s.performersMissingImageEnabled}
              onChange={(e) => update("performersMissingImageEnabled", e.target.checked)}
              label=""
            />
          </div>
        </div>
      </SettingSection>

      <DateSettingsSection />
    </>
  );
};

const DateSettingsSection: React.FC = () => {
  const [d, setD] = useState<DateSettings>(() => loadDateSettings());
  useEffect(() => saveDateSettings(d), [d]);
  const set = <K extends keyof DateSettings>(k: K, v: DateSettings[K]) =>
    setD((p) => ({ ...p, [k]: v }));

  return (
    <SettingSection heading="Date display">
      <div className="setting">
        <div>
          <h3>Relative dates</h3>
          <div className="value">
            Render dates as "N days ago" with the absolute date in the title
            attribute. Disable to always show the absolute date.
          </div>
        </div>
        <div>
          <Form.Switch
            id="date-relative"
            checked={d.relative}
            onChange={(e) => set("relative", e.target.checked)}
            label=""
          />
        </div>
      </div>

      <div className="setting">
        <div>
          <h3>Date format</h3>
          <div className="value">
            Tokens: <code>yyyy</code>, <code>mm</code>, <code>dd</code>.
            Example: <code>dd.mm.yyyy</code> renders 31.12.2026.
          </div>
        </div>
        <div>
          <Form.Control
            type="text"
            value={d.dateFormat}
            onChange={(e) => set("dateFormat", e.target.value || DEFAULT_DATE_SETTINGS.dateFormat)}
            style={{ width: 180 }}
          />
        </div>
      </div>

      <div className="setting">
        <div>
          <h3>Date + time format</h3>
          <div className="value">
            Used in tooltips. Adds <code>hh</code> and <code>MM</code> tokens.
          </div>
        </div>
        <div>
          <Form.Control
            type="text"
            value={d.dateTimeFormat}
            onChange={(e) => set("dateTimeFormat", e.target.value || DEFAULT_DATE_SETTINGS.dateTimeFormat)}
            style={{ width: 220 }}
          />
        </div>
      </div>
    </SettingSection>
  );
};

export default SettingsNotificationsPanel;
