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

export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);

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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app" data-drawer={selectedId ? "open" : "closed"}>
      <TopBar onNewSession={() => setNewOpen(true)} onCommand={() => setCmdOpen(true)} />
      <ConnectionBanner />
      <main className="canvas">
        <GraphCanvas selectedId={selectedId} onSelect={setSelectedId} />
      </main>
      <Drawer selectedId={selectedId} onClose={() => setSelectedId(null)} onSelect={setSelectedId} />
      <Toasts onSelect={setSelectedId} />
      <Timeline />
      {!PUBLIC && <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} />}
      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} onSelect={setSelectedId} onNewSession={() => setNewOpen(true)} />
    </div>
  );
}
