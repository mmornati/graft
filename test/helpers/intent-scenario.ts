/** Shared world for the intent tests: PR 2 with three files, issue #42, a canary in every patch. */
import { agreeingVerifier, scriptedLlm } from "../../src/llm/fake.js";
import type { GenerateData } from "../../src/modules/intent/job.js";
import type { FakeGitHubApi } from "./fake-github-api.js";
import {
  HEAD_SHA,
  INSTALLATION_ID,
  makeFile,
  makeIssue,
  makePull,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "./github-builders.js";
import type { FakeLlmReply } from "./intent-inputs.js";

export const CANARY = "GRAFT_CANARY_7f3e";

export function canaryPatch(extra = ""): string {
  return `@@ -1,2 +1,3 @@\n-old line\n+new line ${CANARY}\n+// ${CANARY} second line${extra}`;
}

export function scenarioFiles() {
  return [
    makeFile({ path: "src/retry.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
    makeFile({ path: "README.md", additions: 2, deletions: 1, patch: canaryPatch() }),
    makeFile({ path: "package.json", additions: 1, deletions: 1, patch: canaryPatch() }),
  ];
}

export const SCENARIO_TITLE = "Fix the retry loop";
export const SCENARIO_PR_BODY = "Fixes #42\n\nRetries failed webhook deliveries.";

export function loadIntentScenario(
  api: FakeGitHubApi,
  over: Parameters<typeof makePull>[0] = {},
): void {
  api.state.pulls.set(
    PR_NUMBER,
    makePull({
      title: SCENARIO_TITLE,
      body: SCENARIO_PR_BODY,
      changed_files: 3,
      additions: 9,
      deletions: 4,
      ...over,
    }),
  );
  api.state.files.set(PR_NUMBER, scenarioFiles());
  api.state.issues.set(
    42,
    makeIssue(42, { title: "Webhook deliveries are dropped", body: `Issue body ${CANARY}` }),
  );
}

export function writerReply(over: Record<string, unknown> = {}): FakeLlmReply {
  return {
    json: {
      goal: "Retry failed webhook deliveries up to 5 times with exponential backoff.",
      behavior_changes: [
        "Failed deliveries are retried up to 5 times, waiting 1, 2, 4, 8 and 16 seconds.",
        "A delivery that still fails after 5 retries is marked failed and logged at error level.",
      ],
      risk_class: "logic",
      risk_reason: "Changes the delivery loop.",
      out_of_scope_edits: [{ path: "README.md", reason: "Rewords the installation section." }],
      instructions_in_data: false,
      ...over,
    },
  };
}

/** A scripted LLM: strong writer (the floor is sensitive because of package.json) + verifier. */
export function scenarioLlm(
  o: {
    writer?: Parameters<typeof scriptedLlm>[0]["writer"];
    verifier?: Parameters<typeof scriptedLlm>[0]["verifier"];
  } = {},
) {
  return scriptedLlm({
    writer: o.writer ?? writerReply(),
    writerEscalated: writerReply(),
    verifier: o.verifier ?? agreeingVerifier,
  });
}

export const GENERATE_DATA: GenerateData = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  headSha: HEAD_SHA,
  trigger: "opened",
  attempt: 0,
  deliveryId: "d-intent",
};
