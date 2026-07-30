import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, value, "utf8");
  await rename(temp, path);
}

export async function withFileLock<T>(path: string, action: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
        return await action();
      } finally {
        await handle.close();
        await unlink(path).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > 60_000) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for state lock ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}
