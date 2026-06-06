import { useEffect, useState } from "react";
import { getWSClient, useWSState } from "./core/StashService";
import { useToast } from "./hooks/Toast";
import { useIntl } from "react-intl";
import {
  loadNoticesSettings,
  NOTICES_SETTINGS_EVENT,
  NoticesSettings,
} from "./components/Settings/SettingsNoticesPanel";

export const ConnectionMonitor: React.FC = () => {
  const Toast = useToast();
  const intl = useIntl();

  const { state } = useWSState(getWSClient());
  const [cachedState, setCacheState] = useState<typeof state>(state);
  const [notices, setNotices] = useState<NoticesSettings>(() =>
    loadNoticesSettings()
  );

  // React to live changes from Settings → Notices
  useEffect(() => {
    const onChange = () => setNotices(loadNoticesSettings());
    window.addEventListener(NOTICES_SETTINGS_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(NOTICES_SETTINGS_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  useEffect(() => {
    // Always track the state transition so we can rearm; only fire the toast
    // if the user has opted into the websocket-status notice.
    if (notices.websocketStatus) {
      if (cachedState === "connecting" && state === "error") {
        Toast.error(
          intl.formatMessage({
            id: "connection_monitor.websocket_connection_failed",
          })
        );
      }

      if (state === "connected" && cachedState === "error") {
        Toast.success(
          intl.formatMessage({
            id: "connection_monitor.websocket_connection_reestablished",
          })
        );
      }
    }

    setCacheState(state);
  }, [state, cachedState, Toast, intl, notices.websocketStatus]);

  return null;
};
