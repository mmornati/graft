import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { RiskClass, VerifierStatus } from "../../shared/api.js";
import { words } from "./format.js";

export function Mark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path class="mk-stock" d="M32 60V30" fill="none" stroke-width="7" stroke-linecap="round" />
      <path class="mk-scion" d="M32 31L47 8" fill="none" stroke-width="6" stroke-linecap="round" />
      <path class="mk-leaf" d="M47 8c-6 1-10 5-10 10 6-1 10-5 10-10z" />
      <rect class="mk-tape" x="25" y="29" width="14" height="11" rx="1.5" stroke-width="2" />
      <path class="mk-line" d="M26 33h12M26 36.5h12" stroke-width="1.4" />
    </svg>
  );
}

/** A risk word with its stamp silhouette: ring, dashed rectangle, double ring. */
export function Risk({ c }: { c: RiskClass }) {
  return <span class={`risk risk--${c}`}>{c}</span>;
}

export function Stamp({ c, sub }: { c: RiskClass; sub: string }) {
  return (
    <div class={`stamp stamp--${c}`} role="img" aria-label={`Final risk ${c}, ${sub}`}>
      <span>{c}</span>
      <small>{sub}</small>
    </div>
  );
}

export function Verifier({ v, missing }: { v: VerifierStatus; missing?: number }) {
  const icon =
    v === "agree" ? (
      <path d="M3 8.5l3.2 3L13 4.5" />
    ) : v === "disagree" ? (
      <path d="M4 4l8 8M12 4l-8 8" />
    ) : (
      <path d="M4 8h8" />
    );
  const label =
    v === "agree"
      ? "verifier agrees"
      : v === "disagree"
        ? `verifier disagrees${missing ? ` · ${missing} claim${missing === 1 ? "" : "s"} unsupported` : ""}`
        : v === "error"
          ? "verifier failed"
          : "verifier skipped";
  return (
    <span class="verif">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        aria-hidden="true"
      >
        {icon}
      </svg>
      {label}
    </span>
  );
}

export function Outcome({ o }: { o: string | null }) {
  return o ? <span>{words(o)}</span> : null;
}

export function Chevron() {
  return (
    <svg
      class="entry__chev"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      aria-hidden="true"
    >
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </svg>
  );
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.dataset.on = "true";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.dataset.on = "false";
  }, 1600);
}

/** A CLI command with a copy button: the console never acts, it hands the operator the command. */
export function Cmd({ children }: { children: string }) {
  const [id] = useState(() => `cmd-${Math.random().toString(36).slice(2)}`);
  const copy = (ev: Event) => {
    ev.stopPropagation();
    const code = document.getElementById(id);
    const fallback = () => {
      if (!code) return;
      const r = document.createRange();
      r.selectNodeContents(code);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      toast("Selected: press Ctrl+C or Cmd+C to copy");
    };
    try {
      navigator.clipboard.writeText(children).then(() => toast("Copied"), fallback);
    } catch {
      fallback();
    }
  };
  return (
    <div class="cmd">
      <code id={id}>{children}</code>
      <button type="button" onClick={copy}>
        Copy
      </button>
    </div>
  );
}

export function Loading({ label = "Reading the database" }: { label?: string }) {
  return (
    <p class="loading" role="status">
      {label}
    </p>
  );
}

export function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div class="state state--error" role="alert">
      <h3>That did not load</h3>
      <p>{error.message}</p>
      <button type="button" class="btn btn--ghost" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="state">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
