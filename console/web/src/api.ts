import { useCallback, useEffect, useState } from "preact/hooks";
import type { ApiError } from "../../shared/api.js";

export const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401) {
    // The session ended: go back through sign-in.
    window.location.assign("/auth/login");
    throw new HttpError(401, "Signing in again…");
  }
  if (!res.ok) {
    let message = `The console answered ${res.status}.`;
    try {
      message = ((await res.json()) as ApiError).message ?? message;
    } catch {}
    throw new HttpError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface Loaded<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Fetches `path` (null: nothing yet) and refetches when it changes or on `reload`. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    setState((s) => ({ data: s.data, loading: true }));
    getJson<T>(path, ctl.signal).then(
      (data) => setState({ data, loading: false }),
      (error: unknown) => {
        if (ctl.signal.aborted) return;
        setState({
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        });
      },
    );
    return () => ctl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
