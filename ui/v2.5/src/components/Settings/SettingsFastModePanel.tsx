import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { SettingSection } from "./SettingSection";
import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import {
  loadFastModeConfig,
  saveFastModeConfig,
  FastModeConfig,
  FAST_MODE_UI_KEY,
  fastModeFromConfigUi,
} from "src/hooks/FastMode/fastMode";
import { purgeVideoCache } from "src/hooks/FastMode/videoCache";
import "./SettingsAlgorithmPanel.scss";

// Same DB-mirror pattern as Interactive toys: config lives in the server UI
// blob under ui.stashhub.fastMode, mirrored to localStorage so the feed can
// read it synchronously.

async function loadFastModeFromServer(): Promise<FastModeConfig | null> {
  try {
    const r = await getClient().query<GQL.ConfigurationQuery>({
      query: GQL.ConfigurationDocument,
      fetchPolicy: "cache-first",
    });
    return fastModeFromConfigUi(r.data?.configuration?.ui ?? {});
  } catch {
    return null;
  }
}

async function saveFastModeToServer(c: FastModeConfig): Promise<void> {
  try {
    await getClient().mutate<GQL.ConfigureUiSettingMutation>({
      mutation: GQL.ConfigureUiSettingDocument,
      variables: { key: FAST_MODE_UI_KEY, value: c },
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

export const SettingsFastModePanel: React.FC = () => {
  const [cfg, setCfg] = useState<FastModeConfig>(() => loadFastModeConfig());
  const [purging, setPurging] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadFastModeFromServer().then((server) => {
      if (!cancelled && server) {
        setCfg(server);
        saveFastModeConfig(server);
      }
      hydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<FastModeConfig>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch };
      saveFastModeConfig(next);
      if (hydrated.current) saveFastModeToServer(next);
      return next;
    });
  }, []);

  return (
    <div className="settings-interactive-panel">
      <SettingSection heading="Fast mode">
        <div className="setting">
          <div>
            <p>
              Streams a smaller, pre-generated copy of each scene instead of
              the original file, so videos in the feed start immediately and
              never buffer, even on a slow connection or a scene this server
              would otherwise have to transcode live. Quality is reduced
              (720p, capped bitrate) but stays close at normal viewing size.
            </p>
            <p>
              A scene that has not been pre-generated yet plays its normal
              stream, so turning this on is never a dead end while the
              background job catches up on the rest of the library.
            </p>
          </div>
        </div>

        <div className="setting">
          <div>
            <h3>Enable fast mode</h3>
            <div className="value">
              Off by default. Applies to the feed; the full scene player is
              unaffected.
            </div>
          </div>
          <div>
            <Form.Switch
              id="fast-mode-on"
              checked={cfg.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              label=""
            />
          </div>
        </div>

        <div className="setting">
          <div>
            <h3>Clear cached videos</h3>
            <div className="value">
              The feed keeps the scene you are watching and the next one on the
              device so seeking inside them needs no network. It holds a handful
              at most and drops the oldest by itself. Clearing also switches the
              cache off until the page is reloaded.
            </div>
          </div>
          <div>
            <Button
              variant="secondary"
              onClick={async () => {
                setPurging(true);
                await purgeVideoCache();
                setPurging(false);
              }}
              disabled={purging}
            >
              {purging ? "Clearing..." : "Clear"}
            </Button>
          </div>
        </div>
      </SettingSection>
    </div>
  );
};
