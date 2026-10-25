import type { CardDetail, ChangeRecord } from "../../shared/api.js";
import { useApi } from "./api.js";
import { Cmd, Failure, Loading, Risk, Stamp, Verifier } from "./components.js";
import { hhmm, num, plural, when, words } from "./format.js";
import { href } from "./router.js";

const raisedBy = (c: CardDetail) =>
  c.riskRaisedBy
    .filter((x) => x !== "verifier_disagrees")
    .map((x) => x.replace("first_pass", "first pass"));

function stampSub(c: CardDetail): string {
  if (c.status === "unavailable") return "rules floor only";
  return c.riskClass === c.riskFloor ? "rules floor" : `raised from ${c.riskFloor}`;
}

function authorLine(r: ChangeRecord): string {
  const p = r.provenance;
  if (!p) return "not computed";
  const why: Record<string, string> = {
    trailer: "trailer",
    bot_account: "bot account",
    configured_login: "configured login",
    agent_coauthor: "agent co-author",
    none: "no agent signal",
  };
  return `${p.authorKind} · ${why[p.reason] ?? words(p.reason)}`;
}

/** The specimen record of one PR: accession label, determination slip, verdict stamp, history. */
export function RecordSheet({ r }: { r: ChangeRecord }) {
  const card = r.cards[0];
  const p = r.provenance;
  const versions = [...r.cards].reverse();
  return (
    <div class="record__in">
      <div class="acc">
        <p class="acc__head">
          {r.repo.split("/")[1] ?? r.repo} <span>#{r.prNumber}</span>
        </p>
        <dl>
          <dt>author</dt>
          <dd>{authorLine(r)}</dd>
          <dt>agent</dt>
          <dd>{p?.agent ?? "—"}</dd>
          <dt>model</dt>
          <dd>{p?.model ?? "not declared"}</dd>
          {p?.task || r.task ? (
            <>
              <dt>task</dt>
              <dd>{p?.task ?? r.task?.externalId}</dd>
            </>
          ) : null}
          <dt>writer</dt>
          <dd>{card?.writerModel ?? "—"}</dd>
          {card ? (
            <>
              <dt>files</dt>
              <dd class="num">
                {card.filesTotal} · +{num(card.linesAdded)} −{num(card.linesDeleted)}
              </dd>
            </>
          ) : null}
          <dt>head</dt>
          <dd>{r.headSha.slice(0, 7)}</dd>
        </dl>
      </div>

      <div class="slipd">
        <h4>
          Determination, <em>by the verifier</em>
        </h4>
        {!card ? (
          <p>No intent card was written for this pull request.</p>
        ) : card.status === "unavailable" ? (
          <p>
            No card: {words(card.failureReason ?? "unavailable")}. Policy used the rules floor
            alone.
          </p>
        ) : card.verifierStatus === "agree" ? (
          <p>Every claim on the card is supported by the diff.</p>
        ) : card.verifierStatus === "disagree" ? (
          <>
            <p>
              The diff does not support {plural(card.verifierMissing.length || 1, "claim")} on the
              card.
            </p>
            {card.verifierMissing.length > 0 ? (
              <ul>
                {card.verifierMissing.slice(0, 3).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p>The verifier {card.verifierStatus === "error" ? "failed" : "was skipped"}.</p>
        )}
        <p class="fine">Saw only the diff, the file list and the card.</p>
        {card && card.status === "ok" ? (
          <ul>
            {card.riskClass === card.riskFloor ? (
              <li>Final class equals the rules floor.</li>
            ) : (
              <li>
                Floor <b>{card.riskFloor}</b>, raised by the {raisedBy(card).join(", ") || "models"}
                .
              </li>
            )}
          </ul>
        ) : null}
      </div>

      <div class="verdict">
        {card ? <Stamp c={card.riskClass} sub={stampSub(card)} /> : null}
        <p class="verdict__policy">
          <b>{r.verdict ? words(r.verdict.outcome) : "no verdict"}</b>
          {r.verdict
            ? r.verdict.policyStatus === "invalid"
              ? "no rule ran; graft.yaml is invalid"
              : `check concluded ${r.verdict.checkConclusion} (${r.verdict.policyMode} mode)`
            : "policy has not evaluated it"}
        </p>
      </div>

      <div class="record__wide">
        <div>
          <div class="mini-h">Card versions · one per push</div>
          {versions.length === 0 ? (
            <p class="fine">None.</p>
          ) : (
            <ol class="versions">
              {versions.map((v, i) => (
                <li key={v.id}>
                  <span class="num">{hhmm(v.at)}</span>
                  {v.status === "ok" ? (
                    <Risk c={v.riskClass} />
                  ) : (
                    <span class="unavail">not written</span>
                  )}
                  <span>
                    {v.status === "ok"
                      ? v.verifierStatus === "agree"
                        ? "agrees"
                        : words(v.verifierStatus)
                      : words(v.failureReason ?? "")}
                    {i === versions.length - 1 ? " · shown" : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <div class="mini-h">Act on it from the CLI</div>
          <Cmd>{`pnpm graft mode show --repo ${r.repo}`}</Cmd>
          <Cmd>{`pnpm graft audit list --repo ${r.repo}`}</Cmd>
          <div class="links">
            <a
              href={`https://github.com/${r.repo}/pull/${r.prNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              Open #{r.prNumber} on GitHub
            </a>
            {p?.sessionUrl ? (
              <a href={p.sessionUrl} target="_blank" rel="noreferrer">
                Agent session
              </a>
            ) : null}
            <a href={href.change(r.changeId)}>Full record</a>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Loads a record on demand, for an entry the operator unfolds. */
export function LazyRecord({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<ChangeRecord>(`/api/changes/${id}`);
  if (error) return <Failure error={error} retry={reload} />;
  if (loading || !data) return <Loading label="Reading the record" />;
  return <RecordSheet r={data} />;
}

/** `#/changes/:id`: the record with every card version written out. */
export function ChangePage({ id }: { id: string }) {
  const { data: r, error, loading, reload } = useApi<ChangeRecord>(`/api/changes/${id}`);
  return (
    <div class="recpage">
      <a class="recpage__back" href={href.changes()}>
        All changes
      </a>
      {error ? <Failure error={error} retry={reload} /> : null}
      {loading && !r ? <Loading /> : null}
      {r ? (
        <>
          <h1>
            {r.repo}#{r.prNumber}
            <span>
              {r.state}
              {r.mergedAt ? ` ${when(r.mergedAt)}` : ""} · {r.baseRef}
            </span>
          </h1>
          {r.cards[0]?.goal ? <p class="recpage__goal">{r.cards[0].goal}</p> : null}
          <RecordSheet r={r} />

          <section aria-labelledby="h-cards">
            <h2 id="h-cards">Intent cards</h2>
            <ol class="card-hist">
              {r.cards.map((c) => (
                <li key={c.id}>
                  <p class="card-hist__when">
                    <b>{when(c.at)}</b>
                    {c.headSha.slice(0, 7)}
                  </p>
                  <div>
                    {c.goal ? (
                      <h3>{c.goal}</h3>
                    ) : (
                      <h3 class="fine">No card: {words(c.failureReason ?? "")}</h3>
                    )}
                    {c.behaviorChanges.length > 0 ? (
                      <ul>
                        {c.behaviorChanges.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    ) : null}
                    <p class="marks">
                      {c.status === "ok" ? <Risk c={c.riskClass} /> : null}
                      <span class="floor">floor {c.riskFloor}</span>
                      {c.status === "ok" ? (
                        <Verifier v={c.verifierStatus} missing={c.verifierMissing.length} />
                      ) : null}
                      <span>{num(c.tokens)} tokens</span>
                      {c.instructionsInData ? <span>instructions found in the PR data</span> : null}
                      {c.inputsTruncated ? <span>inputs truncated</span> : null}
                    </p>
                    {c.floorReasons.length > 0 ? (
                      <p class="paths">
                        {c.floorReasons.map((f) => (
                          <span key={f.rule}>
                            {words(f.rule)} → {f.floor}
                            {f.paths.length ? (
                              <>
                                {": "}
                                <code>{f.paths.slice(0, 3).join(", ")}</code>
                              </>
                            ) : null}
                            {"  "}
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {c.outOfScope.length > 0 ? (
                      <p class="paths">
                        Out of scope:{" "}
                        {c.outOfScope.map((o) => (
                          <span key={o.path}>
                            <code>{o.path}</code> ({o.reason}){" "}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="h-facts">
            <h2 id="h-facts">Policy, guard and feedback</h2>
            <dl class="facts">
              <div>
                <dt>Policy</dt>
                <dd>
                  {r.verdict
                    ? `${words(r.verdict.outcome)} · ${plural(r.verdict.evaluations, "evaluation")}`
                    : "none"}
                </dd>
              </div>
              <div>
                <dt>Enforce mode would</dt>
                <dd>
                  {r.verdict?.enforcedConclusion
                    ? `${r.verdict.enforcedConclusion}${r.verdict.enforcedReason ? ` · ${words(r.verdict.enforcedReason)}` : ""}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Rules matched</dt>
                <dd>{r.verdict ? r.verdict.rulesMatched : "—"}</dd>
              </div>
              <div>
                <dt>Guard</dt>
                <dd>
                  {r.guardEvents.length
                    ? r.guardEvents.map((g) => words(g.status)).join(", ")
                    : "never fired"}
                </dd>
              </div>
              <div>
                <dt>Break-glass</dt>
                <dd>
                  {r.breakGlass.length ? r.breakGlass.map((b) => b.kind).join(", ") : "never"}
                </dd>
              </div>
              <div>
                <dt>Card votes</dt>
                <dd>
                  {r.feedback.up} up · {r.feedback.down} down
                  {r.feedback.byAuthor ? ` · ${r.feedback.byAuthor} by the author` : ""}
                </dd>
              </div>
              <div>
                <dt>Commits with trailers</dt>
                <dd>
                  {r.provenance
                    ? `${r.provenance.commitsWithTrailers} of ${r.provenance.commitsTotal}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>PR author</dt>
                <dd>{r.authorLogin}</dd>
              </div>
            </dl>
          </section>
        </>
      ) : null}
    </div>
  );
}
