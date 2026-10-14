import { z } from "zod";

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** In memory only: never persisted, logged or put in job data. */
  patch: string | null;
}

export interface CardInputs {
  repositoryFullName: string;
  pr: {
    number: number;
    title: string;
    body: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  issue: { number: number; title: string; body: string } | null;
  /** As listed (may be fewer than `pr.changedFiles`). */
  files: ChangedFile[];
  listingTruncated: boolean;
  /** D14; `files` is [] when true. */
  tooLarge: boolean;
}

const count = z.number().int().nonnegative();

export const changedFileSchema = z.strictObject({
  path: z.string().min(1),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: count,
  deletions: count,
  patch: z.string().nullable(),
});

/** Step 4 loads labeled fixtures with this. */
export const cardInputsSchema: z.ZodType<CardInputs> = z.strictObject({
  repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  pr: z.strictObject({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    additions: count,
    deletions: count,
    changedFiles: count,
  }),
  issue: z
    .strictObject({
      number: z.number().int().positive(),
      title: z.string(),
      body: z.string(),
    })
    .nullable(),
  files: z.array(changedFileSchema),
  listingTruncated: z.boolean(),
  tooLarge: z.boolean(),
});

export interface LinkedIssue {
  number: number;
  source: "closing_keyword" | "task" | "reference";
}

const MAX_ISSUE_NUMBER = 999_999_999;

/** Removes the content of complete ``` fence pairs; an unpaired fence is left alone. */
function stripFences(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const fences: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fences.push(i);
  });
  const drop = new Set<number>();
  for (let k = 0; k + 1 < fences.length; k += 2) {
    for (let i = fences[k] as number; i <= (fences[k + 1] as number); i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)|([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)|#(\d+))(?![\w])/gi;
const BARE = /(?<![\w&])#(\d+)(?![\w])/g;

/**
 * Which issue a PR is about (T8.1): the first closing-keyword reference in the body, else the
 * issue named by the `Graft-Task` trailer, else the first bare same-repo `#N`.
 */
export function findLinkedIssue(
  body: string,
  o: { owner: string; repo: string; prNumber: number; taskIssueNumber: number | null },
): LinkedIssue | null {
  const text = stripFences(body);
  const valid = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 1 && n <= MAX_ISSUE_NUMBER && n !== o.prNumber
      ? n
      : null;
  };
  const same = (owner: string | undefined, repo: string | undefined) =>
    owner?.toLowerCase() === o.owner.toLowerCase() && repo?.toLowerCase() === o.repo.toLowerCase();

  for (const m of text.matchAll(CLOSING)) {
    const [, uOwner, uRepo, uNum, rOwner, rRepo, rNum, bareNum] = m;
    let n: number | null = null;
    if (uNum !== undefined) n = same(uOwner, uRepo) ? valid(uNum) : null;
    else if (rNum !== undefined) n = same(rOwner, rRepo) ? valid(rNum) : null;
    else if (bareNum !== undefined) n = valid(bareNum);
    if (n !== null) return { number: n, source: "closing_keyword" };
  }
  if (o.taskIssueNumber !== null && valid(String(o.taskIssueNumber)) !== null) {
    return { number: o.taskIssueNumber, source: "task" };
  }
  for (const m of text.matchAll(BARE)) {
    const n = valid(m[1] as string);
    if (n !== null) return { number: n, source: "reference" };
  }
  return null;
}
