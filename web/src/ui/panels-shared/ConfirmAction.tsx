// A destructive button with an in-place confirm step (no window.confirm: the viewer may block it, and it reads badly on video).
import { useEffect, useId, useRef, useState } from "react";
import { useAsyncAction } from "./hooks";
import "./panels.css";

export interface ConfirmActionProps {
  label: string;
  /** What will happen, in one plain sentence. */
  question: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  /** When set the button is disabled and this is its tooltip. */
  disabledReason?: string;
  doneText?: string;
}

export function ConfirmAction({ label, question, confirmLabel, onConfirm, disabledReason, doneText }: ConfirmActionProps) {
  const [asking, setAsking] = useState(false);
  const { state, run, reset } = useAsyncAction(async () => {
    await onConfirm();
    return true as const;
  });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const qid = useId();

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
  }, [asking]);

  if (!asking) {
    return (
      <span className="confirm-wrap">
        <button
          type="button"
          className="pbtn"
          disabled={!!disabledReason}
          title={disabledReason}
          onClick={() => {
            reset();
            setAsking(true);
          }}
        >
          {label}
        </button>
        {state.status === "done" && doneText && <span className="pnote" role="status">{doneText}</span>}
      </span>
    );
  }

  return (
    <div className="confirm-box" role="group" aria-labelledby={qid}>
      <p id={qid} className="confirm-q">{question}</p>
      <div className="confirm-row">
        <button
          type="button"
          className="pbtn pbtn-strong"
          disabled={state.status === "busy"}
          onClick={async () => {
            const ok = await run();
            if (ok) setAsking(false);
          }}
        >
          {state.status === "busy" ? "Working…" : confirmLabel}
        </button>
        <button type="button" className="pbtn" ref={cancelRef} onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
      {state.status === "error" && (
        <p className="perror" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
