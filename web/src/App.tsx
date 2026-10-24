import { useEffect, useState } from "react";
import { GraphCanvas } from "./map/GraphCanvas";
import { Drawer } from "./ui/drawer/Drawer";
import { NewSessionModal } from "./ui/NewSessionModal";
import { CommandBar } from "./ui/CommandBar";
import { Toasts } from "./ui/Toasts";
import { Timeline } from "./ui/Timeline";
import { TopBar } from "./ui/TopBar";
import { ConnectionBanner } from "./ui/ConnectionBanner";
import { PUBLIC } from "./data/api";
import { Shell, type Page } from "./dash/Shell";
import { Dashboard } from "./dash/Dashboard";
import { LogsPage } from "./dash/LogsPage";
import { SettingsPage } from "./dash/SettingsPage";
import "./dash/dash.css";

const PAGES: Page[] = ["map", "sessions", "hardware", "logs", "settings"];
const pageFromHash = (): Page => {
  const h = window.location.hash.replace("#", "") as Page;
  return PAGES.includes(h) ? h : "map";
};
/** ?view=graph keeps the force-graph bubble map (FRONTEND.md) available alongside the dashboard. */
const GRAPH = new URLSearchParams(window.location.search).get("view") === "graph";

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
        setSelectedId(null);
      }
    };
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const goto = (p: Page) => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${p}`);
    setPage(p);
  };

  const overlays = (
    <>
      <Drawer selectedId={selectedId} onClose={() => setSelectedId(null)} onSelect={setSelectedId} />
      <Toasts onSelect={setSelectedId} />
      {!PUBLIC && <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} />}
      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} onSelect={setSelectedId} onNewSession={() => setNewOpen(true)} />
    </>
  );

  if (GRAPH) {
    return (
      <div className="app" data-drawer={selectedId ? "open" : "closed"}>
        <TopBar onNewSession={() => setNewOpen(true)} onCommand={() => setCmdOpen(true)} />
        <ConnectionBanner />
        <main className="canvas">
          <GraphCanvas selectedId={selectedId} onSelect={setSelectedId} />
        </main>
        <Timeline />
        {overlays}
      </div>
    );
  }

  const section = page === "sessions" ? "sessions" : page === "hardware" ? "hardware" : "all";
  return (
    <div className="dash-app" data-drawer={selectedId ? "open" : "closed"}>
      <Shell page={page} onPage={goto}>
        {page === "logs" ? (
          <LogsPage />
        ) : page === "settings" ? (
          <SettingsPage />
        ) : (
          <Dashboard section={section} onSelect={setSelectedId} onNewSession={() => setNewOpen(true)} onCommand={() => setCmdOpen(true)} />
        )}
      </Shell>
      {overlays}
    </div>
  );
}
