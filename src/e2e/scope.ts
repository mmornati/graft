/**
 * The App must be installed on the sandbox and on nothing else (review 1, finding 1). The personal
 * App is owned by the same account as the protected source repository, and GitHub's install page
 * defaults to "All repositories": Graft would then comment on that repository's pull requests.
 */
import type { GitHubClient } from "../github/client-factory.js";
import { isProtected, type SandboxConfig } from "./guard.js";

export interface ScopeProblem {
  code: "selection" | "extra_repository" | "sandbox_missing" | "protected";
  detail: string;
}

export interface InstallationFacts {
  repositorySelection: string;
  repositories: { id: number; full_name: string }[];
}

/** Pure: what is wrong with the installation, in order of seriousness. Empty means fine. */
export function scopeProblems(
  f: InstallationFacts,
  sandbox: { repo: string; repositoryId: number },
  config: SandboxConfig,
): ScopeProblem[] {
  const out: ScopeProblem[] = [];
  if (f.repositorySelection !== "selected") {
    out.push({
      code: "selection",
      detail: `the App is installed on "${f.repositorySelection}" repositories; choose "Only select repositories"`,
    });
  }
  for (const r of f.repositories) {
    if (isProtected(r.full_name, config)) {
      out.push({ code: "protected", detail: "the installation includes a protected repository" });
    }
  }
  const mine = f.repositories.filter(
    (r) =>
      r.id === sandbox.repositoryId && r.full_name.toLowerCase() === sandbox.repo.toLowerCase(),
  );
  if (mine.length === 0) {
    out.push({
      code: "sandbox_missing",
      detail: "the installation does not list the sandbox (id and name)",
    });
  }
  if (f.repositories.length !== mine.length) {
    out.push({
      code: "extra_repository",
      detail: `the installation lists ${f.repositories.length} repositories; it must list only the sandbox`,
    });
  }
  return out;
}

/** Reads the facts: `GET /app/installations/{id}` with the JWT and `GET /installation/repositories`. */
export async function readInstallationFacts(
  app: GitHubClient,
  probe: GitHubClient,
  installationId: number,
): Promise<InstallationFacts> {
  const inst = await app.rest.apps.getInstallation({ installation_id: installationId });
  const repos = await probe.paginate(probe.rest.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
  return {
    repositorySelection: inst.data.repository_selection,
    repositories: (repos as unknown as { id: number; full_name: string }[]).map((r) => ({
      id: r.id,
      full_name: r.full_name,
    })),
  };
}

export function scopeMessage(problems: readonly ScopeProblem[]): string {
  return `${problems.map((p) => p.detail).join("; ")} (docs/e2e/runbook.md, section 6)`;
}
