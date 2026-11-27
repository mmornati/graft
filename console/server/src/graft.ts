import { createHmac } from "node:crypto";
import type { BillingRepositoriesPage, BillingStatement, BillingTeam } from "../../shared/api.js";
import type {
  ConsoleUser,
  RepositoriesResponse,
  RepositorySearchResponse,
} from "../../shared/repositories.js";
import type { Config } from "./config.js";

export class GraftError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GraftApi {
  access(user: ConsoleUser, organizations: string[]): Promise<{ allowed: boolean }>;
  repositories(user: ConsoleUser, after: number): Promise<RepositoriesResponse>;
  search(
    user: ConsoleUser,
    account: string,
    query: string,
    page: number,
  ): Promise<RepositorySearchResponse>;
  activation(
    user: ConsoleUser,
    repository: string,
    enabled: boolean,
    confirmation?: string,
  ): Promise<{ enabled: boolean; filtering: boolean }>;
  billingTeams(user: ConsoleUser): Promise<BillingTeam[]>;
  billingRepositories(user: ConsoleUser, after: number): Promise<BillingRepositoriesPage>;
  billingStatement(user: ConsoleUser, month: string): Promise<BillingStatement>;
  billingChange(
    user: ConsoleUser,
    action: "create" | "rename" | "archive" | "repository" | "adjustment",
    values: Record<string, unknown>,
  ): Promise<unknown>;
}

export function graftApi(
  cfg: NonNullable<Config["graft"]>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): GraftApi {
  const call = async <T>(action: string, body: object): Promise<T> => {
    const path = `/internal/console/${action}`;
    const timestamp = String(now());
    const json = JSON.stringify(body);
    const signature = createHmac("sha256", cfg.secret)
      .update(`${timestamp}\nPOST\n${path}\n${json}`)
      .digest("hex");
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.url}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-graft-console-time": timestamp,
          "x-graft-console-signature": signature,
        },
        body: json,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GraftError(
        503,
        "Graft is unreachable. Check the console's connection to the service.",
      );
    }
    if (!res.ok) {
      if (res.status === 401)
        throw new GraftError(
          503,
          "Graft refused the console connection. Check the shared secret and server clocks.",
        );
      const result = (await res.json()) as { message?: string };
      throw new GraftError(res.status, result.message ?? "Graft could not complete that request.");
    }
    return (await res.json()) as T;
  };
  return {
    access: (user, organizations) => call("access", { user, organizations }),
    repositories: (user, after) => call("repositories", { user, after }),
    search: (user, account, query, page) => call("search", { user, account, query, page }),
    activation: (user, repository, enabled, confirmation) =>
      call("activation", {
        user,
        repository,
        enabled,
        ...(confirmation === undefined ? {} : { confirmation }),
      }),
    billingTeams: (user) => call("billing/teams", { user }),
    billingRepositories: (user, after) => call("billing/repositories", { user, after }),
    billingStatement: (user, month) => call("billing/statement", { user, month }),
    billingChange: (user, action, values) => call(`billing/${action}`, { user, ...values }),
  };
}
