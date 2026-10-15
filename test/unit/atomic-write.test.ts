import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/pilot/atomic-write.js";

describe("writeFileAtomic", () => {
  it("U-ATOMIC-1 replaces the file, keeps its mode and leaves no temp file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graft-atomic-"));
    const file = path.join(dir, "allow.txt");
    writeFileSync(file, "old\n");
    chmodSync(file, 0o640);
    await writeFileAtomic(file, "new\n");
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["allow.txt"]);
    // A new file is private.
    const fresh = path.join(dir, "fresh.txt");
    await writeFileAtomic(fresh, "x");
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it("U-ATOMIC-2 a failure before the rename leaves the original intact and removes the temp file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graft-atomic-"));
    const file = path.join(dir, "allow.txt");
    writeFileSync(file, "original\n");
    await expect(
      writeFileAtomic(file, "partial\n", {
        beforeRename: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(readFileSync(file, "utf8")).toBe("original\n");
    expect(readdirSync(dir)).toEqual(["allow.txt"]);
  });
});
