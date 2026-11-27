import type { BillingStatement, BillingStatementLine } from "./api.js";

export function csvCell(value: unknown, textual: boolean): string {
  let text = String(value ?? "");
  if (textual && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportCsv(statement: BillingStatement): string {
  const fields: (keyof BillingStatementLine)[] = [
    "id",
    "teamId",
    "teamName",
    "repositoryId",
    "repositoryName",
    "model",
    "lineType",
    "description",
    "calls",
    "unpricedCalls",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
    "sourcePeriod",
    "sourceLineId",
    "sourceCallId",
  ];
  return [
    fields.join(","),
    ...statement.lines.map((line) =>
      fields
        .map((field) =>
          csvCell(
            line[field],
            [
              "id",
              "teamId",
              "teamName",
              "repositoryName",
              "model",
              "lineType",
              "description",
              "sourcePeriod",
              "sourceLineId",
              "sourceCallId",
            ].includes(field),
          ),
        )
        .join(","),
    ),
  ].join("\r\n");
}

export function statementForMonth(
  statement: BillingStatement | undefined,
  month: string,
): BillingStatement | undefined {
  return statement?.month === month ? statement : undefined;
}

export function adjustmentPeriod(result: unknown): string | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "period" in result &&
    typeof result.period === "string"
  ) {
    return result.period;
  }
  return null;
}

export function aggregateTeamTotals(lines: readonly BillingStatementLine[]) {
  const totals = new Map<
    string | null,
    { name: string; usd: number; unpriced: number; calls: number }
  >();
  for (const line of lines) {
    const total = totals.get(line.teamId) ?? {
      name: line.teamName,
      usd: 0,
      unpriced: 0,
      calls: 0,
    };
    total.usd += Number(line.costUsd ?? 0);
    total.unpriced += line.unpricedCalls;
    total.calls += line.calls;
    totals.set(line.teamId, total);
  }
  return totals;
}
