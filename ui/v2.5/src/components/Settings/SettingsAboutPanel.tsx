import React from "react";
import { Card } from "react-bootstrap";
import { ExternalLink } from "../Shared/ExternalLink";

export const SettingsAboutPanel: React.FC = () => {
  const gitHash = import.meta.env.VITE_APP_GITHASH;
  const stashVersion = import.meta.env.VITE_APP_STASH_VERSION;
  const buildTime = import.meta.env.VITE_APP_DATE;

  return (
    <>
      <div className="setting-section">
        <h1>stashhub</h1>
        <Card>
          <div className="setting">
            <div>
              <h3>Built on Stash</h3>
              <div className="value">{stashVersion}</div>
            </div>
          </div>
          {gitHash && (
            <div className="setting">
              <div>
                <h3>Build hash</h3>
                <div className="value">{gitHash}</div>
              </div>
            </div>
          )}
          {buildTime && (
            <div className="setting">
              <div>
                <h3>Build time</h3>
                <div className="value">{buildTime}</div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="setting-section">
        <h1>About</h1>
        <Card>
          <div className="setting">
            <div>
              <p>
                stashhub is a fork of{" "}
                <ExternalLink href="https://github.com/stashapp/stash">
                  Stash
                </ExternalLink>{" "}
                that adds a vertical-feed view and several quality-of-life
                changes. Automatic update checks are disabled.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
};
