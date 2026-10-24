// App frame from the reference: left sidebar (desktop) + page. Phones get the page alone.
import type { ReactNode } from "react";
import { HardwareIcon, Logo, LogsIcon, MapIcon, SessionsIcon, SettingsIcon } from "./Icons";

export type Page = "map" | "sessions" | "hardware" | "logs" | "settings";

const NAV: { page: Page; label: string; Icon: typeof MapIcon }[] = [
  { page: "map", label: "Live map", Icon: MapIcon },
  { page: "sessions", label: "Sessions", Icon: SessionsIcon },
  { page: "hardware", label: "Hardware", Icon: HardwareIcon },
  { page: "logs", label: "Logs", Icon: LogsIcon },
  { page: "settings", label: "Settings", Icon: SettingsIcon },
];

export function Shell({ page, onPage, children }: { page: Page; onPage: (p: Page) => void; children: ReactNode }) {
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="side-brand">
          <Logo />
          <span>Devin Farm</span>
        </div>
        <ul>
          {NAV.map(({ page: p, label, Icon }) => (
            <li key={p}>
              <a
                href={`#${p}`}
                className="side-link"
                aria-current={page === p ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onPage(p);
                }}
              >
                <Icon />
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="page">{children}</main>
    </div>
  );
}
