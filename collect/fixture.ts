import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";

type Step = { $: "Step"; session: string; line: string } | { $: "Rejected" };
type Projection = {
  run(id: string, thread: string, session: string, started: string, completed: string): string;
  rollout(session: string, envelope: string, kind: string, metadataId: string, callId: string,
    timestamp: string, ordinal: number): Step;
};

const object = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const string = (value: unknown) => typeof value === "string" ? value : "";
const millis = (value: unknown) => String(Date.parse(string(value)));

function decode(line: string) {
  try {
    return object(JSON.parse(line));
  } catch {
    return {};
  }
}

export async function fixturePolicy(scratch: string) {
  return loadPolicy<Projection>(await buildPolicy(scratch, new URL("./project.bend", import.meta.url), "collect.mjs"));
}

export function projectRollout(policy: Projection, raw: string) {
  let session = "";
  const output: string[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const envelope = decode(line);
    const payload = object(envelope.payload);
    const step = policy.rollout(session, string(envelope.type), string(payload.type), string(payload.id),
      string(payload.call_id),
      millis(envelope.timestamp), index + 1);
    if (step.$ === "Rejected") throw Error("Invalid or conflicting Codex session identity");
    session = step.session;
    if (step.line) output.push(step.line);
  }
  return output;
}

export function projectRun(policy: Projection, raw: string) {
  const run = object(JSON.parse(raw));
  const line = policy.run(string(run.id), string(run.threadId), string(run.sessionId), millis(run.startedAt), millis(run.completedAt));
  if (!line) throw Error("Invalid T3 run identity or clocks");
  return line;
}

if (import.meta.main) {
  const [workdir, ...extra] = process.argv.slice(2);
  if (!workdir || extra.length) throw Error("Expected the candidate work directory");
  const policy = await fixturePolicy(workdir);
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const events = projectRollout(policy, fixture("codex.jsonl"));
  const run = projectRun(policy, fixture("t3.json"));
  const spool = join(workdir, "spool");
  mkdirSync(spool, { mode: 0o700 });
  writeFileSync(join(spool, "codex.jsonl"), events.join("\n") + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(spool, "t3.jsonl"), run + "\n", { flag: "wx", mode: 0o600 });
}
