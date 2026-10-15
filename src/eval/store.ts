/**
 * Case-set storage (E4 to E7, T3). A pilot set lives outside every git working tree, its files
 * are AES-256-GCM envelopes bound to `<setId>/<relative path>`, and one `rm -r` removes it.
 * This module never touches Graft's database.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CASE_ID, type EvalCase, evalCaseSchema, floorConfigSchema } from "./case-schema.js";
import { EvalCryptoError, keyId, open, seal } from "./crypto.js";

export class EvalLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalLocationError";
  }
}

export class EvalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalStoreError";
  }
}

/** A case file failed validation or decryption; carries the case id (never its content). */
export class EvalCaseError extends Error {
  constructor(
    readonly caseId: string,
    message: string,
  ) {
    super(`case ${caseId}: ${message}`);
    this.name = "EvalCaseError";
  }
}

const SET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const setMetaSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    setId: z.string().regex(SET_ID),
    kind: z.enum(["synthetic", "pilot"]),
    description: z.string().max(500),
    encrypted: z.boolean(),
    keyId: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .nullable(),
    consentRef: z.string().max(500).nullable(),
    defaultFloorConfig: floorConfigSchema,
    createdAt: z.string(),
  })
  .superRefine((m, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (m.kind === "synthetic") {
      if (m.setId !== "synthetic") bad("the synthetic set must have setId synthetic");
      if (m.encrypted || m.keyId !== null || m.consentRef !== null) {
        bad("a synthetic set is plaintext: encrypted false, keyId null, consentRef null");
      }
    } else {
      if (m.setId === "synthetic") bad("setId synthetic is reserved");
      if (!m.encrypted || m.keyId === null) bad("a pilot set must be encrypted with a keyId");
    }
  });
export type SetMeta = z.infer<typeof setMetaSchema>;

export interface CaseSet {
  dir: string;
  meta: SetMeta;
  key: Buffer | null;
}

/** Replaceable in tests (an injected failing rename). */
export const io = {
  rename: (from: string, to: string): Promise<void> => fs.rename(from, to),
};

const REL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function checkRel(rel: string): string {
  if (!REL.test(rel)) throw new EvalStoreError("invalid relative path");
  return rel;
}

const isPilot = (set: CaseSet): boolean => set.meta.kind === "pilot";
const fileMode = (set: CaseSet): number => (isPilot(set) ? 0o600 : 0o644);
const dirMode = (set: CaseSet): number => (isPilot(set) ? 0o700 : 0o755);

async function mkdirs(dir: string, mode: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

/** Temp file in the same directory, fsync, rename. A failed rename leaves the old file intact. */
export async function writeFileAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", mode);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** The real path of `p`, resolving symlinks in the part that exists. */
async function realpathLoose(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return path.join(real, ...rest.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest.reverse());
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when the directory or an ancestor holds a `.git` entry (file or directory). */
export async function insideGitWorkingTree(dir: string): Promise<boolean> {
  let cur = await realpathLoose(dir);
  for (;;) {
    if (await exists(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** E5: a pilot set must not be inside any git working tree. */
export async function assertPrivateLocation(dir: string): Promise<void> {
  if (await insideGitWorkingTree(dir)) {
    throw new EvalLocationError(
      "a pilot case set must be outside every git working tree (found a .git entry above it)",
    );
  }
}

export async function createSet(
  dir: string,
  meta: Omit<SetMeta, "schemaVersion" | "createdAt" | "keyId">,
  o: { key: Buffer | null; now: Date },
): Promise<CaseSet> {
  const abs = path.resolve(dir);
  const pilot = meta.kind === "pilot";
  if (pilot) {
    await assertPrivateLocation(abs);
    if (!meta.consentRef || meta.consentRef.trim() === "") {
      throw new EvalStoreError("a pilot set needs --consent-ref (the pilot agreement reference)");
    }
    if (!o.key) throw new EvalStoreError("GRAFT_EVAL_KEY is required to create a pilot set");
  }
  const full: SetMeta = setMetaSchema.parse({
    ...meta,
    schemaVersion: 1,
    encrypted: pilot,
    keyId: pilot && o.key ? keyId(o.key) : null,
    consentRef: pilot ? (meta.consentRef ?? null) : null,
    createdAt: o.now.toISOString(),
  });
  if (await exists(path.join(abs, "set.json"))) {
    throw new EvalStoreError("a case set already exists in this directory");
  }
  const set: CaseSet = { dir: abs, meta: full, key: pilot ? o.key : null };
  await mkdirs(abs, dirMode(set));
  await mkdirs(path.join(abs, "cases"), dirMode(set));
  await fs.chmod(abs, dirMode(set));
  await writeFileAtomic(
    path.join(abs, "set.json"),
    `${JSON.stringify(full, null, 2)}\n`,
    fileMode(set),
  );
  return set;
}

export async function openSet(dir: string, o: { key: Buffer | null }): Promise<CaseSet> {
  const abs = path.resolve(dir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(abs, "set.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EvalStoreError("not a case set: set.json is missing");
    }
    throw err;
  }
  let meta: SetMeta;
  try {
    meta = setMetaSchema.parse(JSON.parse(raw));
  } catch {
    throw new EvalStoreError("set.json is not valid");
  }
  if (meta.kind === "pilot") await assertPrivateLocation(abs);
  if (meta.encrypted) {
    if (!o.key) throw new EvalStoreError("GRAFT_EVAL_KEY is required for this set");
    if (keyId(o.key) !== meta.keyId) {
      throw new EvalStoreError(`wrong GRAFT_EVAL_KEY for set ${meta.setId}`);
    }
  }
  return { dir: abs, meta, key: meta.encrypted ? o.key : null };
}

const caseExt = (set: CaseSet): string => (set.meta.encrypted ? ".case.enc" : ".case.json");
const otherExt = (set: CaseSet): string => (set.meta.encrypted ? ".case.json" : ".case.enc");

function checkId(id: string): string {
  if (!CASE_ID.test(id)) throw new EvalStoreError("invalid case id");
  return id;
}

export async function listCaseIds(set: CaseSet): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(set.dir, "cases"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const ext = caseExt(set);
  return names
    .filter((n) => n.endsWith(ext))
    .map((n) => n.slice(0, -ext.length))
    .sort();
}

/** Files in `cases/` that do not belong in this kind of set (a planted plaintext case, say). */
export async function strayCaseFiles(set: CaseSet): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(set.dir, "cases"));
  } catch {
    return [];
  }
  const ok = caseExt(set);
  return names.filter((n) => !n.endsWith(ok)).sort();
}

const aadFor = (set: CaseSet, rel: string): string => `${set.meta.setId}/${rel}`;

export async function readCase(set: CaseSet, id: string): Promise<EvalCase> {
  checkId(id);
  if (await exists(path.join(set.dir, "cases", `${id}${otherExt(set)}`))) {
    throw new EvalCaseError(
      id,
      set.meta.encrypted
        ? "a plaintext case file in an encrypted set is refused"
        : "a sealed case file in a plaintext set is refused",
    );
  }
  const rel = `cases/${id}${caseExt(set)}`;
  let text: string;
  try {
    text = await fs.readFile(path.join(set.dir, rel), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new EvalCaseError(id, "not found");
    throw err;
  }
  if (set.meta.encrypted) {
    if (!set.key) throw new EvalCaseError(id, "no key");
    try {
      text = open(text, set.key, aadFor(set, rel));
    } catch (err) {
      if (err instanceof EvalCryptoError) throw new EvalCaseError(id, err.message);
      throw err;
    }
  }
  let parsed: EvalCase;
  try {
    parsed = evalCaseSchema.parse(JSON.parse(text));
  } catch (err) {
    // Issue paths and messages hold no case content; the input is never echoed.
    const where =
      err instanceof z.ZodError
        ? err.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")
        : "not valid JSON";
    throw new EvalCaseError(id, `schema validation failed: ${where}`);
  }
  if (parsed.id !== id) throw new EvalCaseError(id, "the id inside the file differs from its name");
  if (parsed.source.kind !== set.meta.kind) {
    throw new EvalCaseError(id, "the case kind does not match the set kind");
  }
  if (parsed.source.kind === "pilot" && parsed.source.setId !== set.meta.setId) {
    throw new EvalCaseError(id, "the case belongs to another set");
  }
  return parsed;
}

export async function writeCase(set: CaseSet, c: EvalCase): Promise<void> {
  checkId(c.id);
  const valid = evalCaseSchema.parse(c);
  if (valid.source.kind !== set.meta.kind) {
    throw new EvalStoreError("the case kind does not match the set kind");
  }
  if (isPilot(set) && !set.meta.encrypted) {
    throw new EvalStoreError("a pilot set must never hold plaintext cases");
  }
  const rel = `cases/${valid.id}${caseExt(set)}`;
  const json = `${JSON.stringify(valid, null, 2)}\n`;
  let data = json;
  if (set.meta.encrypted) {
    if (!set.key) throw new EvalStoreError("no key to seal the case");
    data = seal(json, set.key, aadFor(set, rel));
  } else if (set.key) {
    throw new EvalStoreError("a plaintext set must not be written sealed");
  }
  await mkdirs(path.join(set.dir, "cases"), dirMode(set));
  await writeFileAtomic(path.join(set.dir, rel), data, fileMode(set));
}

/** Private files (cache entries): sealed with `.enc` appended in an encrypted set. */
export async function readPrivate(set: CaseSet, rel: string): Promise<string | null> {
  checkRel(rel);
  const physical = set.meta.encrypted ? `${rel}.enc` : rel;
  let text: string;
  try {
    text = await fs.readFile(path.join(set.dir, physical), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!set.meta.encrypted) return text;
  if (!set.key) throw new EvalStoreError("no key to open the file");
  return open(text, set.key, aadFor(set, physical));
}

export async function writePrivate(set: CaseSet, rel: string, text: string): Promise<void> {
  checkRel(rel);
  const physical = set.meta.encrypted ? `${rel}.enc` : rel;
  let data = text;
  if (set.meta.encrypted) {
    if (!set.key) throw new EvalStoreError("no key to seal the file");
    data = seal(text, set.key, aadFor(set, physical));
  }
  const file = path.join(set.dir, physical);
  await mkdirs(path.dirname(file), dirMode(set));
  await writeFileAtomic(file, data, fileMode(set));
}

/** Reports are plaintext (E8: they hold no code). */
export async function writePlain(set: CaseSet, rel: string, text: string): Promise<void> {
  checkRel(rel);
  const file = path.join(set.dir, rel);
  await mkdirs(path.dirname(file), dirMode(set));
  await writeFileAtomic(file, text, fileMode(set));
}

export async function purgeSet(
  dir: string,
  o: { confirm: string; by: string; now: Date; evalRoot: string },
): Promise<{ caseCount: number }> {
  const abs = path.resolve(dir);
  let meta: SetMeta;
  try {
    meta = setMetaSchema.parse(JSON.parse(await fs.readFile(path.join(abs, "set.json"), "utf8")));
  } catch {
    throw new EvalStoreError("not a case set: set.json is missing or invalid");
  }
  if (meta.kind === "synthetic") throw new EvalStoreError("the synthetic set cannot be purged");
  if (o.confirm !== meta.setId) {
    throw new EvalStoreError("--confirm must equal the set id");
  }
  let caseCount = 0;
  try {
    caseCount = (await fs.readdir(path.join(abs, "cases"))).filter((n) =>
      /\.case\.(enc|json)$/.test(n),
    ).length;
  } catch {
    // no cases directory
  }
  await fs.rm(abs, { recursive: true, force: true });
  const root = path.resolve(o.evalRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    setId: meta.setId,
    purgedAt: o.now.toISOString(),
    caseCount,
    by: o.by,
  });
  await fs.appendFile(path.join(root, "purge-log.jsonl"), `${line}\n`, { mode: 0o600 });
  return { caseCount };
}
