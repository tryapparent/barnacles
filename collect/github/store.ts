import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function directory(path: string, privateMode = true) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (privateMode && (stat.mode & 0o077))) throw Error("Expected a private GitHub collector directory");
  return path;
}

function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomic(path: string, content: string, immutable = false) {
  const root = dirname(path);
  const temporary = join(root, ".staging-" + randomUUID());
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!immutable) {
    renameSync(temporary, path);
  } else {
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { unlinkSync(temporary); }
  }
  syncDirectory(root);
}

export function readState<T>(path: string, initial: () => T): T {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial();
    throw Error("GitHub checkpoint is unreadable");
  }
}

export function publishHealth(root: string, scope: string, lines: string[]) {
  atomic(join(root, "github-" + scope + "-" + randomUUID() + ".jsonl"), lines.join("\n") + "\n", true);
}

type Batch = { keys: string[]; content: string };
type EvidenceSpool = { root: string; staged: string; outbox: string };

export function evidenceSpool(state: string, root: string) {
  const layout = { root: directory(root), staged: directory(join(state, "staged")), outbox: join(state, "outbox.json") };
  flush(layout);
  return layout;
}

function flush(spool: EvidenceSpool) {
  const pending = readState<Batch | null>(spool.outbox, () => null);
  if (!pending) return;
  const filename = digest(pending.keys.join(":")) + ".jsonl";
  atomic(join(spool.root, filename), pending.content, true);
  for (const key of pending.keys) {
    const marker = join(spool.staged, key);
    if (!existsSync(marker)) closeSync(openSync(marker, "wx", 0o600));
  }
  syncDirectory(spool.staged);
  unlinkSync(spool.outbox);
  syncDirectory(dirname(spool.outbox));
}

export function publishEvidence(spool: EvidenceSpool, variants: Map<string, () => string>) {
  const fresh = [...variants].filter(([key]) => !existsSync(join(spool.staged, key)));
  if (!fresh.length) return;
  const batch: Batch = { keys: fresh.map(([key]) => key), content: fresh.map(([, render]) => render()).join("\n") + "\n" };
  atomic(spool.outbox, JSON.stringify(batch));
  flush(spool);
}
