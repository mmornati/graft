import { describe, expect, it } from "vitest";
import type { BillingStatement, BillingStatementLine } from "../../shared/api.js";
import {
  adjustmentPeriod,
  aggregateTeamTotals,
  csvCell,
  exportCsv,
  statementForMonth,
} from "../../shared/billing.js";

const line = (overrides: Partial<BillingStatementLine> = {}): BillingStatementLine => ({
  id: "line-1",
  teamId: "team-1",
  teamName: "Platform",
  repositoryId: 42,
  repositoryName: "acme/api",
  model: "test/model",
  lineType: "usage",
  description: null,
  calls: 1,
  unpricedCalls: 0,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: "0.15",
  sourcePeriod: null,
  sourceLineId: null,
  sourceCallId: null,
  ...overrides,
});

const statement: BillingStatement = {
  month: "2026-10",
  closedAt: null,
  closedBy: null,
  lines: [line()],
};

describe("billing view helpers", () => {
  it("neutralizes formula-like text without changing numeric corrections", () => {
    expect(csvCell(" \t=SUM(A1:A2)", true)).toBe('"\' \t=SUM(A1:A2)"');
    expect(csvCell("-0.15", false)).toBe('"-0.15"');
  });

  it("exports stable line, team, repository, and correction source identifiers", () => {
    const csv = exportCsv({
      ...statement,
      lines: [
        line({
          sourcePeriod: "2026-09-01",
          sourceLineId: "source-line",
          sourceCallId: "source-call",
          costUsd: "-1.00",
        }),
      ],
    });
    expect(csv.split("\r\n")[0]).toContain("id,teamId,teamName,repositoryId");
    expect(csv).toContain('"line-1","team-1","Platform","42"');
    expect(csv).toContain('"2026-09-01","source-line"');
    expect(csv).toContain('"source-call"');
    expect(csv).toContain('"-1.00"');
  });

  it("keeps historical team totals separate despite duplicate display names", () => {
    const totals = aggregateTeamTotals([
      line({ teamId: "team-old", costUsd: "1.00" }),
      line({ id: "line-2", teamId: "team-new", costUsd: "2.00" }),
      line({ id: "line-3", teamId: null, teamName: "Unattributed" }),
    ]);
    expect([...totals.keys()]).toEqual(["team-old", "team-new", null]);
    expect([...totals.values()].map(({ usd }) => usd)).toEqual([1, 2, 0.15]);
  });

  it("does not expose a previous month's statement while the selected month loads", () => {
    expect(statementForMonth(statement, "2026-11")).toBeUndefined();
    expect(statementForMonth(statement, "2026-10")).toBe(statement);
  });

  it("keeps correction drafts on failed responses and advances only on a successful result", () => {
    expect(adjustmentPeriod(undefined)).toBeNull();
    expect(adjustmentPeriod({ error: "service unavailable" })).toBeNull();
    expect(adjustmentPeriod({ period: "2026-11" })).toBe("2026-11");
  });
});
