// Clip (mp4, then gif, then nothing) and the key-frame strip. Missing files degrade quietly.
import { useState } from "react";
import { frameCandidates, type EvidenceBundle } from "./model";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Clip({ base, sample = false }: { base: string; sample?: boolean }) {
  const [kind, setKind] = useState<"mp4" | "gif" | "none">("mp4");
  const [reduce] = useState(reducedMotion);
  const [showGif, setShowGif] = useState(!reduce);

  if (kind === "mp4")
    return (
      <figure className="ev-clip">
        <video
          src={`${base}clip.mp4`}
          muted
          loop
          playsInline
          autoPlay={!reduce}
          controls
          preload="metadata"
          onError={() => setKind("gif")}
          aria-label={sample ? "Sample clip, not camera footage" : "Clip recorded by the Farm camera, with the assertion, measured value, verdict and timestamp burned in"}
        />
        <figcaption>
          {sample
            ? "Sample clip for development, not camera footage."
            : "Recorded by the Farm camera. The overlay shows the assertion, the measured value, the verdict and the time."}
        </figcaption>
      </figure>
    );
  if (kind === "gif")
    return (
      <figure className="ev-clip">
        {showGif ? (
          <img src={`${base}clip.gif`} alt={sample ? "Sample animated clip, not camera footage" : "Animated clip recorded by the Farm camera"} onError={() => setKind("none")} />
        ) : (
          <button type="button" className="ev-clip-play" onClick={() => setShowGif(true)}>
            Play the animated clip
          </button>
        )}
        <figcaption>{sample ? "Sample animated clip, not camera footage." : "Recorded by the Farm camera (animated GIF; the MP4 was not available)."}</figcaption>
      </figure>
    );
  return (
    <p className="ev-clip-missing" role="note">
      No clip in this bundle. Key frames, if any, are below.
    </p>
  );
}

export function Frames({ bundle, base }: { bundle: EvidenceBundle; base: string }) {
  const frames = frameCandidates(bundle);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const shown = frames.filter((f) => !failed.has(f.file));
  const listed = !!bundle.frames?.length;

  return (
    <section className="ev-frames" aria-labelledby="ev-frames-title">
      <h2 id="ev-frames-title">Key frames</h2>
      {shown.length === 0 ? (
        <p className="ev-empty">No key frames in this bundle.</p>
      ) : (
        <ol className="ev-frame-strip">
          {shown.map((f, i) => (
            <li key={f.file}>
              <a href={`${base}${f.file}`} target="_blank" rel="noopener noreferrer">
                <img
                  src={`${base}${f.file}`}
                  alt={f.caption ?? `Key frame ${i + 1}`}
                  loading="lazy"
                  onError={() => setFailed((s) => new Set(s).add(f.file))}
                />
              </a>
              <span className="ev-frame-cap">
                {f.t_ms !== undefined && <span className="mono">t+{Math.round(f.t_ms)} ms</span>}
                {f.caption ?? (listed ? null : <span className="mono">{f.file}</span>)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
