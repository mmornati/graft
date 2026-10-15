import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvalCryptoError,
  generateKey,
  keyId,
  open,
  parseKey,
  seal,
} from "../../src/eval/crypto.js";
import {
  assertPrivateLocation,
  createSet,
  EvalCaseError,
  EvalLocationError,
  EvalStoreError,
  io,
  listCaseIds,
  openSet,
  purgeSet,
  readCase,
  readPrivate,
  writeCase,
  writePrivate,
} from "../../src/eval/store.js";
import { renderCase, toTerminalSafe } from "../../src/eval/terminal.js";
import {
  cardInputs,
  cf,
  cleanupTmpDirs,
  pilotCase,
  synCase,
  tmpDir,
} from "../helpers/eval-fixtures.js";

cleanupTmpDirs();
afterEach(() => vi.restoreAllMocks());

const AAD = "pilot-a/cases/pilot-a--shop-1.case.enc";
const key = () => parseKey(generateKey());
const NOW = new Date("2026-10-15T10:00:00Z");

async function pilotSet(name = "pilot-a", k = key()) {
  const root = await tmpDir();
  const dir = path.join(root, name);
  const set = await createSet(
    dir,
    {
      setId: name,
      kind: "pilot",
      description: "",
      encrypted: true,
      consentRef: "agreement 1",
      defaultFloorConfig: { extraSensitiveGlobs: [] },
    },
    { key: k, now: NOW },
  );
  return { root, dir, set, key: k };
}

describe("eval crypto", () => {
  it("U-CRYPT-1 seal then open round-trips (non-ASCII too); two seals of one text differ", () => {
    const k = key();
    const text = "héllo wörld, 日本語 \u{1F680}";
    const a = seal(text, k, AAD);
    const b = seal(text, k, AAD);
    expect(open(a, k, AAD)).toBe(text);
    expect(a).not.toBe(b);
    expect(JSON.parse(a)).toMatchObject({ graftEval: "enc-v1", kid: keyId(k) });
    expect(Buffer.from(JSON.parse(a).iv, "base64")).toHaveLength(12);
    expect(Buffer.from(JSON.parse(a).tag, "base64")).toHaveLength(16);
  });

  it("U-CRYPT-2 a wrong key, a flipped ciphertext or tag byte, or another AAD fail without leaking plaintext", () => {
    const k = key();
    const secret = "TOP-SECRET-PLAINTEXT";
    const env = seal(secret, k, AAD);
    const flip = (field: "ct" | "tag") => {
      const e = JSON.parse(env);
      const buf = Buffer.from(e[field], "base64");
      buf[0] = (buf[0] as number) ^ 1;
      e[field] = buf.toString("base64");
      return JSON.stringify(e);
    };
    const attempts: (() => string)[] = [
      () => open(env, key(), AAD),
      () => open(flip("ct"), k, AAD),
      () => open(flip("tag"), k, AAD),
      () => open(env, k, "pilot-b/cases/pilot-a--shop-1.case.enc"),
      () => open("not json", k, AAD),
    ];
    for (const attempt of attempts) {
      let err: unknown;
      try {
        attempt();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EvalCryptoError);
      expect(String((err as Error).message)).not.toContain(secret);
    }
  });

  it("U-CRYPT-3 parseKey rejects 31 and 33 bytes and non-base64", () => {
    const b64 = (n: number) => Buffer.alloc(n, 1).toString("base64");
    expect(parseKey(b64(32))).toHaveLength(32);
    expect(() => parseKey(b64(31))).toThrow(EvalCryptoError);
    expect(() => parseKey(b64(33))).toThrow(EvalCryptoError);
    expect(() => parseKey("not base64 !!!")).toThrow(EvalCryptoError);
    expect(() => parseKey("")).toThrow(EvalCryptoError);
  });

  it("U-CRYPT-4 keyId is stable and 8 hex characters", () => {
    const k = key();
    expect(keyId(k)).toBe(keyId(Buffer.from(k)));
    expect(keyId(k)).toMatch(/^[0-9a-f]{8}$/);
    expect(generateKey()).toHaveLength(44);
  });

  it("U-CRYPT-5 a sealed case file contains none of the title, body or patch", async () => {
    const { set } = await pilotSet();
    const inputs = cardInputs(
      [cf("src/secret-area/file.ts", { patch: "@@ -1 +1 @@\n-aaa\n+DISTINCT_PATCH_TEXT" })],
      {
        pr: {
          number: 101,
          title: "DISTINCT_TITLE",
          body: "DISTINCT_BODY",
          additions: 1,
          deletions: 1,
          changedFiles: 1,
        },
      },
    );
    await writeCase(set, pilotCase("pilot-a", 1, {}, inputs));
    const raw = await fs.readFile(path.join(set.dir, "cases/pilot-a--shop-1.case.enc"), "utf8");
    for (const s of [
      "DISTINCT_TITLE",
      "DISTINCT_BODY",
      "DISTINCT_PATCH_TEXT",
      "secret-area",
      "shop-demo",
    ]) {
      expect(raw).not.toContain(s);
    }
  });
});

describe("eval store", () => {
  it("U-STORE-1 a pilot set inside a directory with .git (any ancestor) is refused; outside is fine; modes 0700/0600", async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, "a/b"), { recursive: true });
    const meta = {
      setId: "pilot-a",
      kind: "pilot" as const,
      description: "",
      encrypted: true,
      consentRef: "x",
      defaultFloorConfig: { extraSensitiveGlobs: [] },
    };
    await expect(
      createSet(path.join(root, "a/b/pilot-a"), meta, { key: key(), now: NOW }),
    ).rejects.toBeInstanceOf(EvalLocationError);
    await expect(assertPrivateLocation(path.join(root, "a"))).rejects.toBeInstanceOf(
      EvalLocationError,
    );
    // a .git FILE (worktree) counts too
    const root2 = await tmpDir();
    await fs.writeFile(path.join(root2, ".git"), "gitdir: elsewhere\n");
    await expect(assertPrivateLocation(path.join(root2, "x"))).rejects.toBeInstanceOf(
      EvalLocationError,
    );

    const { dir, set } = await pilotSet();
    await writeCase(set, pilotCase("pilot-a", 1));
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, "cases"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, "set.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dir, "cases/pilot-a--shop-1.case.enc"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("U-STORE-2 a pilot set needs a consent reference", async () => {
    const root = await tmpDir();
    for (const consentRef of [null, "", "  "]) {
      await expect(
        createSet(
          path.join(root, "pilot-a"),
          {
            setId: "pilot-a",
            kind: "pilot",
            description: "",
            encrypted: true,
            consentRef,
            defaultFloorConfig: { extraSensitiveGlobs: [] },
          },
          { key: key(), now: NOW },
        ),
      ).rejects.toBeInstanceOf(EvalStoreError);
    }
  });

  it("U-STORE-3 writeCase writes only .case.enc in a pilot set and only .case.json in a synthetic set", async () => {
    const { set } = await pilotSet();
    await writeCase(set, pilotCase("pilot-a", 1));
    expect(await fs.readdir(path.join(set.dir, "cases"))).toEqual(["pilot-a--shop-1.case.enc"]);
    // the bytes are an envelope, not the case JSON
    const onDisk = JSON.parse(
      await fs.readFile(path.join(set.dir, "cases/pilot-a--shop-1.case.enc"), "utf8"),
    );
    expect(Object.keys(onDisk).sort()).toEqual(["ct", "graftEval", "iv", "kid", "tag"]);
    expect(onDisk.inputs).toBeUndefined();
    expect(await listCaseIds(set)).toEqual(["pilot-a--shop-1"]);
    await expect(writeCase(set, synCase("syn-1-a"))).rejects.toBeInstanceOf(EvalStoreError);

    const root = await tmpDir();
    const syn = await createSet(
      path.join(root, "synthetic"),
      {
        setId: "synthetic",
        kind: "synthetic",
        description: "t",
        encrypted: false,
        consentRef: null,
        defaultFloorConfig: { extraSensitiveGlobs: [] },
      },
      { key: null, now: NOW },
    );
    await writeCase(syn, synCase("syn-001-a"));
    expect(await fs.readdir(path.join(syn.dir, "cases"))).toEqual(["syn-001-a.case.json"]);
    expect((await readCase(syn, "syn-001-a")).id).toBe("syn-001-a");
  });

  it("U-STORE-4 readCase refuses a planted .case.json in a pilot set and a .case.enc in a synthetic set", async () => {
    const { set } = await pilotSet();
    await fs.writeFile(
      path.join(set.dir, "cases/pilot-a--shop-2.case.json"),
      JSON.stringify(pilotCase("pilot-a", 2)),
    );
    await expect(readCase(set, "pilot-a--shop-2")).rejects.toBeInstanceOf(EvalCaseError);
    await expect(readCase(set, "pilot-a--shop-2")).rejects.toThrow(/plaintext/);
    expect(await listCaseIds(set)).toEqual([]);

    const root = await tmpDir();
    const syn = await createSet(
      path.join(root, "synthetic"),
      {
        setId: "synthetic",
        kind: "synthetic",
        description: "t",
        encrypted: false,
        consentRef: null,
        defaultFloorConfig: { extraSensitiveGlobs: [] },
      },
      { key: null, now: NOW },
    );
    await fs.writeFile(path.join(syn.dir, "cases/syn-001-a.case.enc"), "{}");
    await expect(readCase(syn, "syn-001-a")).rejects.toThrow(/sealed/);
  });

  it("U-STORE-5 openSet with a key of another id fails before decrypting anything", async () => {
    const { dir } = await pilotSet();
    const spy = vi.spyOn(fs, "readFile");
    await expect(openSet(dir, { key: key() })).rejects.toThrow(
      /wrong GRAFT_EVAL_KEY for set pilot-a/,
    );
    expect(spy.mock.calls.every((c) => String(c[0]).endsWith("set.json"))).toBe(true);
    await expect(openSet(dir, { key: null })).rejects.toThrow(/GRAFT_EVAL_KEY is required/);
  });

  it("U-STORE-6 a case file moved from set A to set B (same key) cannot be opened", async () => {
    const k = key();
    const a = await pilotSet("pilot-a", k);
    const b = await pilotSet("pilot-b", k);
    await writeCase(a.set, pilotCase("pilot-a", 1));
    // Same name inside B, so only the AAD differs.
    await fs.copyFile(
      path.join(a.dir, "cases/pilot-a--shop-1.case.enc"),
      path.join(b.dir, "cases/pilot-a--shop-1.case.enc"),
    );
    await expect(readCase(b.set, "pilot-a--shop-1")).rejects.toBeInstanceOf(EvalCaseError);
    // Renamed inside the same set: also refused.
    await fs.copyFile(
      path.join(a.dir, "cases/pilot-a--shop-1.case.enc"),
      path.join(a.dir, "cases/pilot-a--shop-9.case.enc"),
    );
    await expect(readCase(a.set, "pilot-a--shop-9")).rejects.toBeInstanceOf(EvalCaseError);

    // The binding is the AAD itself: a sealed private file moved to another set, or renamed, does not open.
    await writePrivate(a.set, "cache/one.json", "{}");
    await fs.mkdir(path.join(b.dir, "cache"), { recursive: true });
    await fs.copyFile(
      path.join(a.dir, "cache/one.json.enc"),
      path.join(b.dir, "cache/one.json.enc"),
    );
    await expect(readPrivate(b.set, "cache/one.json")).rejects.toBeInstanceOf(EvalCryptoError);
    await fs.copyFile(
      path.join(a.dir, "cache/one.json.enc"),
      path.join(a.dir, "cache/two.json.enc"),
    );
    await expect(readPrivate(a.set, "cache/two.json")).rejects.toBeInstanceOf(EvalCryptoError);
    expect(await readPrivate(a.set, "cache/one.json")).toBe("{}");
  });

  it("U-STORE-7 a failing rename leaves the old file intact and no temp file", async () => {
    const { set } = await pilotSet();
    await writeCase(set, pilotCase("pilot-a", 1, { tags: ["old"] }));
    const before = await fs.readFile(path.join(set.dir, "cases/pilot-a--shop-1.case.enc"), "utf8");
    vi.spyOn(io, "rename").mockRejectedValueOnce(new Error("disk full"));
    await expect(writeCase(set, pilotCase("pilot-a", 1, { tags: ["new"] }))).rejects.toThrow(
      "disk full",
    );
    expect(await fs.readFile(path.join(set.dir, "cases/pilot-a--shop-1.case.enc"), "utf8")).toBe(
      before,
    );
    expect(await fs.readdir(path.join(set.dir, "cases"))).toEqual(["pilot-a--shop-1.case.enc"]);
    expect((await readCase(set, "pilot-a--shop-1")).tags).toEqual(["old"]);
  });

  it("U-STORE-8 purgeSet: a wrong confirm or the synthetic set is refused; ok removes the directory and logs without paths", async () => {
    const { root, dir, set } = await pilotSet();
    await writeCase(set, pilotCase("pilot-a", 1));
    await writeCase(
      set,
      pilotCase(
        "pilot-a",
        2,
        {},
        cardInputs([cf("a.ts")], {
          pr: { number: 102, title: "t", body: "", additions: 1, deletions: 1, changedFiles: 1 },
        }),
      ),
    );
    const base = { by: "tester", now: NOW, evalRoot: root };
    await expect(purgeSet(dir, { ...base, confirm: "pilot-b" })).rejects.toBeInstanceOf(
      EvalStoreError,
    );
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    await expect(
      purgeSet(path.join(root, "missing"), { ...base, confirm: "x" }),
    ).rejects.toBeInstanceOf(EvalStoreError);

    const synRoot = await tmpDir();
    await createSet(
      path.join(synRoot, "synthetic"),
      {
        setId: "synthetic",
        kind: "synthetic",
        description: "t",
        encrypted: false,
        consentRef: null,
        defaultFloorConfig: { extraSensitiveGlobs: [] },
      },
      { key: null, now: NOW },
    );
    await expect(
      purgeSet(path.join(synRoot, "synthetic"), { ...base, confirm: "synthetic" }),
    ).rejects.toThrow(/synthetic/);

    const res = await purgeSet(dir, { ...base, confirm: "pilot-a" });
    expect(res.caseCount).toBe(2);
    await expect(fs.stat(dir)).rejects.toThrow();
    const log = (await fs.readFile(path.join(root, "purge-log.jsonl"), "utf8")).trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] as string)).toEqual({
      setId: "pilot-a",
      purgedAt: NOW.toISOString(),
      caseCount: 2,
      by: "tester",
    });
    expect(log[0]).not.toContain(root);
  });

  it("U-STORE-9 cache entries of a pilot set are sealed (.json.enc) and hold no plaintext goal", async () => {
    const { set } = await pilotSet();
    await writePrivate(set, "cache/abc.json", JSON.stringify({ goal: "PLAINTEXT_GOAL" }));
    expect(await fs.readdir(path.join(set.dir, "cache"))).toEqual(["abc.json.enc"]);
    expect(await fs.readFile(path.join(set.dir, "cache/abc.json.enc"), "utf8")).not.toContain(
      "PLAINTEXT_GOAL",
    );
    expect(JSON.parse((await readPrivate(set, "cache/abc.json")) as string)).toEqual({
      goal: "PLAINTEXT_GOAL",
    });
    expect(await readPrivate(set, "cache/none.json")).toBeNull();
    await expect(readPrivate(set, "../escape.json")).rejects.toBeInstanceOf(EvalStoreError);
  });
});

describe("eval terminal", () => {
  it("U-TERM-1 toTerminalSafe shows controls and format characters visibly and keeps newline and tab", () => {
    const out = toTerminalSafe("\u001b[2J\u009b31m\u202eok\n\tx");
    for (const ch of ["\u001b", "\u009b", "\u202e"]) expect(out.includes(ch)).toBe(false);
    expect(out).toContain("[U+001B]");
    expect(out).toContain("[U+009B]");
    expect(out).toContain("[U+202E]");
    expect(out).toContain("\n\t");
  });

  it("U-TERM-2 renderCase numbers files from 1 in order and shows no floor or card unless a result is given", () => {
    const c = synCase("syn-901-a", {
      inputs: cardInputs([cf("src/zeta.ts"), cf("src/alpha.ts"), cf("package.json")]),
    });
    const text = renderCase(c);
    const lines = text.split("\n");
    expect(lines.filter((l) => /^\d+\. /.test(l)).map((l) => l.split(" ")[2])).toEqual([
      "src/zeta.ts",
      "src/alpha.ts",
      "package.json",
    ]);
    expect(text).toContain("1. modified src/zeta.ts");
    expect(text).not.toMatch(/floor|risk_class|dependency_manifest|Graft result/i);
  });
});
