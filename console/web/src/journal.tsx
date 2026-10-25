import { useState } from "preact/hooks";
import type {
  Attention,
  ChangeEntry,
  DayResponse,
  DaySummary,
  DaysResponse,
  Entry,
  OverviewResponse,
} from "../../shared/api.js";
import { type Loaded, qs, TIME_ZONE, useApi } from "./api.js";
import { Chevron, Cmd, Empty, Failure, Loading, Outcome, Risk, Verifier } from "./components.js";
import {
  dayOfMonth,
  hhmm,
  longDate,
  num,
  pct,
  plural,
  shortRepo,
  usd,
  weekday,
  weekdayShort,
  when,
  words,
} from "./format.js";
import { LazyRecord } from "./record.js";
import { href } from "./router.js";

type Filter = "all" | "sensitive" | "disagree" | "guard";

function Summary({ s, entries }: { s: DaySummary; entries: Entry[] }) {
  const guards = entries.filter((e) => e.kind === "guard");
  const human = guards.filter(
    (g) => g.kind === "guard" && ["needs_human", "ambiguous", "error"].includes(g.status),
  );
  if (
    s.cards === 0 &&
    s.prsOpened === 0 &&
    s.prsMerged === 0 &&
    s.deliveries === 0 &&
    guards.length === 0
  ) {
    return <p class="summary">Graft recorded nothing on this day.</p>;
  }
  return (
    <p class="summary">
      Graft read <strong>{plural(s.deliveries, "delivery", "deliveries")}</strong>
      {s.cards > 0 ? (
        <>
          {" "}
          and wrote <strong>{plural(s.cards - s.cardsUnavailable, "intent card")}</strong>
        </>
      ) : null}{" "}
      across {plural(s.repositories || 0, "repository", "repositories")};{" "}
      {plural(s.prsOpened, "pull request")} opened and {num(s.prsMerged)} merged.
      {s.verifierDisagree > 0
        ? ` The verifier disagreed with the writer on ${plural(s.verifierDisagree, "card")}.`
        : ""}
      {s.cardsBudget > 0 ? (
        <>
          {" "}
          <strong>The token budget ran out: {plural(s.cardsBudget, "card")} not written.</strong>
        </>
      ) : null}
      {human.length > 0 ? (
        <>
          {" "}
          The guard stopped {human.length === 1 ? "once" : `${human.length} times`} and wants a
          human.
        </>
      ) : guards.length > 0 ? (
        ` The guard fired ${guards.length === 1 ? "once" : `${guards.length} times`}.`
      ) : (
        ""
      )}
    </p>
  );
}

function Tally({ s }: { s: DaySummary }) {
  const cells: [string, string, string][] = [
    ["Deliveries", num(s.deliveries), `${num(s.deliveriesIgnored)} ignored`],
    ["Pull requests", `${num(s.prsOpened)} opened`, `${num(s.prsMerged)} merged`],
    ["Intent cards", num(s.cards - s.cardsUnavailable), `${num(s.cardsUnavailable)} not written`],
    ["Verifier", `${num(s.verifierAgree)} agree`, `${num(s.verifierDisagree)} disagree`],
    ["Spend", usd(s.costUsd), `${num(s.tokens)} tokens`],
  ];
  return (
    <dl class="tally">
      {cells.map(([k, v, sub]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {v}
            <small>{sub}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ChangeRow({ e }: { e: ChangeEntry }) {
  return (
    <>
      <span class="entry__ref">
        {shortRepo(e.repo)}
        <span>#</span>
        {e.prNumber}{" "}
        <span>
          ·{" "}
          {e.versions.length === 0
            ? "no card this day"
            : e.versions.length === 1
              ? "1 card"
              : `${e.versions.length} card versions`}
        </span>
      </span>
      {e.goal ? (
        <span class="entry__goal">{e.goal}</span>
      ) : (
        <span class="entry__goal entry__goal--muted">No goal recorded.</span>
      )}
      <span class="entry__marks">
        {e.card ? (
          e.card.status === "ok" ? (
            <>
              <Risk c={e.card.riskClass} />
              {e.card.riskFloor !== e.card.riskClass ? (
                <span class="floor">floor {e.card.riskFloor}</span>
              ) : null}
              <Verifier v={e.card.verifierStatus} missing={e.card.verifierMissing} />
            </>
          ) : (
            <span class="unavail">
              card not written: {words(e.card.failureReason ?? "unavailable")}
            </span>
          )
        ) : null}
        <Outcome o={e.policyOutcome} />
        {e.guardStatus ? <span>guard: {words(e.guardStatus)}</span> : null}
      </span>
    </>
  );
}

function ChangeSide({ e }: { e: ChangeEntry }) {
  const state =
    e.state === "merged" && e.mergedAt
      ? `merged ${hhmm(e.mergedAt)}`
      : e.state === "closed"
        ? "closed"
        : "open";
  return (
    <span class="entry__side">
      <span class={e.state === "merged" ? "state-merged" : "state-open"}>{state}</span>
      {e.card ? <span class="num">{plural(e.card.filesTotal, "file")}</span> : null}
      <Chevron />
    </span>
  );
}

function EntryItem({ e, open, onToggle }: { e: Entry; open: boolean; onToggle: () => void }) {
  const id = `rec-${e.kind}-${e.at}-${"changeId" in e ? e.changeId : ""}`;
  if (e.kind === "change") {
    return (
      <li class="entry">
        <button
          class="entry__row"
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <span class="entry__time">{hhmm(e.at)}</span>
          <span class="entry__body">
            <ChangeRow e={e} />
          </span>
          <ChangeSide e={e} />
        </button>
        <div class="record" id={id} data-open={open}>
          <div>{open ? <LazyRecord id={e.changeId} /> : null}</div>
        </div>
      </li>
    );
  }
  let ref: string;
  let goal: string;
  let side: string;
  if (e.kind === "guard") {
    ref = `guard · ${shortRepo(e.repo)} · ${e.branch}`;
    const checks = e.failingChecks.length ? e.failingChecks.join(", ") : "A required check";
    goal = `${checks} went red at ${e.failingSha.slice(0, 7)}${e.culpritPr ? ` after #${e.culpritPr}` : ""}.${e.revertReason ? ` No revert: ${words(e.revertReason)}.` : ""}${e.revertPr ? ` Revert PR #${e.revertPr}.` : ""}`;
    side = words(e.status);
  } else if (e.kind === "break_glass") {
    ref = `break-glass · ${shortRepo(e.repo)}#${e.prNumber}`;
    goal = `${e.actor ?? "Someone"} ${e.auditKind === "applied" ? "bypassed policy" : `break-glass ${e.auditKind}`}${e.reason ? ` (${words(e.reason)})` : ""}.`;
    side = e.auditKind;
  } else {
    ref = `mode · ${shortRepo(e.repo)}`;
    goal = `${e.actor} set ${words(e.key)} from ${e.from} to ${e.to}.`;
    side = e.applied ? "applied" : "waiting";
  }
  return (
    <li class="entry">
      <div class="entry__row">
        <span class="entry__time">{hhmm(e.at)}</span>
        <span class="entry__body">
          <span class="entry__ref">{ref}</span>
          <span class="entry__goal entry__goal--guard">{goal}</span>
          {e.kind === "guard" && e.ciRunUrl ? (
            <span class="entry__marks">
              <a href={e.ciRunUrl} target="_blank" rel="noreferrer">
                Failing CI run
              </a>
            </span>
          ) : null}
        </span>
        <span class="entry__side">
          <span class="state-open">{side}</span>
        </span>
      </div>
    </li>
  );
}

function matches(e: Entry, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "guard") return e.kind === "guard";
  if (e.kind !== "change" || !e.card) return false;
  return f === "sensitive"
    ? e.card.riskClass === "sensitive"
    : e.card.verifierStatus === "disagree";
}

function DayPage({ date, today }: { date: string; today: string }) {
  const { data, error, loading, reload } = useApi<DayResponse>(
    `/api/days/${date}${qs({ tz: TIME_ZONE })}`,
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const key = (e: Entry) => `${e.kind}:${e.at}:${"changeId" in e ? e.changeId : ""}`;
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const shown = data ? data.entries.filter((e) => matches(e, filter)) : [];
  return (
    <article class="page" aria-labelledby="day-title">
      <span class="crop crop--tl" aria-hidden="true" />
      <span class="crop crop--tr" aria-hidden="true" />
      <div class="page__date">
        <h1 id="day-title">{weekday(date)}</h1>
        <span class="num">
          {longDate(date)}
          {date === today && data ? ` · as of ${hhmm(new Date().toISOString())}` : ""}
        </span>
      </div>
      {error ? <Failure error={error} retry={reload} /> : null}
      {!data && loading ? (
        <div class="summary" aria-hidden="true">
          <span class="ph" style={{ width: "92%" }} />
          <span class="ph" style={{ width: "70%", marginTop: "10px" }} />
        </div>
      ) : null}
      {data ? (
        <>
          <Summary s={data.summary} entries={data.entries} />
          <Tally s={data.summary} />
          <div class="entries-head">
            <h2>Entries</h2>
            <fieldset class="filters">
              <legend class="sr">Filter entries</legend>
              {(["all", "sensitive", "disagree", "guard"] as Filter[]).map((f) => (
                <button
                  key={f}
                  class="chip"
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : f === "disagree" ? "verifier disagrees" : f}
                </button>
              ))}
            </fieldset>
          </div>
          {shown.length === 0 ? (
            <Empty
              title={data.entries.length === 0 ? "Nothing handled this day" : "No entry matches"}
            >
              <p>
                {data.entries.length === 0
                  ? "No pull request, guard event, break-glass or mode change was recorded."
                  : "Pick All to see every entry."}
              </p>
            </Empty>
          ) : (
            <ol class="entries">
              {shown.map((e) => (
                <EntryItem
                  key={key(e)}
                  e={e}
                  open={open.has(key(e))}
                  onToggle={() => toggle(key(e))}
                />
              ))}
            </ol>
          )}
          <div class="page__foot">
            <span>Newest first. Times are {data.timeZone}.</span>
            <span>
              No titles, bodies or diffs: Graft does not store them. Goals are the intent card's own
              text.
            </span>
          </div>
        </>
      ) : null}
    </article>
  );
}

function Rail({ days, selected }: { days: DaysResponse; selected: string }) {
  const installed = days.installedAt ? days.installedAt.slice(0, 10) : null;
  const shown = days.days.filter(
    (d) => !installed || d.date >= installed || d.prsOpened + d.cards > 0,
  );
  return (
    <nav class="rail" aria-label="Days">
      <div class="rail__head">Days</div>
      {shown.map((d) => {
        const flag = d.guardNeedsHuman > 0 ? "human" : d.cardsBudget > 0 ? "stop" : "";
        const prs =
          d.prsOpened + d.prsMerged > 0
            ? plural(Math.max(d.prsOpened, d.prsMerged), "PR")
            : "quiet";
        return (
          <a
            key={d.date}
            class="tab"
            href={href.day(d.date)}
            aria-current={d.date === selected ? "page" : undefined}
          >
            <span class="tab__day">{weekdayShort(d.date)}</span>
            <span class="tab__date">{dayOfMonth(d.date)}</span>
            <span class="tab__n">{prs}</span>
            {flag ? (
              <i
                class={`tab__flag tab__flag--${flag}`}
                role="img"
                aria-label={flag === "stop" ? "budget ran out" : "needs a human"}
              />
            ) : null}
          </a>
        );
      })}
      {days.installedAt ? <div class="rail__foot">Installed {when(days.installedAt)}</div> : null}
    </nav>
  );
}

function Slip({ a, i }: { a: Attention; i: number }) {
  const r = [-1.6, 1.1, -0.7, 0.8, -1.2][i % 5];
  return (
    <article
      class={`slip${i % 2 === 1 ? " slip--tape" : ""}${a.severity === "watch" ? " slip--watch" : ""}`}
      style={{ "--r": `${r}deg`, "--d": `${0.12 * (i + 1)}s` }}
    >
      <div class="slip__kind">
        <span>
          {a.kind}
          {a.repo ? ` · ${shortRepo(a.repo)}` : ""}
        </span>
        <span>{a.at ? when(a.at) : a.severity === "act" ? "act" : "watch"}</span>
      </div>
      <h3>{a.title}</h3>
      <p>{a.detail}</p>
      {a.command ? <Cmd>{a.command}</Cmd> : null}
      {a.link ? (
        <div class="links">
          <a href={a.link} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        </div>
      ) : null}
    </article>
  );
}

export function Margin({ ov }: { ov: Loaded<OverviewResponse> }) {
  const { data, error, reload } = ov;
  if (error) {
    return (
      <aside class="margin" aria-label="Needs you">
        <Failure error={error} retry={reload} />
      </aside>
    );
  }
  if (!data) {
    return (
      <aside class="margin" aria-label="Needs you">
        <Loading />
      </aside>
    );
  }
  const act = data.attention.filter((a) => a.severity === "act").length;
  const g = data.gate;
  const judged = data.totals.verifierJudged;
  return (
    <aside class="margin" aria-label="Needs you and instruments">
      <section>
        <h2 class="margin__h">
          Needs you <span>{act > 0 ? act : data.attention.length > 0 ? "watch" : "0"}</span>
        </h2>
        {data.attention.length === 0 ? (
          <p class="margin__empty">
            <strong>Nothing pinned</strong>
            No guard event waits on a human, policy files parse, and no card was skipped in the last
            day.
          </p>
        ) : (
          <div class="slips">
            {data.attention.slice(0, 6).map((a, i) => (
              <Slip key={a.id} a={a} i={i} />
            ))}
          </div>
        )}
      </section>

      <section class="instr">
        <h3>Phase 0 gate · card accuracy</h3>
        <div
          class="gauge"
          role="img"
          aria-label={
            g.interval
              ? `Eligible votes ${g.eligibleUp} up and ${g.eligibleDown} down, interval ${pct(g.interval.low)} to ${pct(g.interval.high)}, target ${pct(g.target)}`
              : `No eligible vote yet, target ${pct(g.target)}`
          }
        >
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
        <p>
          {g.eligibleUp + g.eligibleDown === 0
            ? `No eligible vote, so there is no interval yet. Recorded: ${num(g.votes)}, dropped as author votes: ${num(g.authorVotes)}.`
            : `${num(g.eligibleUp)} up, ${num(g.eligibleDown)} down from reviewers other than the author. `}
          <a href={href.gate()}>Gate details</a>
        </p>
      </section>

      {data.budget.slice(0, 2).map((b) => {
        const max = Math.max(b.budget || 1, ...b.days.map((d) => d.tokens));
        const scale = (t: number) => (t / max) * 78;
        const share = b.budget > 0 ? b.todayTokens / b.budget : 0;
        return (
          <section class="instr" key={b.repo}>
            <h3>Token budget · {shortRepo(b.repo)}</h3>
            {b.budget > 0 ? (
              <div
                class="gauge"
                role="img"
                aria-label={`${num(b.todayTokens)} of ${num(b.budget)} tokens used today, ${pct(share)}`}
              >
                <div class="gauge__track">
                  <span class="gauge__fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
                </div>
                <div class="gauge__scale">
                  <span>0</span>
                  <span>
                    {num(b.todayTokens)} used · {pct(share)}
                  </span>
                  <span>{num(b.budget)}</span>
                </div>
              </div>
            ) : (
              <p>No daily budget: Graft spends without a limit.</p>
            )}
            <svg
              class="spark"
              viewBox="0 0 300 118"
              role="img"
              aria-label={`Daily tokens for the last ${b.days.length} UTC days: ${b.days.map((d) => `${d.date} ${num(d.tokens)}${d.skipped ? `, ${d.skipped} skipped` : ""}`).join("; ")}`}
            >
              {b.budget > 0 ? (
                <>
                  <line
                    class="limit"
                    x1="0"
                    x2="300"
                    y1={94 - scale(b.budget)}
                    y2={94 - scale(b.budget)}
                  />
                  <text x="300" y={94 - scale(b.budget) - 5} text-anchor="end">
                    budget {num(b.budget)} / UTC day
                  </text>
                </>
              ) : null}
              {b.days.map((d, i) => {
                const w = 300 / b.days.length;
                const h = scale(d.tokens);
                const today = i === b.days.length - 1;
                return (
                  <g key={d.date}>
                    <rect
                      class={`bar${d.skipped ? " bar--hit" : ""}${today ? " bar--today" : ""}`}
                      x={i * w + w * 0.18}
                      y={94 - h}
                      width={w * 0.64}
                      height={Math.max(h, 0.5)}
                    />
                    <text x={i * w + w / 2} y="110" text-anchor="middle">
                      {dayOfMonth(d.date)}
                      {d.skipped ? "*" : ""}
                    </text>
                  </g>
                );
              })}
              <line class="base" x1="0" x2="300" y1="94" y2="94" />
            </svg>
            {b.days.some((d) => d.skipped) ? (
              <p>
                * days with cards not written at the budget:{" "}
                {b.days
                  .filter((d) => d.skipped)
                  .map((d) => `${dayOfMonth(d.date)} (${d.skipped})`)
                  .join(", ")}
                .
              </p>
            ) : null}
          </section>
        );
      })}

      <section class="instr">
        <h3>Since install</h3>
        <dl class="ledger">
          <dt>Intent cards written</dt>
          <dd>{num(data.totals.cards - data.totals.cardsUnavailable)}</dd>
          <dt>Not written (budget)</dt>
          <dd>{num(data.totals.cardsBudget)}</dd>
          <dt>Verifier agreed</dt>
          <dd>
            {num(data.totals.verifierAgree)} of {num(judged)}
          </dd>
          <dt>A model raised the floor</dt>
          <dd>{num(data.totals.raised)}</dd>
          <dt>Spend</dt>
          <dd>{usd(data.totals.costUsd)}</dd>
          <dt>Average per model run</dt>
          <dd>{data.totals.spendRuns ? usd(data.totals.costUsd / data.totals.spendRuns) : "—"}</dd>
        </dl>
      </section>
    </aside>
  );
}

export function Journal({ date, ov }: { date: string | null; ov: Loaded<OverviewResponse> }) {
  const days = useApi<DaysResponse>(`/api/days${qs({ tz: TIME_ZONE, days: 21 })}`);
  if (days.error) {
    return (
      <div class="journal">
        <div />
        <Failure error={days.error} retry={days.reload} />
      </div>
    );
  }
  if (!days.data) {
    return (
      <div class="journal">
        <div />
        <Loading />
      </div>
    );
  }
  const today = days.data.today;
  const selected = date && date <= today ? date : today;
  if (!days.data.installedAt) {
    return (
      <div class="journal">
        <div />
        <article class="page">
          <Empty title="Graft has not been installed yet">
            <p>
              The journal fills in once the GitHub App is installed on an account and its first pull
              request arrives. Until then there is nothing to read.
            </p>
          </Empty>
        </article>
      </div>
    );
  }
  return (
    <div class="journal">
      <Rail days={days.data} selected={selected} />
      <DayPage key={selected} date={selected} today={today} />
      <Margin ov={ov} />
    </div>
  );
}
