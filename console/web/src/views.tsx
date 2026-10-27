import { useEffect, useState } from "preact/hooks";
import type {
  OverviewResponse,
  RegisterResponse,
  RegisterRow,
  SystemResponse,
} from "../../shared/api.js";
import { getJson, type Loaded, qs, useApi } from "./api.js";
import { Empty, Failure, Loading, Outcome, Risk, Verifier } from "./components.js";
import { num, pct, plural, shortRepo, when, words } from "./format.js";
import { href } from "./router.js";

const FILTERS = ["repo", "state", "risk", "verifier", "author", "pr"] as const;

export function Changes({ query, ov }: { query: URLSearchParams; ov: Loaded<OverviewResponse> }) {
  const params = Object.fromEntries(FILTERS.map((k) => [k, query.get(k) ?? undefined]));
  const base = `/api/changes${qs({ ...params, limit: 50 })}`;
  const first = useApi<RegisterResponse>(base);
  const [extra, setExtra] = useState<RegisterRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<{ loading: boolean; error?: Error }>({ loading: false });

  useEffect(() => {
    setExtra([]);
    setCursor(first.data?.nextCursor ?? null);
  }, [first.data]);

  const set = (k: string, v: string) => {
    const q = new URLSearchParams(query);
    if (v) q.set(k, v);
    else q.delete(k);
    window.location.hash = href.changes(q);
  };
  const loadMore = async () => {
    if (!cursor) return;
    setMore({ loading: true });
    try {
      const r = await getJson<RegisterResponse>(
        `/api/changes${qs({ ...params, limit: 50, cursor })}`,
      );
      setExtra((e) => [...e, ...r.rows]);
      setCursor(r.nextCursor);
      setMore({ loading: false });
    } catch (err) {
      setMore({ loading: false, error: err instanceof Error ? err : new Error(String(err)) });
    }
  };
  const rows = [...(first.data?.rows ?? []), ...extra];
  const repos = ov.data?.repositories ?? [];
  const sel = (k: (typeof FILTERS)[number], label: string, opts: [string, string][]) => (
    <label class="field" for={`f-${k}`}>
      {label}
      <select
        id={`f-${k}`}
        value={query.get(k) ?? ""}
        onChange={(e) => set(k, e.currentTarget.value)}
      >
        <option value="">any</option>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div class="register-wrap">
      <h1>Changes</h1>
      <p>
        Every pull request Graft handled, newest first: who wrote it, what the writer and the
        verifier said, the final risk class, the policy outcome and whether the guard blamed it.
        Open a row for its record.
      </p>
      <div class="toolbar">
        {sel(
          "repo",
          "Repository",
          repos.map((r) => [r.fullName, shortRepo(r.fullName)]),
        )}
        {sel("state", "State", [
          ["open", "open"],
          ["merged", "merged"],
          ["closed", "closed"],
        ])}
        {sel("risk", "Final risk", [
          ["sensitive", "sensitive"],
          ["logic", "logic"],
          ["trivial", "trivial"],
        ])}
        {sel("verifier", "Verifier", [
          ["agree", "agrees"],
          ["disagree", "disagrees"],
        ])}
        {sel("author", "Author", [
          ["agent", "agent"],
          ["human", "human"],
        ])}
        <label class="field" for="f-pr">
          PR number
          <input
            id="f-pr"
            inputMode="numeric"
            value={query.get("pr") ?? ""}
            onChange={(e) => set("pr", e.currentTarget.value.replace(/\D/g, ""))}
          />
        </label>
      </div>
      {first.error ? <Failure error={first.error} retry={first.reload} /> : null}
      {first.loading && !first.data ? <Loading /> : null}
      {first.data && rows.length === 0 ? (
        <Empty title="No pull request matches">
          <p>
            {query.toString()
              ? "Clear a filter to widen the list."
              : "Graft has not handled a pull request yet."}
          </p>
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <div class="reg-scroll">
          <table class="reg">
            <thead>
              <tr>
                <th scope="col">Pull request</th>
                <th scope="col">Author</th>
                <th scope="col">Cards</th>
                <th scope="col">Verifier</th>
                <th scope="col">Floor → final</th>
                <th scope="col">Policy</th>
                <th scope="col">Guard</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.changeId}
                  onClick={() => (window.location.hash = href.change(r.changeId))}
                >
                  <td>
                    <a href={href.change(r.changeId)}>
                      {shortRepo(r.repo)}#{r.prNumber}
                    </a>
                    <span class="sub">opened {when(r.openedAt)}</span>
                  </td>
                  <td>
                    {r.authorKind ?? "—"}
                    <span class="sub">
                      {r.model ?? (r.authorReason ? words(r.authorReason) : "not computed")}
                    </span>
                  </td>
                  <td>
                    {r.cards}
                    {r.cardStatus === "unavailable" ? (
                      <span class="sub">last not written</span>
                    ) : null}
                  </td>
                  <td>
                    {r.verifierStatus && r.cardStatus === "ok" ? (
                      <Verifier v={r.verifierStatus} />
                    ) : (
                      <span class="sub">—</span>
                    )}
                  </td>
                  <td>
                    {r.riskClass && r.riskFloor ? (
                      <>
                        {r.riskFloor} → <Risk c={r.riskClass} />
                      </>
                    ) : (
                      <span class="sub">—</span>
                    )}
                  </td>
                  <td>
                    {r.policyOutcome ? <Outcome o={r.policyOutcome} /> : <span class="sub">—</span>}
                  </td>
                  <td>{r.guardStatus ? words(r.guardStatus) : <span class="sub">—</span>}</td>
                  <td class={r.state === "merged" ? "state-merged" : "state-open"}>
                    {r.state}
                    {r.mergedAt ? <span class="sub">{when(r.mergedAt)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor ? (
            <div class="more">
              <button
                type="button"
                class="btn btn--ghost"
                disabled={more.loading}
                onClick={loadMore}
              >
                {more.loading ? "Loading…" : "Show older"}
              </button>
            </div>
          ) : null}
          {more.error ? <Failure error={more.error} retry={loadMore} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Gate({ ov }: { ov: Loaded<OverviewResponse> }) {
  if (ov.error)
    return (
      <div class="view">
        <Failure error={ov.error} retry={ov.reload} />
      </div>
    );
  if (!ov.data)
    return (
      <div class="view">
        <Loading />
      </div>
    );
  const g = ov.data.gate;
  const t = ov.data.totals;
  const eligible = g.eligibleUp + g.eligibleDown;
  return (
    <div class="view">
      <h1 class="h-digits">The Phase 0 gate</h1>
      <p>
        The gate passes when reviewers rate cards accurate often enough: the lower bound of the 95%
        Wilson interval must reach {pct(g.target)}. A vote by the pull request's own author never
        counts. This is a preview from the votes Graft stored;{" "}
        <code>pnpm graft gate report --phase 0</code> applies every rule of the gate and is the one
        to quote.
      </p>
      <div class="split">
        <section class="instr">
          <h3>Card accuracy</h3>
          <p class="big">
            {g.interval ? `${pct(g.interval.low)} – ${pct(g.interval.high)}` : "no interval"}
          </p>
          <div class="gauge">
            <div class="gauge__track">
              {g.interval ? (
                <span
                  class="gauge__mark"
                  style={{
                    left: `${g.interval.low * 100}%`,
                    width: `${Math.max(1, (g.interval.high - g.interval.low) * 100)}%`,
                  }}
                />
              ) : null}
              <span class="gauge__tick" style={{ left: `${g.target * 100}%` }} />
            </div>
            <div class="gauge__scale">
              <span>0%</span>
              <span>target {pct(g.target)}</span>
              <span>100%</span>
            </div>
          </div>
          <dl class="ledger">
            <dt>Votes recorded</dt>
            <dd>{num(g.votes)}</dd>
            <dt>Dropped: by the PR's author</dt>
            <dd>{num(g.authorVotes)}</dd>
            <dt>Eligible: accurate</dt>
            <dd>{num(g.eligibleUp)}</dd>
            <dt>Eligible: inaccurate</dt>
            <dd>{num(g.eligibleDown)}</dd>
          </dl>
          {eligible === 0 ? (
            <p>
              {g.votes > 0
                ? "Every vote so far is an author vote. A second reviewer has to react on cards before the gate can say anything."
                : "No one has voted on a card yet. Reviewers vote with a reaction on the managed comment or the check run's button."}
            </p>
          ) : null}
        </section>
        <section class="instr">
          <h3>What the models did</h3>
          <dl class="ledger">
            <dt>Cards written</dt>
            <dd>{num(t.cards - t.cardsUnavailable)}</dd>
            <dt>Verifier agreed with the writer</dt>
            <dd>
              {t.verifierJudged
                ? `${num(t.verifierAgree)} of ${num(t.verifierJudged)} (${pct(t.verifierAgree / t.verifierJudged)})`
                : "—"}
            </dd>
            <dt>A model raised the rules floor</dt>
            <dd>{num(t.raised)}</dd>
            <dt>Not written (budget)</dt>
            <dd>{num(t.cardsBudget)}</dd>
            <dt>Not written (other)</dt>
            <dd>{num(t.cardsUnavailable - t.cardsBudget)}</dd>
            <dt>Spend</dt>
            <dd>{`$${t.costUsd.toFixed(2)}`}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

function ago(s: number | null): string {
  if (s === null) return "—";
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

export function System({ ov }: { ov: Loaded<OverviewResponse> }) {
  const [hours, setHours] = useState(24);
  const { data, error, loading, reload } = useApi<SystemResponse>(`/api/system${qs({ hours })}`);
  const total = data ? data.webhooks.reduce((a, w) => a + w.count, 0) : 0;
  return (
    <section class="cabinet cabinet--page" aria-labelledby="sys-h">
      <div class="cabinet__in">
        <h2 id="sys-h">
          The machinery
          <span>Jobs, webhooks, modes and tokens</span>
        </h2>
        <div class="toolbar">
          <label class="field" for="f-hours">
            Window
            <select
              id="f-hours"
              value={String(hours)}
              onChange={(e) => setHours(Number(e.currentTarget.value))}
            >
              <option value="1">last hour</option>
              <option value="24">last 24 hours</option>
              <option value="168">last 7 days</option>
            </select>
          </label>
        </div>
        {error ? <Failure error={error} retry={reload} /> : null}
        {loading && !data ? <Loading /> : null}
        {data ? (
          <>
            <p class="cabinet__lead">
              Schema {data.schemaVersion ?? "unknown"} · console {data.console.version} · read-only
              · token budget {num(data.console.dailyTokenBudget)} per repository per UTC day
              {ov.data?.ceiling ? ` · mode ceiling ${ov.data.ceiling.value}` : ""}.
            </p>
            <div class="cabinet__grid">
              <div class="ctable-wrap">
                <h3>Jobs · {plural(data.hours, "hour")}</h3>
                {data.jobs === null ? (
                  <p class="cnote">{data.jobsUnavailable}</p>
                ) : data.jobs.length === 0 ? (
                  <p class="cnote">No job ran in this window.</p>
                ) : (
                  <table class="ctable">
                    <thead>
                      <tr>
                        <th scope="col">Job</th>
                        <th scope="col" class="r">
                          Done
                        </th>
                        <th scope="col" class="r">
                          Waiting
                        </th>
                        <th scope="col" class="r">
                          Oldest
                        </th>
                        <th scope="col" class="r">
                          Failed
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.jobs.map((j) => (
                        <tr key={j.name}>
                          <td>{j.name}</td>
                          <td class="r">{num(j.completed)}</td>
                          <td class={`r${j.waiting ? "" : " dim"}`}>{num(j.waiting + j.active)}</td>
                          <td class="r dim">{ago(j.oldestWaitingSeconds)}</td>
                          <td class={`r${j.failed ? "" : " dim"}`}>{num(j.failed)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div class="ctable-wrap">
                <h3>Webhooks · {num(total)} received</h3>
                <table class="ctable">
                  <tbody>
                    {data.webhooks.slice(0, 14).map((w) => (
                      <tr key={`${w.event}:${w.status}`}>
                        <td>
                          {w.status === "ignored" ? "Ignored · " : ""}
                          {w.event}
                          <span class="wbar">
                            <i
                              class={w.status === "ignored" ? "ign" : ""}
                              style={{ width: `${total ? (w.count / total) * 100 : 0}%` }}
                            />
                          </span>
                        </td>
                        <td class="r">{num(w.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p class="cnote">Rejected signatures and duplicates never reach this table.</p>
              </div>
              <div class="ctable-wrap">
                <h3>Repositories and modes</h3>
                <table class="ctable">
                  <thead>
                    <tr>
                      <th scope="col">Repository</th>
                      <th scope="col">Policy</th>
                      <th scope="col">Guard</th>
                      <th scope="col">MCP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(ov.data?.repositories ?? []).map((r) => (
                      <tr key={r.id}>
                        <td>
                          {shortRepo(r.fullName)}
                          {r.removed ? " (removed)" : ""}
                        </td>
                        <td>
                          <span class="mode">{r.policyMode}</span>
                        </td>
                        <td>
                          <span class="mode">{r.guardMode}</span>
                        </td>
                        <td>
                          <span class={`mode${r.mcpWrite === "off" ? " mode--off" : ""}`}>
                            {r.mcpWrite}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p class="cnote">
                  {(ov.data?.installations ?? [])
                    .map(
                      (i) =>
                        `Installation ${i.login} (${i.type.toLowerCase()}, ${i.selection} repositories)${i.suspended ? ", suspended" : ""}`,
                    )
                    .join(". ")}
                  .
                </p>
              </div>
            </div>

            <div class="cabinet__grid">
              <div class="ctable-wrap">
                <h3>Models · {plural(data.hours, "hour")}</h3>
                {data.models.length === 0 ? (
                  <p class="cnote">No card was written in this window.</p>
                ) : (
                  <table class="ctable">
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        <th scope="col" class="r">
                          Wrote
                        </th>
                        <th scope="col" class="r">
                          First pass
                        </th>
                        <th scope="col" class="r">
                          Verified
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.models.map((m) => (
                        <tr key={m.model}>
                          <td>
                            <code>{m.model}</code>
                          </td>
                          <td class={`r${m.writer ? "" : " dim"}`}>{num(m.writer)}</td>
                          <td class={`r${m.firstPass ? "" : " dim"}`}>{num(m.firstPass)}</td>
                          <td class={`r${m.verifier ? "" : " dim"}`}>{num(m.verifier)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p class="cnote">
                  As recorded on the cards. With a provider registry the part before the first{" "}
                  <code>/</code> is the provider.
                </p>
              </div>
              <div class="ctable-wrap">
                <h3>Model failures · {plural(data.hours, "hour")}</h3>
                {data.modelFailures.length === 0 ? (
                  <p class="cnote">No card or verifier failed in this window.</p>
                ) : (
                  <table class="ctable">
                    <tbody>
                      {data.modelFailures.map((f) => (
                        <tr key={`${f.kind}${f.reason}`}>
                          <td>
                            {f.kind === "card" ? "Card unavailable" : "Verifier failed"}:{" "}
                            {words(f.reason)}
                          </td>
                          <td class="r">{num(f.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div class="cabinet__grid">
              <div class="ctable-wrap">
                <h3>Mode changes</h3>
                {data.modeChanges.length === 0 ? (
                  <p class="cnote">
                    None. Modes change with <code>pnpm graft mode set</code>.
                  </p>
                ) : (
                  <table class="ctable">
                    <tbody>
                      {data.modeChanges.map((m) => (
                        <tr key={`${m.at}${m.repo}${m.key}`}>
                          <td>
                            {when(m.at)} · {shortRepo(m.repo)} · {words(m.key)} {m.from} → {m.to}
                            <span class="sub dim">
                              {" "}
                              by {m.actor}
                              {m.appliedAt ? "" : " · waiting"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div class="ctable-wrap">
                <h3>Break-glass audit</h3>
                {data.audit.length === 0 ? (
                  <p class="cnote">No break-glass label was ever acted on.</p>
                ) : (
                  <table class="ctable">
                    <tbody>
                      {data.audit.map((a) => (
                        <tr key={`${a.at}${a.prNumber}${a.kind}`}>
                          <td>
                            {when(a.at)} · {shortRepo(a.repo)}#{a.prNumber} · {a.kind}
                            {a.reason ? ` (${words(a.reason)})` : ""} · {a.actor ?? "unknown"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div class="ctable-wrap">
                <h3>MCP tokens</h3>
                {data.mcpTokens.length === 0 ? (
                  <p class="cnote">No token was ever created.</p>
                ) : (
                  <table class="ctable">
                    <tbody>
                      {data.mcpTokens.map((t) => (
                        <tr key={t.id}>
                          <td>
                            {t.name} · graft_mcp_{t.prefix}… · {shortRepo(t.repo)}
                            <span class="sub dim">
                              {" "}
                              {t.revokedAt
                                ? `revoked ${when(t.revokedAt)}`
                                : `expires ${when(t.expiresAt)}${t.lastUsedAt ? `, last used ${when(t.lastUsedAt)}` : ", never used"}`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
