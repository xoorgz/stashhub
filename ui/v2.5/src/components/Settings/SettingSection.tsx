import React, { PropsWithChildren } from "react";
import { Card } from "react-bootstrap";
import { useIntl } from "react-intl";
import { useSettings } from "./context";

interface ISettingGroup {
  id?: string;
  headingID?: string;
  // Literal heading, for stashhub panels that are not in the i18n catalogue.
  heading?: string;
  subHeadingID?: string;
  subHeading?: string;
  advanced?: boolean;
}

export const SettingSection: React.FC<PropsWithChildren<ISettingGroup>> = ({
  id,
  children,
  headingID,
  heading,
  subHeadingID,
  subHeading,
  advanced,
}) => {
  const intl = useIntl();
  const { advancedMode } = useSettings();

  if (advanced && !advancedMode) return null;

  return (
    <div className="setting-section" id={id}>
      <h1>
        {headingID ? intl.formatMessage({ id: headingID }) : heading ?? null}
      </h1>
      {subHeadingID || subHeading ? (
        <div className="sub-heading">
          {subHeadingID
            ? intl.formatMessage({ id: subHeadingID })
            : subHeading ?? null}
        </div>
      ) : undefined}
      <Card>{children}</Card>
    </div>
  );
};
