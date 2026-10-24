// Evidence page entry. Control serves dist/evidence.html at /e/<evidence_id>; dev uses ?id=<id> or ?fixture=1.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import { EvidencePage } from "./EvidencePage";
import { resolveSource } from "./model";

const source = resolveSource(location.pathname, location.search);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EvidencePage source={source} />
  </StrictMode>,
);
