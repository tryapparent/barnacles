import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
type MaybeNat = { $: "None" } | { $: "Some"; value: bigint };

type Run = {
  $: "Run";
  id: string;
  threadId: string;
  sessionId: string;
  startedMs: bigint;
  completedMs: bigint;
};

type ToolEvent = {
  $: "ToolEvent";
  eventId: string;
  sessionId: string;
  callId: string;
  kind: string;
  timestampMs: bigint;
};

type Interval = {
  callId: string;
  kind: string;
  startMs: MaybeNat;
  endMs: MaybeNat;
  durationMs: MaybeNat;
};

type Finding = { callId: string; reason: string };

type Report = { $: "Rejected" } | {
  $: "Report";
  runId: string;
  intervals: List<Interval>;
  findings: List<Finding>;
  events: bigint;
  paired: bigint;
  unknown: bigint;
};

const clockOffset = BigInt(Number.MAX_SAFE_INTEGER);

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Error(`Expected an object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function string(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw Error(`Expected a string for ${field}`);
  return value;
}

function clock(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw Error(`Expected a safe integer millisecond clock for ${field}`);
  }
  return BigInt(value) + clockOffset;
}

function decode(input: unknown) {
  const request = object(input, "request");
  const run = object(request.run, "run");
  if (!Array.isArray(request.events)) throw Error("Expected an events array");

  const events = request.events.reduceRight<List<ToolEvent>>((tail, value) => {
    const row = object(value, "event");
    return { $: "Con", tail, head: {
      $: "ToolEvent",
      eventId: string(row, "eventId"),
      sessionId: string(row, "sessionId"),
      callId: string(row, "callId"),
      kind: string(row, "kind"),
      timestampMs: clock(row, "timestampMs"),
    } };
  }, { $: "Nil" });

  return {
    run: {
      $: "Run",
      id: string(run, "id"),
      threadId: string(run, "threadId"),
      sessionId: string(run, "sessionId"),
      startedMs: clock(run, "startedMs"),
      completedMs: clock(run, "completedMs"),
    } satisfies Run,
    events,
  };
}

function array<T, R>(list: List<T>, encode: (item: T) => R): R[] {
  const values: R[] = [];
  for (let row = list; row.$ === "Con"; row = row.tail) values.push(encode(row.head));
  return values;
}

function nullable(value: MaybeNat, offset = 0n) {
  return value.$ === "None" ? null : JSON.rawJSON(String(value.value - offset));
}

async function compile(directory: string) {
  const { buildPolicy } = await import("../../tooling/bend.ts");
  return buildPolicy(directory, new URL("./run.bend", import.meta.url), "run.mjs");
}

async function main() {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (mode === "--compile" && directory && !extra.length) {
    await compile(directory);
    return;
  }
  if (mode !== undefined) throw Error("Expected --compile DIRECTORY or a JSON request on stdin");
  const { run, events } = decode(JSON.parse(readFileSync(0, "utf8")));
  const configured = process.env.PLOW_POLICY_MODULE;
  const scratch = configured ? undefined : mkdtempSync("/tmp/apparent-dev-plow-policy-");
  try {
    const module = scratch ? await compile(scratch) : configured!;
    const { default: policy } = await import(pathToFileURL(module).href) as {
      default: { analyze(run: Run, events: List<ToolEvent>): Report };
    };
    const report = policy.analyze(run, events);
    if (report.$ === "Rejected") throw Error("Policy rejected the run identity or clock window");

    process.stdout.write(JSON.stringify({
      runId: report.runId,
      intervals: array(report.intervals, ({ callId, kind, startMs, endMs, durationMs }) => ({
        callId, kind,
        startMs: nullable(startMs, clockOffset),
        endMs: nullable(endMs, clockOffset),
        durationMs: nullable(durationMs),
      })),
      findings: array(report.findings, ({ callId, reason }) => ({ callId, reason })),
      coverage: { events: Number(report.events), paired: Number(report.paired), unknown: Number(report.unknown) },
    }) + "\n");
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
