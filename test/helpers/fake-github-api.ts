import {
  type FakeCommit,
  type FakeFile,
  type FakeIssue,
  type FakePull,
  type FakeReaction,
  OWNER,
  REPO,
} from "./github-builders.js";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  performed_via_github_app?: { id: number } | null;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  external_id: string;
  output: { title: string; summary: string; text?: string };
  app: { id: number };
  actions?: { label: string; identifier: string; description: string }[];
}

export interface RecordedApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Parsed JSON body, if any. */
  body: Record<string, unknown> | undefined;
}

interface Failure {
  method: string;
  pathRegex: RegExp;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface Blocker {
  release(): void;
  /** Resolves once a matching request has arrived and is being held. */
  reached: Promise<void>;
}

/** An in-memory GitHub REST API for one repository (graft-sandbox/sample-ts). */
export function createFakeGitHubApi(opts: { appId?: number; botLogin?: string } = {}) {
  const appId = opts.appId ?? 12345;
  const botLogin = opts.botLogin ?? "graft-dev[bot]";
  const state = {
    pulls: new Map<number, FakePull>(),
    commits: new Map<number, FakeCommit[]>(),
    /** Extra commits served by git/commits/{sha}. The head of a PR is looked up here first. */
    gitCommits: new Map<string, string>(),
    /** `pulls.listFiles`; at most 3,000 are served, like the real API. */
    files: new Map<number, FakeFile[]>(),
    issues: new Map<number, FakeIssue>(),
    /** Reactions per comment id. */
    reactions: new Map<number, FakeReaction[]>(),
    comments: [] as FakeComment[],
    checkRuns: [] as FakeCheckRun[],
    /** When true, comments created through the API carry no performed_via_github_app (D13). */
    omitPerformedViaApp: false,
    nextId: 1000,
  };
  const requests: RecordedApiRequest[] = [];
  const failures: Failure[] = [];
  const blocks: {
    method: string;
    pathRegex: RegExp;
    gate: Promise<void>;
    open: () => void;
    hit: () => void;
  }[] = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  function paged<T>(all: T[], url: URL, path: string) {
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const page = Number(url.searchParams.get("page") ?? "1");
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const links: string[] = [];
    if (page * perPage < all.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      links.push(`<${next.toString()}>; rel="next"`);
    }
    void path;
    return json(200, slice, links.length > 0 ? { link: links.join(", ") } : {});
  }

  async function route(method: string, url: URL, body: Record<string, unknown> | undefined) {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    const repoPrefix = `/repos/${OWNER}/${REPO}`;

    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return json(201, {
        token: "ghs_faketoken0123456789",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: {},
        repository_selection: "selected",
      });
    }
    if (!path.startsWith(`${repoPrefix}/`)) return json(404, { message: "Not Found (fake repo)" });
    const rest = path.slice(repoPrefix.length);
    const is = (meth: string, re: RegExp): RegExpExecArray | null =>
      method === meth ? re.exec(rest) : null;

    m = is("GET", /^\/pulls\/(\d+)$/);
    if (m) {
      const pull = state.pulls.get(Number(m[1]));
      return pull ? json(200, pull) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/pulls\/(\d+)\/commits$/);
    if (m) {
      const all = state.commits.get(Number(m[1]));
      // The real API serves at most 250 commits.
      return all ? paged(all.slice(0, 250), url, path) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/pulls\/(\d+)\/files$/);
    if (m) {
      const all = state.files.get(Number(m[1]));
      return all ? paged(all.slice(0, 3000), url, path) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/issues\/(\d+)$/);
    if (m) {
      const issue = state.issues.get(Number(m[1]));
      return issue ? json(200, issue) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/issues\/comments\/(\d+)\/reactions$/);
    if (m) {
      const all = state.reactions.get(Number(m[1]));
      return all ? paged(all, url, path) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/check-runs\/(\d+)$/);
    if (m) {
      const run = state.checkRuns.find((r) => r.id === Number(m?.[1]));
      return run ? json(200, run) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/git\/commits\/([0-9a-f]{40})$/);
    if (m) {
      const sha = m[1] as string;
      let message = state.gitCommits.get(sha);
      if (message === undefined) {
        for (const list of state.commits.values()) {
          const hit = list.find((c) => c.sha === sha);
          if (hit) message = hit.commit.message;
        }
      }
      return message === undefined
        ? json(404, { message: "Not Found" })
        : json(200, { sha, message });
    }
    m = is("GET", /^\/commits\/([^/]+)\/check-runs$/);
    if (m) {
      const name = url.searchParams.get("check_name");
      const app = url.searchParams.get("app_id");
      const runs = state.checkRuns.filter(
        (r) =>
          r.head_sha === m?.[1] &&
          (name === null || r.name === name) &&
          (app === null || String(r.app.id) === app),
      );
      return json(200, { total_count: runs.length, check_runs: runs.slice().reverse() });
    }
    if (method === "POST" && rest === "/check-runs") {
      const run: FakeCheckRun = {
        id: state.nextId++,
        name: body?.name as string,
        head_sha: body?.head_sha as string,
        status: body?.status as string,
        conclusion: (body?.conclusion as string | undefined) ?? null,
        external_id: (body?.external_id as string | undefined) ?? "",
        output: body?.output as FakeCheckRun["output"],
        app: { id: appId },
        ...(body?.actions ? { actions: body.actions as FakeCheckRun["actions"] } : {}),
      };
      state.checkRuns.push(run);
      return json(201, run);
    }
    m = is("PATCH", /^\/check-runs\/(\d+)$/);
    if (m) {
      const run = state.checkRuns.find((r) => r.id === Number(m?.[1]));
      if (!run) return json(404, { message: "Not Found" });
      Object.assign(run, body);
      return json(200, run);
    }
    m = is("GET", /^\/issues\/comments\/(\d+)$/);
    if (m) {
      const c = state.comments.find((x) => x.id === Number(m?.[1]));
      return c ? json(200, c) : json(404, { message: "Not Found" });
    }
    m = is("PATCH", /^\/issues\/comments\/(\d+)$/);
    if (m) {
      const c = state.comments.find((x) => x.id === Number(m?.[1]));
      if (!c) return json(404, { message: "Not Found" });
      c.body = body?.body as string;
      return json(200, c);
    }
    if (method === "GET" && /^\/issues\/\d+\/comments$/.test(rest)) {
      return paged(state.comments, url, path);
    }
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(rest)) {
      const c: FakeComment = {
        id: state.nextId++,
        body: body?.body as string,
        user: { login: botLogin, type: "Bot" },
        ...(state.omitPerformedViaApp ? {} : { performed_via_github_app: { id: appId } }),
      };
      state.comments.push(c);
      return json(201, c);
    }
    return json(404, { message: `Not Found (fake: ${method} ${path})` });
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const raw = init?.body ?? (req ? await req.text() : undefined);
    const body = typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : undefined;
    const record: RecordedApiRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    };
    requests.push(record);

    const blockIdx = blocks.findIndex((b) => b.method === method && b.pathRegex.test(url.pathname));
    const blocker = blockIdx >= 0 ? blocks[blockIdx] : undefined;
    if (blocker) {
      blocks.splice(blockIdx, 1);
      blocker.hit();
      await blocker.gate;
    }

    const fIdx = failures.findIndex((f) => f.method === method && f.pathRegex.test(url.pathname));
    const failure = fIdx >= 0 ? failures[fIdx] : undefined;
    if (failure) {
      failures.splice(fIdx, 1);
      return json(failure.status, failure.body, failure.headers);
    }
    return route(method, url, body);
  };

  return {
    fetch: fetchFn,
    requests,
    state,
    appId,
    /** The next request matching method and path fails with this status. */
    failNext(
      method: string,
      pathRegex: RegExp,
      status: number,
      headers: Record<string, string> = {},
      body: unknown = { message: "fake failure" },
    ) {
      failures.push({ method: method.toUpperCase(), pathRegex, status, headers, body });
    },
    /** The next matching request is held until `release()`. */
    block(method: string, pathRegex: RegExp): Blocker {
      let open!: () => void;
      let hit!: () => void;
      const gate = new Promise<void>((r) => {
        open = r;
      });
      const reached = new Promise<void>((r) => {
        hit = r;
      });
      blocks.push({ method: method.toUpperCase(), pathRegex, gate, open, hit });
      return { release: () => open(), reached };
    },
    /** Requests so far matching method and path. */
    find(method: string, pathRegex: RegExp): RecordedApiRequest[] {
      return requests.filter((r) => r.method === method.toUpperCase() && pathRegex.test(r.path));
    },
  };
}

export type FakeGitHubApi = ReturnType<typeof createFakeGitHubApi>;
