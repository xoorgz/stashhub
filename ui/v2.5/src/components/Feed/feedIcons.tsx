import React from "react";

// Built-in icon set for filter chips. Names are stable identifiers stored
// in the chip's iconName field; the rendered SVG is always white stroke
// (or white fill where stroke would be too noisy at 16-20px). Icons are
// authored at viewBox 24, the consumer picks a render size.

interface IconDef {
  name: string;
  label: string;
  svg: React.ReactElement;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const filled = { fill: "currentColor", stroke: "none" };

export const FILTER_CHIP_ICONS: IconDef[] = [
  {
    name: "tongue",
    label: "Tongue",
    svg: (
      <g>
        <path d="M5 8 Q5 5 8 5 L16 5 Q19 5 19 8 V11" {...stroke} />
        <path d="M5 11 V8" {...stroke} />
        <path d="M9 11 Q9 18 12 19 Q15 18 15 11" fill="currentColor" />
        <line x1="12" y1="13" x2="12" y2="17" stroke="rgba(0,0,0,0.35)" strokeWidth={1} />
      </g>
    ),
  },
  {
    name: "lips",
    label: "Lips",
    svg: (
      <g {...stroke}>
        <path d="M4 12 Q7 8 12 12 Q17 8 20 12 Q17 16 12 14 Q7 16 4 12 Z" />
        <path d="M4 12 L20 12" />
      </g>
    ),
  },
  {
    name: "breast",
    label: "Breasts",
    svg: (
      <g {...stroke}>
        <path d="M3 10 Q7 6 10 10 Q11 12 9 13 Q6 13.5 4 12 Q3 11 3 10 Z" />
        <path d="M14 10 Q18 6 21 10 Q22 12 20 13 Q17 13.5 15 12 Q14 11 14 10 Z" />
        <circle cx="7" cy="11" r="0.9" fill="currentColor" />
        <circle cx="18" cy="11" r="0.9" fill="currentColor" />
      </g>
    ),
  },
  {
    name: "peach",
    label: "Peach",
    svg: (
      <g {...stroke}>
        <path d="M12 5 Q14 3 16 5" />
        <path d="M5 13 Q5 7 12 7 Q19 7 19 13 Q19 19 12 19 Q5 19 5 13 Z" />
        <path d="M12 7 Q12 13 12 19" />
      </g>
    ),
  },
  {
    name: "drop",
    label: "Drop",
    svg: <path d="M12 3 Q6 12 6 15 A6 6 0 0 0 18 15 Q18 12 12 3 Z" {...filled} />,
  },
  {
    name: "flame",
    label: "Flame",
    svg: (
      <path
        d="M12 3 Q10 7 8 9 Q5 12 6 16 A6 6 0 0 0 18 16 Q19 12 16 11 Q14 12 14 9 Q14 6 12 3 Z"
        {...filled}
      />
    ),
  },
  {
    name: "heart",
    label: "Heart",
    svg: (
      <path
        d="M12 20 Q4 14 4 9 A4 4 0 0 1 12 7 A4 4 0 0 1 20 9 Q20 14 12 20 Z"
        {...filled}
      />
    ),
  },
  {
    name: "star",
    label: "Star",
    svg: (
      <polygon
        points="12 3 14.6 9.4 21.5 9.9 16.3 14.3 18.1 21 12 17.3 5.9 21 7.7 14.3 2.5 9.9 9.4 9.4"
        {...filled}
      />
    ),
  },
  {
    name: "sparkle",
    label: "Sparkle",
    svg: (
      <g {...stroke}>
        <path d="M12 3 L13.4 9.6 L20 12 L13.4 14.4 L12 21 L10.6 14.4 L4 12 L10.6 9.6 Z" fill="currentColor" stroke="none" />
        <circle cx="19" cy="5" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none" />
      </g>
    ),
  },
  {
    name: "eye",
    label: "Eye",
    svg: (
      <g {...stroke}>
        <path d="M2 12 Q7 5 12 5 Q17 5 22 12 Q17 19 12 19 Q7 19 2 12 Z" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </g>
    ),
  },
  {
    name: "bolt",
    label: "Lightning",
    svg: <polygon points="13 2 4 14 11 14 9 22 20 10 13 10 15 2" {...filled} />,
  },
  {
    name: "thrust",
    label: "Thrust",
    svg: (
      <g {...stroke}>
        <line x1="4" y1="12" x2="14" y2="12" strokeWidth={2.2} />
        <polyline points="11 7 16 12 11 17" strokeWidth={2.2} />
        <line x1="18" y1="6" x2="18" y2="18" strokeWidth={2.2} />
      </g>
    ),
  },
];

export const FILTER_CHIP_ICONS_BY_NAME = new Map(
  FILTER_CHIP_ICONS.map((i) => [i.name, i])
);

export const FilterChipIcon: React.FC<{ name: string; size?: number }> = ({
  name,
  size = 18,
}) => {
  const def = FILTER_CHIP_ICONS_BY_NAME.get(name);
  if (!def) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {def.svg}
    </svg>
  );
};
