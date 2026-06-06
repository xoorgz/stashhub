import { faEye, faHeart } from "@fortawesome/free-solid-svg-icons";
import React from "react";
import { Button, ButtonGroup } from "react-bootstrap";
import { Icon } from "src/components/Shared/Icon";
import { SweatDrops } from "./SweatDrops";
import cx from "classnames";
import { useIntl } from "react-intl";

interface ICountButtonProps {
  value: number;
  icon: React.ReactNode;
  onIncrement?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  onValueClicked?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  countTitle?: string;
}

export const CountButton: React.FC<ICountButtonProps> = ({
  value,
  icon,
  onIncrement,
  onValueClicked,
  title,
  countTitle,
}) => {
  return (
    <ButtonGroup
      className={cx("count-button", { "increment-only": !onValueClicked })}
    >
      <Button
        className="minimal count-icon"
        variant="secondary"
        onClick={(e) => onIncrement?.(e)}
        title={title}
      >
        {icon}
      </Button>
      <Button
        className="minimal count-value"
        variant="secondary"
        onClick={(e) => (onValueClicked ?? onIncrement)?.(e)}
        title={!!onValueClicked ? countTitle : undefined}
      >
        <span>{value}</span>
      </Button>
    </ButtonGroup>
  );
};

type CountButtonPropsNoIcon = Omit<ICountButtonProps, "icon">;

export const ViewCountButton: React.FC<CountButtonPropsNoIcon> = (props) => {
  const intl = useIntl();
  return (
    <CountButton
      {...props}
      icon={<Icon icon={faEye} />}
      title={intl.formatMessage({ id: "media_info.play_count" })}
      countTitle={intl.formatMessage({ id: "actions.view_history" })}
    />
  );
};

export const OCounterButton: React.FC<CountButtonPropsNoIcon> = (props) => {
  const intl = useIntl();
  return (
    <CountButton
      {...props}
      icon={<SweatDrops />}
      title={intl.formatMessage({ id: "o_count" })}
      countTitle={intl.formatMessage({ id: "actions.view_history" })}
    />
  );
};

/** Shows the like count and increments via sceneIncrementLike. */
export const LikeCountButton: React.FC<CountButtonPropsNoIcon> = (props) => (
  <CountButton
    {...props}
    icon={<Icon icon={faHeart} />}
    title="Likes"
  />
);
