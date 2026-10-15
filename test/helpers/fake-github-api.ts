import { createHash } from "node:crypto";
import {
  type FakeCommit,
  type FakeContent,
  type FakeFile,
  type FakeIssue,
  type FakePull,
  type FakeReaction,
  type FakeReview,
  fakeSha,
  OWNER,
  REPO,
} from "./github-builders.js";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  performed_via_github_app?: { id: number } | null;
  /** The issue or PR the comment is on; a comment without it shows on every issue (old tests). */
  issue_number?: number;
  created_at?: string;
  updated_at?: string;
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
  completed_at?: string | null;
}

export interface RecordedApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The `ref` query parameter (contents requests), if any. */
  ref: string | undefined;
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

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/**
 * An in-memory GitHub REST API for one repository (default graft-sandbox/sample-ts; the live e2e
 * world passes its own `owner` and `repo`).
 */
export function createFakeGitHubApi(
  opts: {
    appId?: number;
    botLogin?: string;
    now?: () => number;
    owner?: string;
    repo?: string;
  } = {},
) {
  const clock = opts.now ?? Date.now;
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
    /** Branch tips served by `git/ref/heads/<branch>` (a missing branch is a 404). */
    branches: new Map<string, string>([["main", fakeSha(0xba5e)]]),
    /** `repos.getContent`: contents[ref][path]. A missing entry is a 404. */
    contents: new Map<string, Map<string, FakeContent>>(),
    /** `pulls.listReviews`, oldest first. */
    reviews: new Map<number, FakeReview[]>(),
    /** `issues.listEventsForTimeline`, oldest first, in the API's shape (step 6). */
    timelines: new Map<number, Record<string, unknown>[]>(),
    /** `pulls.listRequestedReviewers` (step 6). */
    requestedReviewers: new Map<
      number,
      { users: { id: number; login: string; type: string }[]; teams: { slug: string }[] }
    >(),
    /**
     * `repos.getCollaboratorPermissionLevel` by lowercased login. A login with no entry is a 404,
     * like a user who is not a collaborator.
     */
    permissions: new Map<string, { id: number; role: string; permission?: string }>(),
    /** `users.getByUsername` by lowercased login (a missing login is a 404). */
    users: new Map<string, number>(),
    /** Reactions per comment id. */
    reactions: new Map<number, FakeReaction[]>(),
    comments: [] as FakeComment[],
    checkRuns: [] as FakeCheckRun[],
    /** When true, comments created through the API carry no performed_via_github_app (D13). */
    omitPerformedViaApp: false,
    /**
     * When set, every response carries `x-ratelimit-*` and `remaining` decrements per request. At 0
     * the API answers 403 "API rate limit exceeded" until the injected clock passes `reset`
     * (epoch seconds), then the window starts again.
     */
    rateLimit: null as { limit: number; remaining: number; reset: number } | null,
    /** When set, `GET /pulls` serves at most this many per page whatever `per_page` says. */
    listPageSize: null as number | null,
    /** When set, issue comments and check runs are served this many per page (live e2e tests). */
    commentsPageSize: null as number | null,
    checkRunsPageSize: null as number | null,
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

  function contentResponse(filePath: string, entry: FakeContent) {
    const name = filePath.split("/").pop() ?? filePath;
    const base = { name, path: filePath };
    switch (entry.kind) {
      case "dir":
        return json(200, [
          { type: "file", name: "inner.yaml", path: `${filePath}/inner.yaml`, size: 1 },
        ]);
      case "symlink":
        return json(200, {
          ...base,
          type: "symlink",
          target: entry.target,
          size: entry.target.length,
          sha: sha1(entry.target),
        });
      case "submodule":
        return json(200, { ...base, type: "submodule", sha: sha1(filePath), size: 0 });
      case "large":
        return json(200, {
          ...base,
          type: "file",
          encoding: "none",
          size: entry.size,
          content: "",
          sha: sha1(`large:${filePath}`),
        });
      case "sized":
        return json(200, {
          ...base,
          type: "file",
          encoding: "base64",
          size: entry.size,
          content: Buffer.from(entry.text).toString("base64"),
          sha: sha1(entry.text),
        });
      case "file": {
        const bytes =
          typeof entry.text === "string" ? Buffer.from(entry.text) : Buffer.from(entry.text);
        return json(200, {
          ...base,
          ...(entry.path !== undefined ? { path: entry.path } : {}),
          type: "file",
          encoding: "base64",
          size: bytes.byteLength,
          content: bytes.toString("base64"),
          ...(entry.omitSha ? {} : { sha: sha1(bytes.toString("latin1")) }),
        });
      }
    }
  }

  async function route(method: string, url: URL, body: Record<string, unknown> | undefined) {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    const repoPrefix = `/repos/${opts.owner ?? OWNER}/${opts.repo ?? REPO}`;

    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return json(201, {
        token: "ghs_faketoken0123456789",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: {},
        repository_selection: "selected",
      });
    }
    const userMatch = method === "GET" ? /^\/users\/([^/]+)$/.exec(path) : null;
    if (userMatch) {
      const login = decodeURIComponent(userMatch[1] as string);
      const id = state.users.get(login.toLowerCase());
      return id === undefined
        ? json(404, { message: "Not Found" })
        : json(200, { id, login, type: "User" });
    }
    if (!path.startsWith(`${repoPrefix}/`)) return json(404, { message: "Not Found (fake repo)" });
    const rest = path.slice(repoPrefix.length);
    const is = (meth: string, re: RegExp): RegExpExecArray | null =>
      method === meth ? re.exec(rest) : null;

    if (is("GET", /^\/pulls$/)) {
      const wantState = url.searchParams.get("state") ?? "open";
      const direction = url.searchParams.get("direction") === "asc" ? 1 : -1;
      // `sort=created` orders by creation time (step 6); the default here stays `updated_at`.
      const key = url.searchParams.get("sort") === "created" ? "created_at" : "updated_at";
      const all = [...state.pulls.values()]
        .filter((p) => wantState === "all" || p.state === wantState)
        .sort((a, b) => direction * (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
      if (state.listPageSize !== null) url.searchParams.set("per_page", String(state.listPageSize));
      return paged(all, url, path);
    }
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
    m = is("GET", /^\/pulls\/(\d+)\/requested_reviewers$/);
    if (m) {
      const n = Number(m[1]);
      if (!state.pulls.has(n)) return json(404, { message: "Not Found" });
      return json(200, state.requestedReviewers.get(n) ?? { users: [], teams: [] });
    }
    m = is("GET", /^\/collaborators\/([^/]+)\/permission$/);
    if (m) {
      const login = decodeURIComponent(m[1] as string);
      const p = state.permissions.get(login.toLowerCase());
      if (!p) return json(404, { message: "Not Found" });
      // The legacy `permission` field maps maintain to write and triage to read.
      const legacy =
        p.permission ?? (p.role === "maintain" ? "write" : p.role === "triage" ? "read" : p.role);
      return json(200, {
        permission: legacy,
        role_name: p.role,
        user: { id: p.id, login, type: "User" },
      });
    }
    m = is("GET", /^\/issues\/(\d+)\/timeline$/);
    if (m) {
      const all = state.timelines.get(Number(m[1]));
      return all ? paged(all, url, path) : json(404, { message: "Not Found" });
    }
    m = is("GET", /^\/pulls\/(\d+)\/reviews$/);
    if (m) return paged(state.reviews.get(Number(m[1])) ?? [], url, path);
    // Octokit percent-encodes the slash of `heads/main` ("heads%2Fmain"); GitHub accepts both.
    m = is("GET", /^\/git\/ref\/heads(?:\/|%2F)(.+)$/i);
    if (m) {
      const branch = decodeURIComponent(m[1] as string);
      const sha = state.branches.get(branch);
      return sha === undefined
        ? json(404, { message: "Not Found" })
        : json(200, {
            ref: `refs/heads/${branch}`,
            object: { type: "commit", sha, url: `https://api.github.com/commit/${sha}` },
          });
    }
    m = is("GET", /^\/contents\/(.+)$/);
    if (m) {
      const filePath = decodeURIComponent(m[1] as string);
      const entry = state.contents.get(url.searchParams.get("ref") ?? "")?.get(filePath);
      return entry ? contentResponse(filePath, entry) : json(404, { message: "Not Found" });
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
      if (state.checkRunsPageSize !== null) {
        const size = state.checkRunsPageSize;
        const page = Number(url.searchParams.get("page") ?? "1");
        const all = runs.slice().reverse();
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        return json(
          200,
          { total_count: all.length, check_runs: all.slice((page - 1) * size, page * size) },
          page * size < all.length ? { link: `<${next.toString()}>; rel="next"` } : {},
        );
      }
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
    m = is("GET", /^\/issues\/(\d+)\/comments$/);
    if (m) {
      const n = Number(m[1]);
      if (state.commentsPageSize !== null) {
        url.searchParams.set("per_page", String(state.commentsPageSize));
      }
      return paged(
        state.comments.filter((c) => c.issue_number === undefined || c.issue_number === n),
        url,
        path,
      );
    }
    m = is("POST", /^\/issues\/(\d+)\/comments$/);
    if (m) {
      const c: FakeComment = {
        id: state.nextId++,
        issue_number: Number(m[1]),
        body: body?.body as string,
        user: { login: botLogin, type: "Bot" },
        ...(state.omitPerformedViaApp ? {} : { performed_via_github_app: { id: appId } }),
      };
      state.comments.push(c);
      return json(201, c);
    }
    return json(404, { message: `Not Found (fake: ${method} ${path})` });
  }

  const fetchRaw: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const raw = init?.body ?? (req ? await req.text() : undefined);
    const body = typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : undefined;
    const record: RecordedApiRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ref: url.searchParams.get("ref") ?? undefined,
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

    const rl = state.rateLimit;
    const withRateLimit = (res: Response): Response => {
      if (!rl) return res;
      const headers = new Headers(res.headers);
      headers.set("x-ratelimit-limit", String(rl.limit));
      headers.set("x-ratelimit-remaining", String(rl.remaining));
      headers.set("x-ratelimit-reset", String(rl.reset));
      return new Response(res.body, { status: res.status, headers });
    };
    if (rl) {
      if (rl.remaining <= 0 && clock() / 1000 >= rl.reset) {
        rl.remaining = rl.limit;
        rl.reset += 3600;
      }
      if (rl.remaining <= 0) {
        return withRateLimit(json(403, { message: "API rate limit exceeded for installation" }));
      }
      rl.remaining -= 1;
    }

    const fIdx = failures.findIndex((f) => f.method === method && f.pathRegex.test(url.pathname));
    const failure = fIdx >= 0 ? failures[fIdx] : undefined;
    if (failure) {
      failures.splice(fIdx, 1);
      return withRateLimit(json(failure.status, failure.body, failure.headers));
    }
    return withRateLimit(await route(method, url, body));
  };

  /** Real responses carry their url; Octokit's paginate reads it. */
  const fetchFn: typeof fetch = async (input, init) => {
    const res = await fetchRaw(input, init);
    if (!res.url) {
      const raw = input instanceof Request ? input.url : String(input);
      Object.defineProperty(res, "url", { value: raw });
    }
    return res;
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
