// Line icons, 18px, currentColor. Kept local so the app has no icon dependency.
import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

export const Logo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 22, height: 22, ...p })}>
    <circle cx="12" cy="12" r="2.2" />
    <ellipse cx="12" cy="6.2" rx="2.6" ry="3.6" />
    <ellipse cx="12" cy="17.8" rx="2.6" ry="3.6" />
    <ellipse cx="6.6" cy="9.1" rx="2.6" ry="3.6" transform="rotate(-60 6.6 9.1)" />
    <ellipse cx="17.4" cy="14.9" rx="2.6" ry="3.6" transform="rotate(-60 17.4 14.9)" />
    <ellipse cx="6.6" cy="14.9" rx="2.6" ry="3.6" transform="rotate(60 6.6 14.9)" />
    <ellipse cx="17.4" cy="9.1" rx="2.6" ry="3.6" transform="rotate(60 17.4 9.1)" />
  </svg>
);
export const MapIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="M12 8.2a3.3 3.3 0 0 1 3.3 3.3c0 2.4-3.3 5-3.3 5s-3.3-2.6-3.3-5A3.3 3.3 0 0 1 12 8.2z" />
    <circle cx="12" cy="11.5" r="0.9" />
  </svg>
);
export const SessionsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M3.5 9h17M8 13h3M8 16h6" />
    <circle cx="16.5" cy="14.5" r="1.5" />
  </svg>
);
export const HardwareIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="6" y="3.5" width="12" height="17" rx="2.5" />
    <path d="M9 7.5h6M9 11h6M9 14.5h6M10 20.5v-2M14 20.5v-2" />
  </svg>
);
export const LogsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M7.5 9h9M7.5 12h9M7.5 15h5" />
  </svg>
);
export const SettingsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8l1.6 2.3 2.7-.6.9 2.6 2.6.9-.6 2.7 2.3 1.6-2.3 1.6.6 2.7-2.6.9-.9 2.6-2.7-.6L12 21.2l-1.6-2.3-2.7.6-.9-2.6-2.6-.9.6-2.7L2.5 12l2.3-1.6-.6-2.7 2.6-.9.9-2.6 2.7.6z" />
  </svg>
);
export const Plus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 16, height: 16, strokeWidth: 1.8, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const Dots = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="6" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="18" cy="12" r="1" fill="currentColor" />
  </svg>
);
export const DotsV = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="6" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="18" r="1" fill="currentColor" />
  </svg>
);
export const Chevron = (p: SVGProps<SVGSVGElement> & { dir?: "right" | "down" | "up" }) => {
  const { dir = "right", ...rest } = p;
  const d = { right: "M9 6l6 6-6 6", down: "M6 9l6 6 6-6", up: "M6 15l6-6 6 6" }[dir];
  return (
    <svg {...base({ width: 16, height: 16, ...rest })}>
      <path d={d} />
    </svg>
  );
};
export const Check = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 14, height: 14, strokeWidth: 2, ...p })}>
    <path d="M5 12.5l4.2 4.2L19 7" />
  </svg>
);
export const Cross = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 14, height: 14, strokeWidth: 2, ...p })}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const Play = (p: SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...p}>
    <path d="M3.5 1.8v10.4L12 7z" fill="currentColor" />
  </svg>
);
export const Pause = (p: SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden {...p}>
    <rect x="3" y="2" width="2.8" height="10" rx="0.6" fill="currentColor" />
    <rect x="8.2" y="2" width="2.8" height="10" rx="0.6" fill="currentColor" />
  </svg>
);
