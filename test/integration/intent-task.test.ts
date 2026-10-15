/** The card's task input is a function of the head being carded, whatever job runs first. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LlmClient } from "../../src/llm/types.js";
import { generateIntent } from "../../src/modules/intent/job.js";
import { refreshProvenance } from "../../src/modules/provenance/job.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import {
  commitMessage,
  fakeSha,
  HEAD_SHA,
  makeCommit,
  PR_NUMBER,
} from "../helpers/github-builders.js";
import { GENERATE_DATA, loadIntentScenario, scenarioLlm } from "../helpers/intent-scenario.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
let api: FakeGitHubApi;
let current: LlmClient;
const llm: LlmClient = { complete: (r) => current.complete(r) };
const BODY = "Retries failed webhook deliveries.";
const NEW_HEAD = fakeSha(0x99);

beforeAll(async () => {
  t = await createTestApp({ llm });
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api);
  current = scenarioLlm();
});

const agentCommit = (sha: string, task: boolean) =>
  makeCommit(
    sha,
    commitMessage("Fix", undefined, [
      ["Graft-Agent", "claude-code"],
      ...(task ? ([["Graft-Task", "#42"]] as [string, string][]) : []),
    ]),
  );

function setHead(sha: string, task: boolean, updatedAt: string): void {
  loadIntentScenario(api, { body: BODY, head: { sha }, updated_at: updatedAt });
  api.state.commits.set(PR_NUMBER, [agentCommit(sha, task)]);
}

const intent = (sha: string) =>
  generateIntent({ ...GENERATE_DATA, headSha: sha, trigger: "rerequested" }, jobContext(t));
const provenance = (sha: string) =>
  refreshProvenance(
    {
      installationId: GENERATE_DATA.installationId,
      repositoryId: GENERATE_DATA.repositoryId,
      owner: GENERATE_DATA.owner,
      repo: GENERATE_DATA.repo,
      prNumber: PR_NUMBER,
      headSha: sha,
      trigger: "opened",
      deliveryId: "d-prov",
    },
    jobContext(t),
  );
const cards = () => t.db.selectFrom("intent_cards").selectAll().orderBy("created_at").execute();

describe("the card's task input", () => {
  it("I-INT-TASK-1 the card links the Graft-Task issue whether intent runs before or after provenance, with the same input hash", async () => {
    setHead(HEAD_SHA, true, "2026-10-14T11:00:00Z");
    // Intent first: provenance has stored nothing yet.
    expect(await intent(HEAD_SHA)).toBe("published");
    const [first] = await cards();
    expect(first?.linked_issue_number).toBe(42);
    const change = await t.db.selectFrom("changes").select("task_id").executeTakeFirstOrThrow();
    expect(change.task_id).toBeNull();

    // Provenance next, then intent again: a cache hit on the same inputs, no second card.
    await provenance(HEAD_SHA);
    expect(
      (await t.db.selectFrom("changes").select("task_id").executeTakeFirstOrThrow()).task_id,
    ).not.toBeNull();
    expect(await intent(HEAD_SHA)).toBe("cached");
    const after = await cards();
    expect(after).toHaveLength(1);
    expect(after[0]?.input_hash).toBe(first?.input_hash);

    // The other order from scratch gives the same hash.
    await truncateAll(t.db);
    await seedWorld(t.db);
    setHead(HEAD_SHA, true, "2026-10-14T11:00:00Z");
    await provenance(HEAD_SHA);
    expect(await intent(HEAD_SHA)).toBe("published");
    const [other] = await cards();
    expect(other?.linked_issue_number).toBe(42);
    expect(other?.input_hash).toBe(first?.input_hash);
  });

  it("I-INT-TASK-2 a rewritten history without the trailer does not use the stale task, and the original head hits its cache again", async () => {
    setHead(HEAD_SHA, true, "2026-10-14T11:00:00Z");
    await provenance(HEAD_SHA); // task_id now holds #42
    expect(await intent(HEAD_SHA)).toBe("published");
    const [original] = await cards();
    expect(original?.linked_issue_number).toBe(42);

    // Force-push to a trailer-less head; provenance for it has NOT run yet (stale task_id).
    setHead(NEW_HEAD, false, "2026-10-14T12:00:00Z");
    expect(await intent(NEW_HEAD)).toBe("published");
    const rewritten = (await cards()).find((c) => c.head_sha === NEW_HEAD);
    expect(rewritten?.linked_issue_number).toBeNull();

    // Back to the original head: the first card is reused.
    setHead(HEAD_SHA, true, "2026-10-14T13:00:00Z");
    expect(await intent(HEAD_SHA)).toBe("cached");
    expect((await cards()).filter((c) => c.head_sha === HEAD_SHA)).toHaveLength(1);
  });
});
