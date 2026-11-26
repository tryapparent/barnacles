import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RepositoryPolicy = { repository_name(value: string): string };

export function repository(value: unknown, policy: RepositoryPolicy): string {
  const name = typeof value === "string" ? policy.repository_name(value) : "";
  if (!name) throw Error("Expected owner/repository");
  return name;
}

function pollMinutes(text: string) {
  if (!/^[1-9]\d{0,3}$/.test(text) || Number(text) > 1440) return null;
  return Number(text);
}

export function readPollMinutes(path: string) {
  try {
    const minutes = pollMinutes(readFileSync(path, "utf8").trim());
    if (minutes === null) throw Error("Invalid saved polling interval");
    return minutes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 15;
    throw error;
  }
}

export function savePollMinutes(path: string, text: string) {
  const minutes = pollMinutes(text);
  if (minutes === null) return null;
  const staging = mkdtempSync(join(dirname(path), ".poll-settings-"));
  try {
    const pending = join(staging, "minutes");
    writeFileSync(pending, minutes + "\n", { mode: 0o600 });
    renameSync(pending, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return minutes;
}
