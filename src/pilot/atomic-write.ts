/**
 * Replace a file atomically: write a temp file in the same directory (same file system, so the
 * rename is atomic), fsync it, then rename it over the original. A crash or a failing disk leaves
 * either the old file or the new one, never a truncated one. The original's mode is kept (0600 for
 * a new file).
 */
import { randomBytes } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteHooks {
  /** Runs after the temp file is written and synced, before the rename (tests inject failures). */
  beforeRename?: () => void | Promise<void>;
}

export async function writeFileAtomic(
  file: string,
  data: string,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const mode = await stat(file).then(
    (s) => s.mode & 0o777,
    () => 0o600,
  );
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const handle = await open(tmp, "wx", mode);
  try {
    try {
      await handle.writeFile(data, "utf8");
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.beforeRename?.();
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
