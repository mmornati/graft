import { useEffect, useState } from "preact/hooks";

export type Route =
  | { view: "journal"; date: string | null }
  | { view: "changes"; query: URLSearchParams }
  | { view: "change"; id: string }
  | { view: "gate" }
  | { view: "system" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/;

/** Hash routes, so every view has a link an operator can bookmark or paste. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  switch (parts[0]) {
    case "changes":
      if (parts[1] && UUID.test(parts[1])) return { view: "change", id: parts[1] };
      return { view: "changes", query: new URLSearchParams(query) };
    case "gate":
      return { view: "gate" };
    case "system":
      return { view: "system" };
    case "journal":
      return { view: "journal", date: parts[1] && DATE.test(parts[1]) ? parts[1] : null };
    default:
      return { view: "journal", date: null };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      document.getElementById("main")?.focus({ preventScroll: true });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const href = {
  day: (date: string) => `#/journal/${date}`,
  changes: (q?: URLSearchParams) => `#/changes${q?.toString() ? `?${q.toString()}` : ""}`,
  change: (id: string) => `#/changes/${id}`,
  gate: () => "#/gate",
  system: () => "#/system",
};
