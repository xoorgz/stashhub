import React, { useCallback, useEffect, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import { SettingSection } from "./SettingSection";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import {
  buttplug,
  useButtplug,
  loadInteractiveConfig,
  saveInteractiveConfig,
  InteractiveConfig,
  DEFAULT_INTERACTIVE_CONFIG,
} from "src/hooks/Interactive/buttplug";
import "./SettingsAlgorithmPanel.scss";

// Interactive-toys config lives beside the chips in the server UI blob, keyed
// under ui.stashhub.interactive, and is mirrored to localStorage so the feed
// and buttplug manager can read it synchronously.
const INTERACTIVE_UI_KEY = "stashhub.interactive";
const INTERACTIVE_UI_PATH = ["stashhub", "interactive"] as const;

function sanitizeInteractive(input: unknown): InteractiveConfig | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  return {
    intifaceEnabled:
      typeof r.intifaceEnabled === "boolean"
        ? r.intifaceEnabled
        : DEFAULT_INTERACTIVE_CONFIG.intifaceEnabled,
    intifaceUrl:
      typeof r.intifaceUrl === "string" && r.intifaceUrl
        ? r.intifaceUrl
        : DEFAULT_INTERACTIVE_CONFIG.intifaceUrl,
    maxIntensity:
      typeof r.maxIntensity === "number" && r.maxIntensity >= 0.1 && r.maxIntensity <= 1
        ? r.maxIntensity
        : DEFAULT_INTERACTIVE_CONFIG.maxIntensity,
  };
}

async function loadInteractiveFromServer(): Promise<InteractiveConfig | null> {
  try {
    const r = await getClient().query<GQL.ConfigurationQuery>({
      query: GQL.ConfigurationDocument,
      fetchPolicy: "cache-first",
    });
    let node: unknown = r.data?.configuration?.ui ?? {};
    for (const part of INTERACTIVE_UI_PATH) {
      if (!node || typeof node !== "object") return null;
      node = (node as Record<string, unknown>)[part];
    }
    return sanitizeInteractive(node);
  } catch {
    return null;
  }
}

async function saveInteractiveToServer(c: InteractiveConfig): Promise<void> {
  try {
    await getClient().mutate<GQL.ConfigureUiSettingMutation>({
      mutation: GQL.ConfigureUiSettingDocument,
      variables: { key: INTERACTIVE_UI_KEY, value: c },
      update: (cache, result) => {
        const next = result.data?.configureUISetting;
        if (!next) return;
        try {
          cache.writeQuery({
            query: GQL.ConfigurationDocument,
            data: {
              configuration: {
                ...(cache.readQuery<GQL.ConfigurationQuery>({
                  query: GQL.ConfigurationDocument,
                })?.configuration ?? {}),
                ui: next,
              },
            },
          });
        } catch {
          /* ignore cache write failures */
        }
      },
    });
  } catch {
    /* leave the local copy in place, server is just out of sync */
  }
}

export const SettingsInteractivePanel: React.FC = () => {
  const [cfg, setCfg] = useState<InteractiveConfig>(() =>
    loadInteractiveConfig()
  );
  const hydrated = useRef(false);
  const { status, deviceName } = useButtplug();

  // Pull the DB copy on mount, mirror into local state + localStorage.
  useEffect(() => {
    let cancelled = false;
    loadInteractiveFromServer().then((server) => {
      if (!cancelled && server) {
        setCfg(server);
        saveInteractiveConfig(server);
      }
      hydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<InteractiveConfig>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch };
      saveInteractiveConfig(next);
      if (hydrated.current) saveInteractiveToServer(next);
      return next;
    });
  }, []);

  const statusLabel: Record<string, string> = {
    disconnected: "Not connected",
    connecting: "Connecting...",
    scanning: "Scanning for a device...",
    ready: deviceName ? `Connected: ${deviceName}` : "Connected",
    error: `Could not connect. Check Intiface Central is running and its server
      is started, and that the browser allows the local connection (see above).`,
  };

  return (
    <div className="settings-interactive-panel">
    <SettingSection heading="Interactive toys">
      <div className="setting">
        <div>
          <p>
            Sync the feed and the scene player to a stroker or other toy. Works with any device
            Intiface Central supports, including the Handy, Kiiroo Keon and
            Powerblow, and Lovense. Install Intiface Central, connect the device
            to it, then enable Intiface below. Only scenes that already have a
            funscript can drive a toy. No toy yet? Add a simulated device in
            Intiface Central and watch its values move along with the video.
          </p>
          <p>
            This site is served over HTTPS, so the browser has to be told to
            allow the local Intiface connection:
          </p>
          <ul>
            <li>
              Chrome and Edge: keep the 127.0.0.1 address, localhost is blocked
              but 127.0.0.1 is allowed. If it still fails, open the padlock, go
              to Site settings, and set Insecure content to Allow.
            </li>
            <li>
              Firefox: set network.websocket.allowInsecureFromHTTPS to true in
              about:config.
            </li>
            <li>Safari: blocked with no override. Use Chrome or Firefox.</li>
          </ul>
        </div>
      </div>

      <div className="setting">
        <div>
          <h3>Enable Intiface</h3>
          <div className="value">
            Turn on the Intiface transport. The feed (with its interactive
            toggle on) and any scene with a funscript connect automatically.
          </div>
        </div>
        <div>
          <Form.Switch
            id="interactive-intiface-on"
            checked={cfg.intifaceEnabled}
            onChange={(e) => update({ intifaceEnabled: e.target.checked })}
            label=""
          />
        </div>
      </div>

      <div className="setting">
        <div>
          <h3>Intiface WebSocket URL</h3>
          <div className="value">
            Address of the Intiface Central server. Default is the local app.
          </div>
        </div>
        <div>
          <Form.Control
            type="text"
            value={cfg.intifaceUrl}
            spellCheck={false}
            onChange={(e) => update({ intifaceUrl: e.target.value })}
            style={{ width: 220 }}
          />
        </div>
      </div>

      <div className="setting">
        <div>
          <h3>Maximum strength</h3>
          <div className="value">
            Ceiling for vibrating and oscillating toys, now{" "}
            {Math.round(cfg.maxIntensity * 100)}%. Lower it for a gentler,
            longer session. Strokers follow the script as written.
          </div>
        </div>
        <div>
          <input
            type="range"
            className="custom-range"
            min={10}
            max={100}
            step={5}
            value={Math.round(cfg.maxIntensity * 100)}
            onChange={(e) =>
              update({ maxIntensity: Number(e.target.value) / 100 })
            }
            style={{ width: 220 }}
          />
        </div>
      </div>

      <div className="setting">
        <div>
          <h3>Connection</h3>
          <div className="value">{statusLabel[status] ?? status}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={status === "connecting" || status === "scanning"}
            onClick={() => buttplug.connect(cfg.intifaceUrl)}
          >
            {status === "ready" ? "Reconnect" : "Connect"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={status === "disconnected"}
            onClick={() => buttplug.disconnect()}
          >
            Disconnect
          </button>
        </div>
      </div>
    </SettingSection>
    </div>
  );
};