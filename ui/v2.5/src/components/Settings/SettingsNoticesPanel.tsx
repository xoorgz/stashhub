import React, { useCallback, useEffect, useState } from "react";
import { Form } from "react-bootstrap";
import { SettingSection } from "./SettingSection";

export const NOTICES_SETTINGS_KEY = "notices.settings";
export const NOTICES_SETTINGS_EVENT = "stashhub:notices-settings-changed";

export interface NoticesSettings {
  /** Show "Unable to make websocket connection" + "reestablished" toasts. */
  websocketStatus: boolean;
}

export const DEFAULT_NOTICES_SETTINGS: NoticesSettings = {
  websocketStatus: false,
};

export function loadNoticesSettings(): NoticesSettings {
  try {
    const raw = localStorage.getItem(NOTICES_SETTINGS_KEY);
    if (!raw) return DEFAULT_NOTICES_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_NOTICES_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_NOTICES_SETTINGS;
  }
}

function save(s: NoticesSettings) {
  try {
    localStorage.setItem(NOTICES_SETTINGS_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent(NOTICES_SETTINGS_EVENT));
  } catch {
    /* ignore */
  }
}

export const SettingsNoticesPanel: React.FC = () => {
  const [s, setS] = useState<NoticesSettings>(() => loadNoticesSettings());

  useEffect(() => {
    save(s);
  }, [s]);

  const update = useCallback(
    <K extends keyof NoticesSettings>(k: K, v: NoticesSettings[K]) => {
      setS((prev) => ({ ...prev, [k]: v }));
    },
    []
  );

  return (
    <SettingSection heading="Notices">
      <div className="setting">
        <div>
          <h3>Websocket status toasts</h3>
          <div className="value">
            Show "Unable to make websocket connection" and
            "reestablished" toasts on websocket reconnect events.
          </div>
        </div>
        <div>
          <Form.Switch
            id="notices-websocket"
            checked={s.websocketStatus}
            onChange={(e) => update("websocketStatus", e.target.checked)}
            label=""
          />
        </div>
      </div>
    </SettingSection>
  );
};

export default SettingsNoticesPanel;
