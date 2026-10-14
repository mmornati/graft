import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { trackInstallations } from "../../src/modules/installations/handlers.js";
import {
  getActiveRepository,
  listActiveRepositories,
} from "../../src/modules/installations/index.js";
import { createTestApp, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { loadFixture } from "../helpers/fixtures.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(() => truncateAll(t.db));

type Payload = Record<string, unknown>;

async function apply(name: string, mutate?: (p: Payload) => void, clockOverride?: Date) {
  const { event, payload } = loadFixture(name);
  mutate?.(payload);
  const ctx = jobContext(t);
  if (clockOverride) ctx.clock = { now: () => clockOverride };
  await trackInstallations.handle(
    { id: `d-${name}`, deliveryId: `d-${name}`, name: event, payload } as never,
    ctx,
  );
}

const installation = () => t.db.selectFrom("installations").selectAll().executeTakeFirst();
const repos = () => t.db.selectFrom("repositories").selectAll().orderBy("id").execute();
const strip = <T extends { updated_at: Date }>(rows: T[]) =>
  rows.map(({ updated_at: _u, ...rest }) => rest);

describe("installations module", () => {
  it("I-INST-1 installation.created -> installation row and two repository rows with fixture values", async () => {
    await apply("installation.created");
    expect(await installation()).toMatchObject({
      id: 1000001,
      account_id: 9000001,
      account_login: "graft-sandbox",
      account_type: "Organization",
      repository_selection: "selected",
      suspended_at: null,
      deleted_at: null,
    });
    const rs = await repos();
    expect(rs.map((r) => [r.id, r.full_name, r.private, r.removed_at])).toEqual([
      [2000001, "graft-sandbox/sample-ts", true, null],
      [2000002, "graft-sandbox/sample-py", true, null],
    ]);
    expect(rs[0]?.updated_at).toEqual(FIXED_NOW);
    expect((await listActiveRepositories(t.db, 1000001)).map((r) => r.id)).toEqual([
      2000001, 2000002,
    ]);
    expect((await getActiveRepository(t.db, 2000001))?.full_name).toBe("graft-sandbox/sample-ts");
  });

  it("I-INST-2 processing installation.created twice leaves identical rows (ignoring updated_at)", async () => {
    await apply("installation.created");
    const first = { i: strip([(await installation()) as never]), r: strip(await repos()) };
    await apply("installation.created", undefined, new Date("2026-11-01T00:00:00Z"));
    const second = { i: strip([(await installation()) as never]), r: strip(await repos()) };
    expect(second).toEqual(first);
  });

  it("I-INST-2b processing installation.deleted and suspend twice keeps the first deleted_at and suspended_at", async () => {
    await apply("installation.created");
    await apply("installation.deleted");
    await apply("installation.deleted", undefined, new Date("2026-11-01T00:00:00Z"));
    expect((await installation())?.deleted_at).toEqual(FIXED_NOW);

    await apply("installation.suspend");
    await apply("installation.suspend", undefined, new Date("2026-11-02T00:00:00Z"));
    expect((await installation())?.suspended_at).toEqual(FIXED_NOW);
  });

  it("I-INST-3 added then removed sets removed_at; re-adding clears it", async () => {
    await apply("installation.created");
    await apply("installation_repositories.removed");
    const removed = (await repos()).find((r) => r.id === 2000002);
    expect(removed?.removed_at).toEqual(FIXED_NOW);
    expect((await repos()).find((r) => r.id === 2000001)?.removed_at).toBeNull();
    expect(await getActiveRepository(t.db, 2000002)).toBeUndefined();

    await apply("installation_repositories.added");
    expect((await repos()).find((r) => r.id === 2000002)?.removed_at).toBeNull();
    expect(await getActiveRepository(t.db, 2000002)).toBeDefined();
  });

  it("I-INST-4 installation_repositories.added for an unknown installation creates it from the payload", async () => {
    expect(await installation()).toBeUndefined();
    await apply("installation_repositories.added");
    expect(await installation()).toMatchObject({
      id: 1000001,
      account_login: "graft-sandbox",
      account_type: "Organization",
      repository_selection: "selected",
    });
    expect((await repos()).map((r) => r.id)).toEqual([2000002]);
  });

  it("I-INST-5 installation.deleted sets deleted_at and removes all repositories", async () => {
    await apply("installation.created");
    await apply("installation.deleted");
    expect((await installation())?.deleted_at).toEqual(FIXED_NOW);
    const rs = await repos();
    expect(rs).toHaveLength(2);
    for (const r of rs) expect(r.removed_at).toEqual(FIXED_NOW);
    expect(await listActiveRepositories(t.db, 1000001)).toEqual([]);
  });

  it("I-INST-6 suspend then unsuspend sets then clears suspended_at", async () => {
    await apply("installation.created");
    await apply("installation.suspend");
    expect((await installation())?.suspended_at).toEqual(FIXED_NOW);
    await apply("installation.unsuspend");
    expect((await installation())?.suspended_at).toBeNull();
  });

  it("I-INST-7 a rename (same repo ID, new full_name) in an added payload updates full_name", async () => {
    await apply("installation.created");
    await apply("installation_repositories.added", (p) => {
      const added = p.repositories_added as { full_name: string; name: string }[];
      const first = added[0];
      if (first) {
        first.full_name = "graft-sandbox/sample-py-renamed";
        first.name = "sample-py-renamed";
      }
    });
    expect((await repos()).find((r) => r.id === 2000002)?.full_name).toBe(
      "graft-sandbox/sample-py-renamed",
    );
  });

  it("new_permissions_accepted refreshes repository_selection", async () => {
    await apply("installation.created");
    await apply("installation.new_permissions_accepted", (p) => {
      (p.installation as { repository_selection: string }).repository_selection = "all";
    });
    expect((await installation())?.repository_selection).toBe("all");
  });
});
