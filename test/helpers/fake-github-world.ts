/**
 * A multi-actor fake GitHub "world" for the live e2e runner's offline tests (T14).
 *
 * It wraps `createFakeGitHubApi` (which keeps serving everything Graft reads) and adds what the
 * runner writes: users and tokens, a minimal git store (blobs, trees, commits, refs), pull
 * requests, issues, labels, reviews, requested reviewers, reactions, forks, GraphQL
 * `markPullRequestReadyForReview`, the App's webhook delivery log with redelivery, and the webhook
 * emission that real GitHub performs after each of those actions. Rendering of `body_html` is a
 * tiny approximation (escape, mentions, code spans, alert blocks): documented as approximate.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createFakeGitHubApi, type FakeCheckRun, type FakeGitHubApi } from "./fake-github-api.js";
import type { FakeFile, FakePull, FakeReview } from "./github-builders.js";

export interface WorldUser {
  login: string;
  id: number;
  token: string;
}

export interface WorldOptions {
  owner: string;
  repo: string;
  repoId?: number;
  appId: number;
  botLogin: string;
  installationId: number;
  users: { actor: WorldUser; outsider?: WorldUser };
  private: boolean;
  /** Posts a webhook to the Graft server; resolves to the HTTP status. */
  deliver(event: string, body: unknown, guid: string): Promise<number>;
  /** false: the sandbox does not exist until `POST /user/repos` creates it. */
  repoExists?: boolean;
  now?: () => number;
  /** A read-only repository (the e2e source): `GET` only, no pulls. */
  readOnlyRepo?: string;
  /** Files of the initial `main` commit. */
  seedFiles?: Map<string, string>;
}

interface Commit {
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
}

interface WorldRepo {
  owner: string;
  name: string;
  id: number;
  private: boolean;
  parent?: string;
  refs: Map<string, string>;
}

interface WorldPr {
  number: number;
  nodeId: string;
  author: WorldUser;
  headRepo: string;
  headRef: string;
  baseRef: string;
  /** The commit the PR was branched from. */
  mergeBase: string;
  baseSha: string;
  title: string;
  body: string | null;
  draft: boolean;
  state: "open" | "closed";
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface Delivery {
  id: number;
  guid: string;
  event: string;
  action: string | null;
  deliveredAt: string;
  redelivery: boolean;
  statusCode: number;
  body: unknown;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const ZERO = "0".repeat(40);

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Line-level diff: common prefix and suffix trimmed, the middle is one hunk. */
export function makePatch(
  oldText: string,
  newText: string,
): { patch: string; additions: number; deletions: number } {
  const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  const header = `@@ -${removed.length === 0 ? pre : pre + 1},${removed.length} +${added.length === 0 ? pre : pre + 1},${added.length} @@`;
  const patch = [header, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  return { patch, additions: added.length, deletions: removed.length };
}

export function createFakeGitHubWorld(opts: WorldOptions) {
  const clock = opts.now ?? Date.now;
  let lastTick = 0;
  const tick = (): number => {
    lastTick = Math.max(lastTick + 1, clock());
    return lastTick;
  };
  const iso = () => new Date(tick()).toISOString();

  const api = createFakeGitHubApi({
    appId: opts.appId,
    botLogin: opts.botLogin,
    owner: opts.owner,
    repo: opts.repo,
    now: clock,
  });
  const state = api.state;
  const users = new Map<string, WorldUser>();
  for (const u of [opts.users.actor, opts.users.outsider])
    if (u) users.set(u.login.toLowerCase(), u);
  const tokenOwner = new Map<string, WorldUser>();
  for (const u of users.values()) tokenOwner.set(u.token, u);
  const BOT: WorldUser = { login: opts.botLogin, id: 9_000_001, token: "" };

  const sandboxKey = `${opts.owner}/${opts.repo}`.toLowerCase();
  const repoId = opts.repoId ?? 2_000_001;
  const repos = new Map<string, WorldRepo>();
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, Commit>();
  const prs = new Map<number, WorldPr>();
  const deliveries: Delivery[] = [];
  const collaborators = new Map<string, "pending" | "accepted">();
  const labels = new Set<string>();
  let nextNumber = 1;
  let nextReviewId = 7000;
  let nextReactionId = 8000;
  let nextDeliveryId = 100;
  let actionsEnabled = true;
  const manifest = JSON.parse(
    readFileSync(new URL("../../github/app-manifest.json", import.meta.url), "utf8"),
  ) as { default_permissions: Record<string, string>; default_events: string[] };
  /** Requests the world answered, in order (for assertions about non-GET traffic). */
  const log: { method: string; path: string; who: string }[] = [];

  // ---- git store ---------------------------------------------------------------------------
  function putBlob(content: string): string {
    const sha = sha1(`blob ${content.length}\0${content}`);
    blobs.set(sha, content);
    return sha;
  }
  function putTree(entries: Map<string, string>): string {
    const sha = sha1(
      `tree ${[...entries]
        .sort()
        .map(([p, b]) => `${p}:${b}`)
        .join("|")}`,
    );
    trees.set(sha, new Map(entries));
    return sha;
  }
  function putCommit(c: Commit): string {
    const sha = sha1(`commit ${JSON.stringify(c)}${commits.size}`);
    commits.set(sha, c);
    state.gitCommits.set(sha, c.message);
    return sha;
  }
  const fileAt = (commit: string, path: string): string | null => {
    const c = commits.get(commit);
    if (!c) return null;
    const blob = trees.get(c.tree)?.get(path);
    return blob === undefined ? null : (blobs.get(blob) ?? null);
  };
  const treeOf = (commit: string): Map<string, string> => {
    const c = commits.get(commit);
    return (c && trees.get(c.tree)) || new Map();
  };

  function repoOf(key: string): WorldRepo | undefined {
    return repos.get(key.toLowerCase());
  }
  function createRepo(owner: string, name: string, isPrivate: boolean, parent?: string): WorldRepo {
    const r: WorldRepo = {
      owner,
      name,
      id: repos.size === 0 ? repoId : repoId + repos.size,
      private: isPrivate,
      ...(parent ? { parent } : {}),
      refs: new Map(),
    };
    repos.set(`${owner}/${name}`.toLowerCase(), r);
    return r;
  }

  /** The initial `main` of the sandbox (also used by a fake `GitPusher`). */
  function seedMain(files: Map<string, string>, message = "Initial commit"): string {
    const sandbox = repoOf(sandboxKey) ?? createRepo(opts.owner, opts.repo, opts.private);
    const entries = new Map<string, string>();
    for (const [p, text] of files) entries.set(p, putBlob(text));
    const tree = putTree(entries);
    const sha = putCommit({
      tree,
      parents: [],
      message,
      author: { name: "Graft E2E", email: "seed@users.noreply.github.com", date: iso() },
    });
    sandbox.refs.set("heads/main", sha);
    state.branches.set("main", sha);
    return sha;
  }

  for (const u of users.values()) state.users.set(u.login.toLowerCase(), u.id);

  if (opts.repoExists !== false) {
    const seed = opts.seedFiles ?? new Map([["README.md", "# sandbox\n"]]);
    seedMain(seed);
    state.permissions.set(opts.users.actor.login.toLowerCase(), {
      id: opts.users.actor.id,
      role: "admin",
    });
  }

  // ---- pull requests -----------------------------------------------------------------------
  const repoPayload = (r: WorldRepo) => ({
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    private: r.private,
    owner: userPayload(users.get(r.owner.toLowerCase()) ?? opts.users.actor),
    html_url: `https://github.com/${r.owner}/${r.name}`,
    default_branch: "main",
  });
  const userPayload = (u: WorldUser) => ({
    login: u.login,
    id: u.id,
    node_id: `U_${u.id}`,
    type: u.login === opts.botLogin ? "Bot" : "User",
    site_admin: false,
    html_url: `https://github.com/${u.login}`,
    avatar_url: `https://avatars.example.invalid/${u.id}`,
  });

  function tipOf(repoKey: string, branch: string): string | undefined {
    return repoOf(repoKey)?.refs.get(`heads/${branch}`);
  }

  function chain(from: string, stop: string): string[] {
    const out: string[] = [];
    let cur: string | undefined = from;
    while (cur && cur !== stop && out.length < 300) {
      out.push(cur);
      cur = commits.get(cur)?.parents[0];
    }
    return out;
  }

  function filesOf(pr: WorldPr): FakeFile[] {
    const head = tipOf(pr.headRepo, pr.headRef);
    if (!head) return [];
    const base = treeOf(pr.mergeBase);
    const cur = treeOf(head);
    const out: FakeFile[] = [];
    for (const path of [...new Set([...base.keys(), ...cur.keys()])].sort()) {
      const was = base.get(path);
      const now = cur.get(path);
      if (was === now) continue;
      const oldText = was === undefined ? "" : (blobs.get(was) ?? "");
      const newText = now === undefined ? "" : (blobs.get(now) ?? "");
      const d = makePatch(oldText, newText);
      out.push({
        filename: path,
        status: was === undefined ? "added" : now === undefined ? "removed" : "modified",
        additions: d.additions,
        deletions: d.deletions,
        changes: d.additions + d.deletions,
        patch: d.patch,
        sha: now ?? was ?? ZERO,
      });
    }
    return out;
  }

  const merged = new Set<number>();

  /** Rebuilds the fake API's view of a PR from the world's state. */
  function syncPr(pr: WorldPr): FakePull {
    const head = tipOf(pr.headRepo, pr.headRef) ?? ZERO;
    const files = filesOf(pr);
    const list = chain(head, pr.mergeBase).reverse();
    state.files.set(pr.number, files);
    state.commits.set(
      pr.number,
      list.map((sha) => ({ sha, commit: { message: commits.get(sha)?.message ?? "" } })),
    );
    if (!state.timelines.has(pr.number)) state.timelines.set(pr.number, []);
    const headRepo = repoOf(pr.headRepo) as WorldRepo;
    const pull = {
      number: pr.number,
      node_id: pr.nodeId,
      html_url: `https://github.com/${opts.owner}/${opts.repo}/pull/${pr.number}`,
      state: pr.state,
      merged: merged.has(pr.number),
      merge_commit_sha: null,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      closed_at: pr.closedAt,
      merged_at: null,
      body: pr.body,
      title: pr.title,
      changed_files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      draft: pr.draft,
      commits: list.length,
      user: { id: pr.author.id, login: pr.author.login, type: "User" },
      labels: pr.labels.map((name) => ({ name })),
      head: {
        sha: head,
        ref: pr.headRef,
        label: `${headRepo.owner}:${pr.headRef}`,
        repo: { id: headRepo.id, full_name: `${headRepo.owner}/${headRepo.name}` },
      },
      base: {
        ref: pr.baseRef,
        sha: pr.baseSha,
        label: `${opts.owner}:${pr.baseRef}`,
        repo: {
          id: repoId,
          full_name: `${opts.owner}/${opts.repo}`,
          private: opts.private,
          default_branch: "main",
        },
      },
    } as unknown as FakePull;
    state.pulls.set(pr.number, pull);
    state.issues.set(pr.number, {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      pull_request: { url: `https://api.github.com/pulls/${pr.number}` },
    });
    return pull;
  }

  const touch = (pr: WorldPr) => {
    pr.updatedAt = iso();
  };

  // ---- webhooks ----------------------------------------------------------------------------
  async function send(
    event: string,
    body: Record<string, unknown>,
    guid: string = randomUUID(),
    redelivery = false,
  ) {
    const full = {
      ...body,
      repository: repoPayload(repoOf(sandboxKey) as WorldRepo),
      installation: { id: opts.installationId, node_id: `I_${opts.installationId}` },
    };
    const id = nextDeliveryId++;
    const delivery: Delivery = {
      id,
      guid,
      event,
      action: typeof body.action === "string" ? body.action : null,
      deliveredAt: iso(),
      redelivery,
      statusCode: 0,
      body: full,
    };
    deliveries.push(delivery);
    delivery.statusCode = await opts.deliver(event, full, guid);
    return delivery;
  }

  const pullPayload = (pr: WorldPr) => syncPr(pr);

  async function emitPr(
    action: string,
    pr: WorldPr,
    extra: Record<string, unknown> = {},
    sender?: WorldUser,
  ) {
    touch(pr);
    const pull = pullPayload(pr);
    await send("pull_request", {
      action,
      number: pr.number,
      pull_request: pull,
      sender: userPayload(sender ?? pr.author),
      ...extra,
    });
  }

  function pathsChanged(sha: string): { added: string[]; modified: string[]; removed: string[] } {
    const c = commits.get(sha);
    const parent = c?.parents[0];
    const was = parent ? treeOf(parent) : new Map<string, string>();
    const now = treeOf(sha);
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [p, b] of now) {
      if (!was.has(p)) added.push(p);
      else if (was.get(p) !== b) modified.push(p);
    }
    for (const p of was.keys()) if (!now.has(p)) removed.push(p);
    return { added, modified, removed };
  }

  async function emitPush(
    r: WorldRepo,
    branch: string,
    before: string,
    after: string,
    forced: boolean,
    deleted = false,
  ) {
    if (`${r.owner}/${r.name}`.toLowerCase() !== sandboxKey) return;
    let list: string[];
    if (deleted) list = [];
    else if (before === ZERO) list = chain(after, tipOf(sandboxKey, "main") ?? "").reverse();
    else if (ancestorOf(before, after)) list = chain(after, before).reverse();
    else list = [after];
    const listed = list.slice(-20);
    const pusher = tokenUser("pusher");
    await send("push", {
      ref: `refs/heads/${branch}`,
      before,
      after,
      created: before === ZERO,
      deleted,
      forced,
      commits: listed.map((sha) => ({
        id: sha,
        message: commits.get(sha)?.message ?? "",
        ...pathsChanged(sha),
      })),
      head_commit: deleted ? null : { id: after, message: commits.get(after)?.message ?? "" },
      pusher: { name: pusher.login },
      sender: userPayload(pusher),
    });
    if (deleted) return;
    // GitHub also sends `synchronize` for open PRs whose head moved.
    for (const pr of prs.values()) {
      if (
        pr.state === "open" &&
        pr.headRef === branch &&
        pr.headRepo === `${r.owner}/${r.name}`.toLowerCase()
      ) {
        await emitPr("synchronize", pr, { before, after }, pusher);
      }
    }
  }

  let currentUser: WorldUser = opts.users.actor;
  const tokenUser = (_why: string) => currentUser;

  function ancestorOf(maybe: string, tip: string): boolean {
    let cur: string | undefined = tip;
    for (let i = 0; cur && i < 500; i++) {
      if (cur === maybe) return true;
      cur = commits.get(cur)?.parents[0];
    }
    return false;
  }

  // ---- markdown -> html (approximate) ------------------------------------------------------
  function renderHtml(markdown: string): string {
    const out: string[] = [];
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const alert = /^> \[!(IMPORTANT|WARNING|NOTE)\]$/.exec(line);
      if (alert) {
        const kind = (alert[1] as string).toLowerCase();
        const body: string[] = [];
        while (i + 1 < lines.length && (lines[i + 1] as string).startsWith("> ")) {
          body.push((lines[++i] as string).slice(2));
        }
        out.push(
          `<div class="markdown-alert markdown-alert-${kind}"><p class="markdown-alert-title">${kind}</p><p>${inline(body.join(" "))}</p></div>`,
        );
        continue;
      }
      out.push(`<p>${inline(line)}</p>`);
    }
    return out.join("\n");
  }
  function inline(text: string): string {
    const parts = text.split(/(`[^`]*`)/);
    return parts
      .map((p) => {
        if (p.startsWith("`") && p.endsWith("`") && p.length >= 2)
          return `<code>${escapeHtml(p.slice(1, -1))}</code>`;
        let h = escapeHtml(p);
        h = h.replace(/@([A-Za-z0-9-]+)\/([A-Za-z0-9_-]+)/g, (m, org: string) =>
          org.toLowerCase() === opts.owner.toLowerCase()
            ? `<a class="team-mention" href="/orgs/${org}">${m}</a>`
            : m,
        );
        h = h.replace(/(^|[^\w/])@([A-Za-z0-9-]+)/g, (m, pre: string, login: string) =>
          users.has(login.toLowerCase())
            ? `${pre}<a class="user-mention notranslate" href="/${login}">@${login}</a>`
            : m,
        );
        h = h.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
        return h;
      })
      .join("");
  }

  // ---- the HTTP surface --------------------------------------------------------------------
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const notFound = () => json(404, { message: "Not Found" });

  const sandboxExists = () => repoOf(sandboxKey) !== undefined;

  function visibleTo(user: WorldUser | "app" | "bot" | null, r: WorldRepo): boolean {
    if (!r.private) return true;
    if (user === "app" || user === "bot") return true;
    if (!user) return false;
    if (user.id === opts.users.actor.id) return true;
    if (r.owner.toLowerCase() === user.login.toLowerCase()) return true;
    return collaborators.get(user.login.toLowerCase()) === "accepted";
  }

  type Who = WorldUser | "app" | "bot" | null | "invalid";
  function whoIs(authorization: string | null): Who {
    if (!authorization) return null;
    const m = /^(?:token|bearer)\s+(\S+)$/i.exec(authorization.trim());
    if (!m) return "invalid";
    const token = m[1] as string;
    const u = tokenOwner.get(token);
    if (u) return u;
    if (token.startsWith("ghs_")) return "bot";
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return "app";
    return "invalid";
  }

  async function handle(
    method: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    headers: Headers,
  ): Promise<Response | null> {
    const path = url.pathname;
    const who = whoIs(headers.get("authorization"));
    if (who === "invalid") return json(401, { message: "Bad credentials" });
    const actor: WorldUser | null = who !== "app" && who !== "bot" && who !== null ? who : null;
    if (actor) currentUser = actor;
    const wantsHtml = /vnd\.github(\.v3)?\.full/.test(headers.get("accept") ?? "");
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/user") {
      return actor
        ? json(200, userPayload(actor))
        : json(401, { message: "Requires authentication" });
    }
    if (method === "POST" && path === "/user/repos") {
      if (!actor) return json(401, { message: "Requires authentication" });
      if (repoOf(`${actor.login}/${body?.name}`))
        return json(422, { message: "name already exists on this account" });
      const r = createRepo(actor.login, String(body?.name), body?.private === true);
      // A test can make GitHub answer under another name (GitHub normalises or renames).
      return json(201, {
        ...repoPayload(r),
        ...(world.createdAs ? { full_name: world.createdAs } : {}),
      });
    }
    if (method === "POST" && path === "/graphql") {
      const vars = (body?.variables ?? {}) as { pullRequestId?: string };
      const pr = [...prs.values()].find((p) => p.nodeId === vars.pullRequestId);
      if (!pr) return json(200, { errors: [{ message: "Could not resolve to a node" }] });
      pr.draft = false;
      state.timelines.get(pr.number)?.push({
        event: "ready_for_review",
        created_at: iso(),
        actor: userPayload(actor ?? opts.users.actor),
      });
      await emitPr("ready_for_review", pr, {}, actor ?? opts.users.actor);
      return json(200, {
        data: { markPullRequestReadyForReview: { pullRequest: { id: pr.nodeId } } },
      });
    }
    // The App's own endpoints.
    if (path.startsWith("/app/")) {
      if (who !== "app") return json(401, { message: "A JSON web token could not be decoded" });
      m = /^\/app\/installations\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        if (Number(m[1]) !== opts.installationId) return notFound();
        return json(200, {
          id: opts.installationId,
          repository_selection: world.installation.selection,
          permissions: manifest.default_permissions,
          events: manifest.default_events,
          account: userPayload(opts.users.actor),
        });
      }
      if (method === "GET" && path === "/app/hook/deliveries") {
        const list = [...deliveries]
          .reverse()
          .slice(0, Number(url.searchParams.get("per_page") ?? 30))
          .map((d) => ({
            id: d.id,
            guid: d.guid,
            delivered_at: d.deliveredAt,
            redelivery: d.redelivery,
            duration: 0.1,
            status: d.statusCode < 300 ? "OK" : "Error",
            status_code: d.statusCode,
            event: d.event,
            action: d.action,
            installation_id: opts.installationId,
            repository_id: repoId,
            throttled_at: null,
          }));
        return json(200, list);
      }
      m = /^\/app\/hook\/deliveries\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        const d = deliveries.find((x) => x.id === Number(m?.[1]));
        if (!d) return notFound();
        return json(200, {
          id: d.id,
          guid: d.guid,
          event: d.event,
          action: d.action,
          redelivery: d.redelivery,
          status_code: d.statusCode,
          delivered_at: d.deliveredAt,
          request: {
            headers: {
              "X-GitHub-Event": d.event,
              "X-GitHub-Delivery": d.guid,
              "X-Hub-Signature-256": "sha256=redacted",
              "X-GitHub-Hook-Installation-Target-ID": String(opts.appId),
              "X-GitHub-Hook-Installation-Target-Type": "integration",
            },
            payload: d.body,
          },
          response: { headers: {}, payload: null },
        });
      }
      m = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(path);
      if (method === "POST" && m) {
        const d = deliveries.find((x) => x.id === Number(m?.[1]));
        if (!d) return notFound();
        // The redelivery re-sends the same body under the same guid.
        const body2 = d.body as Record<string, unknown>;
        const id = nextDeliveryId++;
        const attempt: Delivery = { ...d, id, redelivery: true, deliveredAt: iso(), statusCode: 0 };
        deliveries.push(attempt);
        attempt.statusCode = await opts.deliver(d.event, body2, d.guid);
        return json(202, {});
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
      return notFound();
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (method === "GET" && m) {
      if (who !== "app") return json(401, { message: "A JSON web token could not be decoded" });
      return `${m[1]}/${m[2]}`.toLowerCase() === sandboxKey && sandboxExists() && world.installed
        ? json(200, { id: opts.installationId })
        : notFound();
    }

    if (method === "GET" && path === "/installation/repositories") {
      if (who !== "bot") return json(401, { message: "Requires an installation token" });
      const list = [
        { id: repoId, full_name: `${opts.owner}/${opts.repo}` },
        ...world.installation.extraRepos,
      ];
      return json(200, { total_count: list.length, repositories: list });
    }

    // Read-only source repository.
    if (opts.readOnlyRepo) {
      const src = opts.readOnlyRepo.toLowerCase();
      if (path.toLowerCase() === `/repos/${src}` && method === "GET") {
        return json(200, {
          id: 1,
          full_name: opts.readOnlyRepo,
          private: false,
          default_branch: "main",
        });
      }
      if (path.toLowerCase().startsWith(`/repos/${src}/`)) {
        if (method === "GET" && path.toLowerCase() === `/repos/${src}/pulls`) return json(200, []);
        return notFound();
      }
    }

    // Repository-level routes.
    m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return null;
    const owner = decodeURIComponent(m[1] as string);
    const name = decodeURIComponent(m[2] as string);
    const rest = m[3] ?? "";
    const key = `${owner}/${name}`.toLowerCase();
    const repoRec = repoOf(key);
    if (!repoRec) return notFound();
    if (!visibleTo(who as WorldUser | "app" | "bot" | null, repoRec)) return notFound();
    const isSandbox = key === sandboxKey;
    const is = (meth: string, re: RegExp): RegExpExecArray | null =>
      method === meth ? re.exec(rest) : null;

    if (rest === "" && method === "GET") {
      const parent = repoRec.parent ? repoOf(repoRec.parent) : undefined;
      return json(200, {
        ...repoPayload(repoRec),
        ...(world.answersAs && isSandbox ? { full_name: world.answersAs } : {}),
        ...(parent ? { parent: { full_name: `${parent.owner}/${parent.name}` } } : {}),
        permissions: { admin: actor?.id === opts.users.actor.id },
      });
    }

    // git data (any repo of the world: sandbox and forks)
    if (is("POST", /^\/git\/blobs$/)) {
      const content = String(body?.content ?? "");
      const sha = putBlob(
        body?.encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content,
      );
      return json(201, { sha });
    }
    if (is("POST", /^\/git\/trees$/)) {
      const baseTree = typeof body?.base_tree === "string" ? trees.get(body.base_tree) : undefined;
      const entries = new Map(baseTree ?? []);
      for (const e of (body?.tree ?? []) as { path: string; sha: string | null }[]) {
        if (e.sha === null) entries.delete(e.path);
        else entries.set(e.path, e.sha);
      }
      return json(201, { sha: putTree(entries) });
    }
    if (is("POST", /^\/git\/commits$/)) {
      const author = (body?.author ?? { name: "x", email: "x@x", date: iso() }) as Commit["author"];
      const sha = putCommit({
        tree: String(body?.tree),
        parents: (body?.parents ?? []) as string[],
        message: String(body?.message ?? ""),
        author,
      });
      return json(201, {
        sha,
        tree: { sha: String(body?.tree) },
        parents: ((body?.parents ?? []) as string[]).map((p) => ({ sha: p })),
      });
    }
    m = is("GET", /^\/git\/commits\/([0-9a-f]{40})$/);
    if (m) {
      const c = commits.get(m[1] as string);
      return c
        ? json(200, {
            sha: m[1],
            message: c.message,
            tree: { sha: c.tree },
            parents: c.parents.map((p) => ({ sha: p })),
            author: c.author,
          })
        : notFound();
    }
    m = is("GET", /^\/git\/ref\/(?:heads(?:\/|%2F))(.+)$/i);
    if (m) {
      const branch = decodeURIComponent(m[1] as string);
      const sha = repoRec.refs.get(`heads/${branch}`);
      return sha
        ? json(200, { ref: `refs/heads/${branch}`, object: { type: "commit", sha } })
        : notFound();
    }
    m = is("GET", /^\/git\/matching-refs\/(.+)$/);
    if (m) {
      const prefix = decodeURIComponent(m[1] as string);
      const list = [...repoRec.refs]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([ref, sha]) => ({ ref: `refs/${ref}`, object: { type: "commit", sha } }));
      return json(200, list);
    }
    if (is("POST", /^\/git\/refs$/)) {
      const full = String(body?.ref);
      const ref = full.replace(/^refs\//, "");
      if (repoRec.refs.has(ref)) return json(422, { message: "Reference already exists" });
      const sha = String(body?.sha);
      if (!commits.has(sha)) return json(422, { message: "Object does not exist" });
      repoRec.refs.set(ref, sha);
      if (isSandbox && ref.startsWith("heads/")) state.branches.set(ref.slice(6), sha);
      if (ref.startsWith("heads/")) await emitPush(repoRec, ref.slice(6), ZERO, sha, false);
      return json(201, { ref: full, object: { sha } });
    }
    m = is("PATCH", /^\/git\/refs\/(.+)$/);
    if (m) {
      const ref = decodeURIComponent(m[1] as string);
      const before = repoRec.refs.get(ref);
      if (!before) return notFound();
      const sha = String(body?.sha);
      if (!commits.has(sha)) return json(422, { message: "Object does not exist" });
      const fastForward = ancestorOf(before, sha);
      if (!fastForward && body?.force !== true)
        return json(422, { message: "Update is not a fast forward" });
      repoRec.refs.set(ref, sha);
      if (isSandbox && ref.startsWith("heads/")) state.branches.set(ref.slice(6), sha);
      if (ref.startsWith("heads/"))
        await emitPush(repoRec, ref.slice(6), before, sha, !fastForward);
      return json(200, { ref: `refs/${ref}`, object: { sha } });
    }
    m = is("DELETE", /^\/git\/refs\/(.+)$/);
    if (m) {
      const ref = decodeURIComponent(m[1] as string);
      const before = repoRec.refs.get(ref);
      if (!before) return notFound();
      repoRec.refs.delete(ref);
      if (isSandbox && ref.startsWith("heads/")) state.branches.delete(ref.slice(6));
      if (ref.startsWith("heads/"))
        await emitPush(repoRec, ref.slice(6), before, ZERO, false, true);
      return new Response(null, { status: 204 });
    }

    // contents from the git store (a commit sha or a branch name as `ref`)
    m = is("GET", /^\/contents\/(.+)$/);
    if (m) {
      const ref = url.searchParams.get("ref") ?? "main";
      const commit = commits.has(ref) ? ref : repoRec.refs.get(`heads/${ref}`);
      if (commit) {
        const text = fileAt(commit, decodeURIComponent(m[1] as string));
        if (text === null) return notFound();
        const bytes = Buffer.from(text);
        return json(200, {
          type: "file",
          name: (m[1] as string).split("/").pop(),
          path: decodeURIComponent(m[1] as string),
          encoding: "base64",
          size: bytes.byteLength,
          content: bytes.toString("base64"),
          sha: sha1(text),
        });
      }
    }

    if (is("POST", /^\/forks$/)) {
      if (!actor) return json(401, { message: "Requires authentication" });
      const fork = createRepo(actor.login, repoRec.name, repoRec.private, key);
      for (const [ref, sha] of repoRec.refs) fork.refs.set(ref, sha);
      return json(202, repoPayload(fork));
    }
    if (is("POST", /^\/merge-upstream$/)) {
      const parent = repoRec.parent ? repoOf(repoRec.parent) : undefined;
      if (!parent) return json(422, { message: "not a fork" });
      const branch = String(body?.branch ?? "main");
      repoRec.refs.set(`heads/${branch}`, parent.refs.get(`heads/${branch}`) ?? ZERO);
      return json(200, {
        merge_type: "fast-forward",
        message: "Successfully fetched and fast-forwarded",
        base_branch: branch,
      });
    }

    if (!isSandbox) return notFound();

    // ---- sandbox-only routes -------------------------------------------------------------
    m = is("PUT", /^\/collaborators\/([^/]+)$/);
    if (m) {
      const login = decodeURIComponent(m[1] as string).toLowerCase();
      if (!users.has(login)) return notFound();
      if (collaborators.get(login) === "accepted") return new Response(null, { status: 204 });
      collaborators.set(login, "pending");
      return json(201, {
        id: 1,
        html_url: `https://github.com/${opts.owner}/${opts.repo}/invitations`,
      });
    }
    if (is("PUT", /^\/actions\/permissions$/)) {
      actionsEnabled = body?.enabled !== false;
      return new Response(null, { status: 204 });
    }
    if (is("GET", /^\/actions\/permissions$/)) return json(200, { enabled: actionsEnabled });
    m = is("GET", /^\/labels\/([^/]+)$/);
    if (m)
      return labels.has(decodeURIComponent(m[1] as string))
        ? json(200, { name: m[1] })
        : notFound();
    if (is("POST", /^\/labels$/)) {
      labels.add(String(body?.name));
      return json(201, { name: body?.name });
    }
    if (is("GET", /^\/issues$/)) {
      const want = url.searchParams.get("labels");
      const st = url.searchParams.get("state") ?? "open";
      const list = [...issueRegistry.values()]
        .filter((i) => (st === "all" || i.state === st) && (!want || i.labels.includes(want)))
        .map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels.map((l) => ({ name: l })),
          ...(prs.has(i.number)
            ? { pull_request: { url: `https://api.github.com/pulls/${i.number}` } }
            : {}),
        }));
      return json(200, list);
    }
    if (is("POST", /^\/issues$/)) {
      if (!actor) return json(401, { message: "Requires authentication" });
      const number = nextNumber++;
      issueRegistry.set(number, {
        number,
        title: String(body?.title),
        state: "open",
        labels: ((body?.labels ?? []) as string[]).slice(),
      });
      state.issues.set(number, {
        number,
        title: String(body?.title),
        body: (body?.body as string) ?? null,
        state: "open",
      });
      return json(201, { number, title: body?.title, state: "open" });
    }
    m = is("PATCH", /^\/issues\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      const rec = issueRegistry.get(n);
      if (!rec) return notFound();
      if (typeof body?.state === "string") {
        rec.state = body.state as "open" | "closed";
        const pr = prs.get(n);
        if (pr) {
          pr.state = rec.state;
          if (rec.state === "closed") pr.closedAt = iso();
          await emitPr(
            rec.state === "closed" ? "closed" : "reopened",
            pr,
            {},
            actor ?? opts.users.actor,
          );
        }
      }
      return json(200, { number: n, state: rec.state });
    }
    m = is("POST", /^\/issues\/(\d+)\/labels$/);
    if (m) {
      const n = Number(m[1]);
      const rec = issueRegistry.get(n);
      if (!rec) return notFound();
      const added = ((body?.labels ?? []) as string[]).filter((l) => !rec.labels.includes(l));
      rec.labels.push(...added);
      // The issue events API records who labelled (Phase 1 step 3, D2), oldest first.
      const who = actor ?? opts.users.actor;
      const log = state.issueEvents.get(n) ?? [];
      for (const l of added) {
        log.push({
          id: state.nextId++,
          event: "labeled",
          actor: { id: who.id, login: who.login, type: "User" },
          label: { name: l, color: "ededed" },
          created_at: iso(),
        });
      }
      state.issueEvents.set(n, log);
      const pr = prs.get(n);
      if (pr) {
        pr.labels = rec.labels.slice();
        for (const l of added) {
          await emitPr(
            "labeled",
            pr,
            { label: { name: l, color: "ededed", id: 1, node_id: "L_1", default: false } },
            actor ?? opts.users.actor,
          );
        }
      }
      return json(
        200,
        rec.labels.map((l) => ({ name: l })),
      );
    }
    m = is("POST", /^\/issues\/comments\/(\d+)\/reactions$/);
    if (m) {
      if (!actor) return json(401, { message: "Requires authentication" });
      const id = Number(m[1]);
      if (!state.comments.some((c) => c.id === id)) return notFound();
      const list = state.reactions.get(id) ?? [];
      const content = String(body?.content);
      const existing = list.find((r) => r.user?.id === actor.id && r.content === content);
      if (existing) return json(200, existing);
      const reaction = {
        id: nextReactionId++,
        content,
        created_at: iso(),
        user: { id: actor.id, login: actor.login, type: "User" },
      };
      state.reactions.set(id, [...list, reaction]);
      return json(201, reaction);
    }
    if (is("POST", /^\/pulls$/)) {
      if (!actor) return json(401, { message: "Requires authentication" });
      const headSpec = String(body?.head);
      const [headOwner, headRef] = headSpec.includes(":")
        ? (headSpec.split(":") as [string, string])
        : [opts.owner, headSpec];
      const headKey = `${headOwner}/${opts.repo}`.toLowerCase();
      const headTip = tipOf(headKey, headRef);
      if (!headTip) return json(422, { message: "Validation Failed: head does not exist" });
      const baseRef = String(body?.base ?? "main");
      const baseTip = tipOf(sandboxKey, baseRef) ?? ZERO;
      const number = nextNumber++;
      const pr: WorldPr = {
        number,
        nodeId: `PR_${number}_${sha1(String(number)).slice(0, 8)}`,
        author: actor,
        headRepo: headKey,
        headRef,
        baseRef,
        mergeBase: baseTip,
        baseSha: baseTip,
        title: String(body?.title),
        body: typeof body?.body === "string" ? body.body : null,
        draft: body?.draft === true,
        state: "open",
        labels: [],
        createdAt: iso(),
        updatedAt: iso(),
        closedAt: null,
      };
      prs.set(number, pr);
      issueRegistry.set(number, { number, title: pr.title, state: "open", labels: [] });
      const pull = syncPr(pr);
      await emitPr("opened", pr, {}, actor);
      return json(201, pull);
    }
    m = is("PATCH", /^\/pulls\/(\d+)$/);
    if (m) {
      const pr = prs.get(Number(m[1]));
      if (!pr) return notFound();
      if (typeof body?.state === "string") {
        pr.state = body.state as "open" | "closed";
        pr.closedAt = pr.state === "closed" ? iso() : null;
        const rec = issueRegistry.get(pr.number);
        if (rec) rec.state = pr.state;
        await emitPr(
          pr.state === "closed" ? "closed" : "reopened",
          pr,
          {},
          actor ?? opts.users.actor,
        );
      }
      return json(200, syncPr(pr));
    }
    m = is("POST", /^\/pulls\/(\d+)\/requested_reviewers$/);
    if (m) {
      const pr = prs.get(Number(m[1]));
      if (!pr || !actor) return notFound();
      if (actor.id !== pr.author.id && actor.id !== opts.users.actor.id)
        return json(403, { message: "Must have write access" });
      const cur = state.requestedReviewers.get(pr.number) ?? { users: [], teams: [] };
      for (const login of (body?.reviewers ?? []) as string[]) {
        const u = users.get(login.toLowerCase());
        if (!u) return json(422, { message: "Reviews may only be requested from collaborators" });
        if (!cur.users.some((x) => x.id === u.id))
          cur.users.push({ id: u.id, login: u.login, type: "User" });
        state.timelines.get(pr.number)?.push({
          event: "review_requested",
          created_at: iso(),
          review_requester: userPayload(actor),
          requested_reviewer: userPayload(u),
        });
        state.requestedReviewers.set(pr.number, cur);
        await emitPr("review_requested", pr, { requested_reviewer: userPayload(u) }, actor);
      }
      return json(201, syncPr(pr));
    }
    m = is("POST", /^\/pulls\/(\d+)\/reviews$/);
    if (m) {
      const pr = prs.get(Number(m[1]));
      if (!pr || !actor) return notFound();
      const event = String(body?.event ?? "COMMENT");
      if (event === "COMMENT" && !body?.body)
        return json(422, { message: "Review body is required" });
      const stateName =
        event === "APPROVE"
          ? "APPROVED"
          : event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED";
      const head = tipOf(pr.headRepo, pr.headRef) ?? ZERO;
      const review: FakeReview = {
        id: nextReviewId++,
        user: { id: actor.id, login: actor.login, type: "User" },
        state: stateName,
        commit_id: head,
        submitted_at: iso(),
        author_association:
          actor.id === opts.users.actor.id
            ? "OWNER"
            : collaborators.get(actor.login.toLowerCase()) === "accepted"
              ? "COLLABORATOR"
              : "NONE",
      };
      const list = state.reviews.get(pr.number) ?? [];
      state.reviews.set(pr.number, [...list, review]);
      // A review answers the request.
      const req = state.requestedReviewers.get(pr.number);
      if (req) req.users = req.users.filter((u) => u.id !== actor.id);
      state.timelines.get(pr.number)?.push({
        event: "reviewed",
        submitted_at: review.submitted_at,
        user: userPayload(actor),
        state: stateName.toLowerCase(),
        commit_id: head,
      });
      touch(pr);
      await send("pull_request_review", {
        action: "submitted",
        review: {
          ...review,
          // Webhook payloads spell the state in lower case; the REST API in upper case.
          state: stateName.toLowerCase(),
          node_id: `PRR_${review.id}`,
          body: (body?.body as string) ?? null,
          html_url: "https://github.com/x",
          pull_request_url: "https://api.github.com/x",
          _links: {},
        },
        pull_request: syncPr(pr),
        sender: userPayload(actor),
      });
      return json(200, review);
    }

    // comments: timestamps and html on top of the fake
    m = is("POST", /^\/issues\/(\d+)\/comments$/);
    if (m && (who === "bot" || actor)) {
      const res = await api.fetch(url.toString(), {
        method,
        body: JSON.stringify(body ?? {}),
        headers: { "content-type": "application/json" },
      });
      const created = (await res.clone().json()) as { id?: number };
      const c = state.comments.find((x) => x.id === created.id);
      if (c) {
        c.created_at = iso();
        c.updated_at = c.created_at;
        Object.assign(c.user, { id: BOT.id });
      }
      return json(res.status, c ?? created);
    }
    m = is("PATCH", /^\/issues\/comments\/(\d+)$/);
    if (m) {
      const res = await api.fetch(url.toString(), {
        method,
        body: JSON.stringify(body ?? {}),
        headers: { "content-type": "application/json" },
      });
      const c = state.comments.find((x) => x.id === Number(m?.[1]));
      if (c) c.updated_at = iso();
      return json(res.status, c ?? (await res.json()));
    }
    if (is("GET", /^\/issues\/(\d+)\/comments$/) || is("GET", /^\/issues\/comments\/(\d+)$/)) {
      const res = await api.fetch(url.toString(), { method, headers: {} });
      if (!wantsHtml || res.status !== 200) return res;
      const data = (await res.json()) as unknown;
      const addHtml = (c: Record<string, unknown>) => ({
        ...c,
        body_html: renderHtml(String(c.body ?? "")),
      });
      const out = Array.isArray(data)
        ? data.map(addHtml)
        : addHtml(data as Record<string, unknown>);
      return json(200, out, { link: res.headers.get("link") ?? "" });
    }
    m = is("GET", /^\/pulls\/(\d+)$/);
    if (m && wantsHtml) {
      const pr = prs.get(Number(m[1]));
      if (!pr) return notFound();
      return json(200, { ...syncPr(pr), body_html: renderHtml(pr.body ?? "") });
    }
    m = is("GET", /^\/pulls\/(\d+)$/);
    if (m) {
      const pr = prs.get(Number(m[1]));
      if (pr) syncPr(pr);
    }
    if (is("GET", /^\/pulls$/)) for (const pr of prs.values()) syncPr(pr);
    // check runs: completed_at and the test hook
    m = is("GET", /^\/commits\/([^/]+)\/check-runs$/);
    if (m) {
      const res = await api.fetch(url.toString(), { method, headers: {} });
      const data = (await res.json()) as { total_count: number; check_runs: FakeCheckRun[] };
      const hook = world.rewriteCheckConclusion;
      return json(200, {
        ...data,
        check_runs: data.check_runs.map((r) => {
          const override = hook ? hook(r) : undefined;
          return override === undefined ? r : { ...r, conclusion: override };
        }),
      });
    }
    if (is("POST", /^\/check-runs$/) || is("PATCH", /^\/check-runs\/(\d+)$/)) {
      const res = await api.fetch(url.toString(), {
        method,
        body: JSON.stringify(body ?? {}),
        headers: { "content-type": "application/json" },
      });
      const data = (await res.clone().json()) as { id?: number };
      const run = state.checkRuns.find((r) => r.id === data.id);
      if (run && run.status === "completed" && !run.completed_at) run.completed_at = iso();
      return json(res.status, run ?? data);
    }
    return null;
  }

  const issueRegistry = new Map<
    number,
    { number: number; title: string; state: "open" | "closed"; labels: string[] }
  >();

  /** Real responses carry their url (Octokit's paginate reads it); the fake adds it. */
  const withUrl = (res: Response, url: URL): Response => {
    if (!res.url) Object.defineProperty(res, "url", { value: url.toString() });
    const rl = state.rateLimit;
    if (rl && !res.headers.has("x-ratelimit-limit")) {
      rl.remaining = Math.max(rl.remaining - 1, 0);
      res.headers.set("x-ratelimit-limit", String(rl.limit));
      res.headers.set("x-ratelimit-remaining", String(rl.remaining));
      res.headers.set("x-ratelimit-reset", String(rl.reset));
    }
    return res;
  };

  const dispatch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? req?.headers);
    const raw = init?.body ?? (req ? await req.text() : undefined);
    const body =
      typeof raw === "string" && raw.length > 0
        ? (JSON.parse(raw) as Record<string, unknown>)
        : undefined;
    log.push({ method, path: url.pathname, who: "" });
    // The access-token endpoint belongs to the App (JWT), served by the base fake.
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return api.fetch(input, init);
    }
    const res = await handle(method, url, body, headers);
    if (res) return res;
    // Fall through to the base fake (Graft's reads and writes). Graft's token is a bot token.
    const who = whoIs(headers.get("authorization"));
    if (who === "invalid") return json(401, { message: "Bad credentials" });
    const passthrough = await api.fetch(url.toString(), {
      method,
      headers: Object.fromEntries(headers),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return passthrough;
  };

  const world = {
    api: api as FakeGitHubApi,
    state,
    /** The fetch every client of the test shares. */
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await dispatch(input, init);
      return withUrl(res, new URL(input instanceof Request ? input.url : String(input)));
    }) as typeof fetch,
    users,
    log,
    /** Replaces a conclusion in check-run listings (a test hook). */
    rewriteCheckConclusion: null as null | ((run: FakeCheckRun) => string | undefined),
    seedMain,
    /** What the App's installation covers (a test can widen it). */
    installation: { selection: "selected", extraRepos: [] as { id: number; full_name: string }[] },
    /** Makes `GET /repos/{sandbox}` answer under another full name (a rename or a transfer). */
    answersAs: null as string | null,
    /** Makes `POST /user/repos` answer under another full name. */
    createdAs: null as string | null,
    /** false: the App is not installed on the sandbox (`GET /repos/{o}/{r}/installation` is 404). */
    installed: true,
    /** Adds `n` open pull requests that carry the `graft-e2e` label, without any webhook. */
    addOpenRunPrs(n: number) {
      for (let i = 0; i < n; i++) {
        const number = nextNumber++;
        prs.set(number, {
          number,
          nodeId: `PR_bulk_${number}`,
          author: opts.users.actor,
          headRepo: sandboxKey,
          headRef: `graft-e2e/bulk/${number}`,
          baseRef: "main",
          mergeBase: tipOf(sandboxKey, "main") ?? ZERO,
          baseSha: tipOf(sandboxKey, "main") ?? ZERO,
          title: `bulk ${number}`,
          body: null,
          draft: false,
          state: "open",
          labels: ["graft-e2e"],
          createdAt: iso(),
          updatedAt: iso(),
          closedAt: null,
        });
        issueRegistry.set(number, {
          number,
          title: `bulk ${number}`,
          state: "open",
          labels: ["graft-e2e"],
        });
      }
    },
    /** The invitation is accepted in the browser. */
    acceptInvitation(login: string) {
      collaborators.set(login.toLowerCase(), "accepted");
      const u = users.get(login.toLowerCase());
      if (u) state.permissions.set(login.toLowerCase(), { id: u.id, role: "write" });
    },
    /** Click a check-run button as a user: sends `check_run.requested_action`. */
    async clickButton(user: WorldUser, checkRunId: number, identifier: string) {
      const run = state.checkRuns.find((r) => r.id === checkRunId);
      if (!run) throw new Error("no such check run");
      const pr = [...prs.values()].find(
        (p) => (tipOf(p.headRepo, p.headRef) ?? "") === run.head_sha,
      );
      await send("check_run", {
        action: "requested_action",
        check_run: {
          id: run.id,
          name: run.name,
          head_sha: run.head_sha,
          external_id: run.external_id,
          status: run.status,
          conclusion: run.conclusion,
          app: { id: opts.appId, slug: "graft" },
          pull_requests: pr ? [{ number: pr.number }] : [],
        },
        requested_action: { identifier },
        sender: userPayload(user),
      });
    },
    /** The check run with this name on the PR's current head. */
    checkRunOf(prNumber: number, name: string): FakeCheckRun | undefined {
      const pr = prs.get(prNumber);
      const head = pr ? tipOf(pr.headRepo, pr.headRef) : undefined;
      return state.checkRuns.filter((r) => r.head_sha === head && r.name === name).at(-1);
    },
    prs,
    deliveries,
    repoState: () => ({
      actionsEnabled,
      labels: [...labels],
      collaborators: new Map(collaborators),
    }),
    refs: (key = sandboxKey) => repoOf(key)?.refs,
    fileAt: (ref: string, path: string) => {
      const sha = commits.has(ref) ? ref : repoOf(sandboxKey)?.refs.get(`heads/${ref}`);
      return sha ? fileAt(sha, path) : null;
    },
    commits,
    renderHtml,
    /** Non-GET requests the world received, in order. */
    // Minting an installation token writes nothing in the repository.
    writes: () => log.filter((r) => r.method !== "GET" && !/\/access_tokens$/.test(r.path)),
    userPayload,
  };
  return world;
}

export type FakeGitHubWorld = ReturnType<typeof createFakeGitHubWorld>;
