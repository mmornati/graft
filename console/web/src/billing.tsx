import { useEffect, useState } from "preact/hooks";
import type {
  BillingRepositoriesPage,
  BillingStatement,
  BillingStatementLine,
  BillingTeam,
} from "../../shared/api.js";
import {
  adjustmentPeriod,
  aggregateTeamTotals,
  exportCsv,
  statementForMonth,
} from "../../shared/billing.js";
import { postJson, qs, useApi } from "./api.js";
import { Empty, Failure, Loading } from "./components.js";

function previousMonth(): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const usd = (value: string | null) =>
  value === null
    ? "Unpriced"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
        Number(value),
      );

export function Billing() {
  const [month, setMonth] = useState(previousMonth);
  const [repositoryAfter, setRepositoryAfter] = useState(0);
  const teams = useApi<BillingTeam[]>("/api/billing/teams");
  const repositories = useApi<BillingRepositoriesPage>(
    `/api/billing/repositories${qs({ after: repositoryAfter })}`,
  );
  const [repositoryChoices, setRepositoryChoices] = useState<
    BillingRepositoriesPage["repositories"]
  >([]);
  const currentRepositoryPage =
    repositories.data?.after === repositoryAfter ? repositories.data : undefined;
  useEffect(() => {
    if (!currentRepositoryPage) return;
    setRepositoryChoices((previous) => {
      const base = repositoryAfter === 0 ? [] : previous;
      const byId = new Map(base.map((repository) => [repository.id, repository]));
      for (const repository of currentRepositoryPage.repositories) {
        byId.set(repository.id, repository);
      }
      return [...byId.values()];
    });
  }, [currentRepositoryPage, repositoryAfter]);
  const statement = useApi<BillingStatement>(`/api/billing/statement${qs({ month })}`);
  const [teamName, setTeamName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState({ amountUsd: "", reason: "" });
  const [adjustmentOperationId, setAdjustmentOperationId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = () => {
    teams.reload();
    setRepositoryAfter(0);
    repositories.reload();
    statement.reload();
  };

  async function change(body: Record<string, unknown>, key: string): Promise<unknown> {
    setPending(key);
    setError("");
    setNotice("");
    try {
      const result = await postJson<unknown>("/api/billing/change", body);
      setNotice("Billing settings saved.");
      refresh();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setPending(null);
    }
  }

  async function saveTeam(ev: SubmitEvent) {
    ev.preventDefault();
    const name = teamName.trim();
    if (!name) return;
    if ((await change({ action: "create", name }, "create")) !== undefined) setTeamName("");
  }

  async function saveRename(ev: SubmitEvent, id: string) {
    ev.preventDefault();
    const name = renameValue.trim();
    if (!name) return;
    if ((await change({ action: "rename", id, name }, id)) !== undefined) setRenaming(null);
  }

  async function saveAdjustment(ev: SubmitEvent, line: BillingStatementLine) {
    ev.preventDefault();
    const operationId = adjustmentOperationId ?? crypto.randomUUID();
    setAdjustmentOperationId(operationId);
    const result = await change(
      {
        action: "adjustment",
        sourcePeriod: month,
        sourceLineId: line.id,
        operationId,
        amountUsd: adjustment.amountUsd,
        reason: adjustment.reason,
      },
      line.id,
    );
    const period = adjustmentPeriod(result);
    if (period === null) return;
    setMonth(period);
    setAdjustment({ amountUsd: "", reason: "" });
    setEditingLine(null);
    setAdjustmentOperationId(null);
  }

  const exportStatement = statementForMonth(statement.data, month);
  const teamTotals = aggregateTeamTotals(exportStatement?.lines ?? []);

  return (
    <div class="register-wrap billing">
      <h1>Team billing</h1>
      <p>
        Estimated model spend, allocated equally across each repository’s billing teams when the
        model call is recorded. Prices are estimates in USD, not provider invoices.
      </p>
      {error ? (
        <p class="billing__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p class="billing__notice" role="status">
          {notice}
        </p>
      ) : null}

      <section aria-labelledby="billing-teams-heading">
        <h2 id="billing-teams-heading">Billing teams</h2>
        {teams.error ? <Failure error={teams.error} retry={teams.reload} /> : null}
        {teams.loading && !teams.data ? <Loading /> : null}
        {teams.data ? (
          <>
            <form class="billing__create" onSubmit={(ev) => void saveTeam(ev)}>
              <label class="field" for="billing-team-name">
                New team
                <input
                  id="billing-team-name"
                  value={teamName}
                  maxLength={100}
                  required
                  onInput={(ev) => setTeamName(ev.currentTarget.value)}
                />
              </label>
              <button class="btn btn--primary" type="submit" disabled={pending !== null}>
                Create team
              </button>
            </form>
            {currentRepositoryPage?.next !== null && currentRepositoryPage?.next !== undefined ? (
              <button
                class="btn btn--ghost"
                type="button"
                disabled={repositories.loading}
                onClick={() => setRepositoryAfter(currentRepositoryPage.next ?? 0)}
              >
                {repositories.loading ? "Loading repositories…" : "Load more repositories"}
              </button>
            ) : null}
            {repositories.error ? (
              <Failure error={repositories.error} retry={repositories.reload} />
            ) : null}
            {teams.data.length ? (
              <div class="billing__teams">
                {teams.data.map((team) => (
                  <article class="billing__team" key={team.id}>
                    <div class="billing__team-head">
                      {renaming === team.id ? (
                        <form onSubmit={(ev) => void saveRename(ev, team.id)}>
                          <label class="sr" for={`rename-${team.id}`}>
                            Team name
                          </label>
                          <input
                            id={`rename-${team.id}`}
                            value={renameValue}
                            maxLength={100}
                            required
                            onInput={(ev) => setRenameValue(ev.currentTarget.value)}
                          />
                          <button
                            class="btn btn--primary"
                            type="submit"
                            disabled={pending !== null}
                          >
                            Save
                          </button>
                          <button
                            class="btn btn--ghost"
                            type="button"
                            onClick={() => setRenaming(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <h3>
                            {team.name}
                            {team.archivedAt ? " (archived)" : ""}
                          </h3>
                          {!team.archivedAt ? (
                            <div>
                              <button
                                class="btn btn--ghost"
                                type="button"
                                disabled={pending !== null}
                                onClick={() => {
                                  setRenaming(team.id);
                                  setRenameValue(team.name);
                                }}
                              >
                                Rename
                              </button>
                              <button
                                class="btn btn--ghost"
                                type="button"
                                disabled={pending !== null}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Archive billing team “${team.name}”? Existing statements will be retained.`,
                                    )
                                  )
                                    void change({ action: "archive", id: team.id }, team.id);
                                }}
                              >
                                Archive
                              </button>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                    <ul class="billing__members">
                      {team.repositories.map((repo) => (
                        <li key={repo.id}>
                          <span>{repo.fullName}</span>
                          {!team.archivedAt ? (
                            <button
                              class="btn btn--ghost"
                              type="button"
                              disabled={pending !== null}
                              onClick={() =>
                                void change(
                                  {
                                    action: "repository",
                                    teamId: team.id,
                                    repositoryId: repo.id,
                                    attached: false,
                                  },
                                  `repo-${repo.id}`,
                                )
                              }
                            >
                              Detach
                            </button>
                          ) : null}
                        </li>
                      ))}
                      {!team.repositories.length ? <li>No repositories attached.</li> : null}
                    </ul>
                    {!team.archivedAt &&
                    repositoryChoices.some(
                      (repo) =>
                        repo.canAdmin && !team.repositories.some((member) => member.id === repo.id),
                    ) ? (
                      <label class="field billing__attach" for={`attach-${team.id}`}>
                        Attach repository
                        <select
                          id={`attach-${team.id}`}
                          value=""
                          disabled={pending !== null}
                          onChange={(ev) => {
                            const id = Number(ev.currentTarget.value);
                            if (id)
                              void change(
                                {
                                  action: "repository",
                                  teamId: team.id,
                                  repositoryId: id,
                                  attached: true,
                                },
                                `repo-${id}`,
                              );
                          }}
                        >
                          <option value="">Choose an administered repository</option>
                          {repositoryChoices
                            .filter(
                              (repo) =>
                                repo.canAdmin &&
                                !team.repositories.some((member) => member.id === repo.id),
                            )
                            .map((repo) => (
                              <option value={repo.id} key={repo.id}>
                                {repo.fullName}
                              </option>
                            ))}
                        </select>
                      </label>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <Empty title="No billing teams yet">
                <p>
                  Create a team, then attach repositories. Unassigned usage remains visible as
                  unattributed.
                </p>
              </Empty>
            )}
          </>
        ) : null}
        {repositories.error ? (
          <Failure error={repositories.error} retry={repositories.reload} />
        ) : null}
      </section>

      <section aria-labelledby="billing-statement-heading">
        <div class="billing__statement-head">
          <div>
            <h2 id="billing-statement-heading">Monthly statement</h2>
            <p>
              Billing periods use UTC. Unpriced calls remain visible and prevent automatic close.
            </p>
          </div>
          <label class="field" for="billing-month">
            Month
            <input
              id="billing-month"
              type="month"
              value={month}
              onInput={(ev) => setMonth(ev.currentTarget.value)}
            />
          </label>
        </div>
        {statement.error ? <Failure error={statement.error} retry={statement.reload} /> : null}
        {statement.loading && !statement.data ? <Loading /> : null}
        {exportStatement ? (
          <>
            <div class="billing__statement-status">
              <strong>{exportStatement.closedAt ? "Closed" : "Open"}</strong>
              {exportStatement.closedAt ? (
                <span>
                  {" "}
                  on {new Date(exportStatement.closedAt).toLocaleString()} by{" "}
                  {exportStatement.closedBy}
                </span>
              ) : (
                <span> · will close automatically when all calls in the month have prices</span>
              )}
              <div class="billing__exports">
                <button
                  class="btn btn--ghost"
                  type="button"
                  onClick={() =>
                    download(
                      `graft-billing-${month}.json`,
                      "application/json",
                      JSON.stringify(exportStatement, null, 2),
                    )
                  }
                >
                  Export JSON
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  onClick={() =>
                    download(
                      `graft-billing-${month}.csv`,
                      "text/csv;charset=utf-8",
                      exportCsv(exportStatement),
                    )
                  }
                >
                  Export CSV
                </button>
              </div>
            </div>
            <dl class="billing__totals">
              {[...teamTotals.entries()].map(([teamId, total]) => (
                <div key={teamId ?? "unattributed"}>
                  <dt>{total.name}</dt>
                  <dd>
                    {total.calls} calls · {usd(total.usd.toFixed(2))}
                    {total.unpriced ? ` · ${total.unpriced} unpriced` : ""}
                  </dd>
                </div>
              ))}
            </dl>
            {exportStatement.lines.length ? (
              <div class="billing__table-wrap">
                <table class="billing__table">
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th>Repository</th>
                      <th>Model</th>
                      <th>Calls</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cache read</th>
                      <th>Cache write</th>
                      <th>Estimated USD</th>
                      <th>Correction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exportStatement.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.teamName}</td>
                        <td>{line.repositoryName}</td>
                        <td>
                          {line.model}
                          {line.lineType === "adjustment" ? (
                            <small> · adjustment: {line.description}</small>
                          ) : null}
                        </td>
                        <td class="num">
                          {line.calls}
                          {line.unpricedCalls ? <small>{line.unpricedCalls} unpriced</small> : null}
                        </td>
                        <td class="num">{line.inputTokens.toLocaleString()}</td>
                        <td class="num">{line.outputTokens.toLocaleString()}</td>
                        <td class="num">{line.cacheReadTokens.toLocaleString()}</td>
                        <td class="num">{line.cacheWriteTokens.toLocaleString()}</td>
                        <td class="num">{usd(line.costUsd)}</td>
                        <td>
                          {exportStatement.closedAt && line.lineType === "usage" ? (
                            editingLine === line.id ? (
                              <form
                                class="billing__adjust"
                                onSubmit={(ev) => void saveAdjustment(ev, line)}
                              >
                                <label class="sr" for={`adjust-amount-${line.id}`}>
                                  Correction in USD
                                </label>
                                <input
                                  id={`adjust-amount-${line.id}`}
                                  inputMode="decimal"
                                  placeholder="0.00"
                                  required
                                  pattern="-?[0-9]{1,12}(\.[0-9]{1,2})?"
                                  value={adjustment.amountUsd}
                                  onInput={(ev) => {
                                    setAdjustmentOperationId(null);
                                    setAdjustment({
                                      ...adjustment,
                                      amountUsd: ev.currentTarget.value,
                                    });
                                  }}
                                />
                                <label class="sr" for={`adjust-reason-${line.id}`}>
                                  Reason
                                </label>
                                <input
                                  id={`adjust-reason-${line.id}`}
                                  placeholder="Reason"
                                  maxLength={500}
                                  required
                                  value={adjustment.reason}
                                  onInput={(ev) => {
                                    setAdjustmentOperationId(null);
                                    setAdjustment({
                                      ...adjustment,
                                      reason: ev.currentTarget.value,
                                    });
                                  }}
                                />
                                <button
                                  class="btn btn--primary"
                                  type="submit"
                                  disabled={pending !== null}
                                >
                                  Add
                                </button>
                                <button
                                  class="btn btn--ghost"
                                  type="button"
                                  onClick={() => {
                                    setEditingLine(null);
                                    setAdjustmentOperationId(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <button
                                class="btn btn--ghost"
                                type="button"
                                onClick={() => {
                                  setAdjustmentOperationId(null);
                                  setEditingLine(line.id);
                                }}
                              >
                                Adjust
                              </button>
                            )
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No usage recorded for this month">
                <p>Recorded model calls will appear here.</p>
              </Empty>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
