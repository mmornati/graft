import "./styles.css";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import type { Me, OverviewResponse } from "../../shared/api.js";
import { useApi } from "./api.js";
import { Mark } from "./components.js";
import { Journal } from "./journal.js";
import { ChangePage } from "./record.js";
import { href, type Route, useRoute } from "./router.js";
import { Changes, Gate, System } from "./views.js";

const THEME_KEY = "graft-console-theme";

function applyStoredTheme(): void {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  } catch {}
}

function toggleTheme(): void {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, root.dataset.theme);
  } catch {}
}

function Header({
  route,
  me,
  ceiling,
}: {
  route: Route;
  me: Me | undefined;
  ceiling: string | null;
}) {
  const current = (v: Route["view"][]) => (v.includes(route.view) ? "page" : undefined);
  return (
    <header class="top">
      <div class="top__in">
        <a class="wordmark" href="#/" aria-label="Graft console, journal">
          <Mark />
          Graft <small>console</small>
        </a>
        <nav class="views" aria-label="Views">
          <a href="#/" aria-current={current(["journal"])}>
            Journal
          </a>
          <a href={href.changes()} aria-current={current(["changes", "change"])}>
            Changes
          </a>
          <a href={href.gate()} aria-current={current(["gate"])}>
            Gate
          </a>
          <a href={href.system()} aria-current={current(["system"])}>
            System
          </a>
        </nav>
        <div class="top__end">
          <span
            class="env"
            title="The console reads Graft's database with a read-only role and never writes to GitHub"
          >
            <i class="env__ring" />
            <span>read-only{ceiling ? ` · ceiling ${ceiling}` : ""}</span>
          </span>
          {me ? (
            <span class="who">
              <span>{me.login}</span>
              {me.auth === "github" ? (
                <form method="post" action="/auth/logout">
                  <button class="linkbtn" type="submit">
                    Sign out
                  </button>
                </form>
              ) : null}
            </span>
          ) : null}
          <button
            class="theme"
            type="button"
            aria-label="Switch light or dark"
            onClick={toggleTheme}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

function App() {
  const route = useRoute();
  const me = useApi<Me>("/api/me");
  const ov = useApi<OverviewResponse>("/api/overview");
  const { reload } = ov;

  // The overview holds what needs a human: refresh it every minute while the tab is visible.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [reload]);

  useEffect(() => {
    const titles: Record<Route["view"], string> = {
      journal: "Journal",
      changes: "Changes",
      change: "Change",
      gate: "Gate",
      system: "System",
    };
    document.title = `${titles[route.view]} · Graft Console`;
  }, [route.view]);

  return (
    <>
      <Header route={route} me={me.data} ceiling={ov.data?.ceiling?.value ?? null} />
      <main id="main" tabIndex={-1}>
        {route.view === "journal" ? <Journal date={route.date} ov={ov} /> : null}
        {route.view === "changes" ? <Changes query={route.query} ov={ov} /> : null}
        {route.view === "change" ? <ChangePage id={route.id} /> : null}
        {route.view === "gate" ? <Gate ov={ov} /> : null}
        {route.view === "system" ? <System ov={ov} /> : null}
      </main>
      <div class="toast" id="toast" role="status" aria-live="polite" />
    </>
  );
}

applyStoredTheme();
const root = document.getElementById("app");
if (root) render(<App />, root);
