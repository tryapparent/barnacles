import { mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildPolicies, loadPolicy } from "../../tooling/bend.ts";
import { list } from "./attempts.ts";
import type { Evidence, Progress } from "./attempts.ts";
import { emptyRepo, errorResult, healthLines, initial, lanes, stage, step } from "./cycle.ts";
import type { Context, State, Target } from "./cycle.ts";
import { Budget, credential, github, nowSeconds, seconds, SourceError } from "./http.ts";
import { atomic, directory, evidenceSpool, publishHealth, readState } from "./store.ts";

function value(name: string, fallback: string) {
  return process.env[name] || fallback;
}

function targets(evidence: Evidence) {
  const items = value("PLOW_GITHUB_REPOSITORIES", "").split(",").map(pair => {
    const [scope = "", repository = "", extra] = pair.split("=");
    return { scope, repository: repository.toLowerCase(), extra };
  });
  if (items.length > 16 || items.some(item => item.extra !== undefined || !evidence.valid_repo(item.repository) ||
      !evidence.valid_scope(item.scope)) || new Set(items.map(item => item.scope)).size !== items.length ||
      new Set(items.map(item => item.repository)).size !== items.length) {
    throw Error("Set PLOW_GITHUB_REPOSITORIES to unique safe alias=owner/repo pairs");
  }
  return items;
}

function bound(name: string, fallback: number, upper: number, minimum = 1) {
  const result = Number(value(name, String(fallback)));
  if (!Number.isInteger(result) || result < minimum || result > upper) throw Error("Invalid GitHub collector budget");
  return result;
}

function actionFloors(configured: Target[]) {
  const input: unknown = JSON.parse(value("PLOW_GITHUB_ACTIONS_SINCE_BY_ALIAS", "{}"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid GitHub Actions floors");
  const result = new Map<string, number>();
  for (const [scope, date] of Object.entries(input)) {
    const floor = typeof date === "string" ? seconds(date) : 0;
    if (!configured.some(target => target.scope === scope) || !floor || floor >= nowSeconds() - 15) {
      throw Error("Invalid GitHub Actions floor for alias");
    }
    result.set(scope, floor);
  }
  return result;
}


async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--once")) throw Error("Expected --once or no arguments");
  const once = args.length === 1;
  const floor = seconds(value("PLOW_GITHUB_ACTIONS_SINCE", ""));
  if (!floor || floor >= nowSeconds() - 15) throw Error("Set PLOW_GITHUB_ACTIONS_SINCE to a past UTC timestamp");
  const steps = bound("PLOW_GITHUB_MAX_STEPS", 40, 256);
  const requests = bound("PLOW_GITHUB_MAX_REQUESTS", 160, 512, 24);
  const root = directory(value("PLOW_GITHUB_STATE", "/state/github"));
  const receipts = directory(join(root, "terminal"));
  const spoolRoot = value("PLOW_SPOOL", "/spool");
  const health = directory(join(spoolRoot, "health"), false);
  const checkpoint = join(root, "checkpoint.json");
  const scratch = mkdtempSync("/tmp/apparent-dev-plow-github-");
  const signal = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => signal.abort());
  try {
    const [evidenceModule, progressModule] = await buildPolicies(scratch, [
      [new URL("./evidence.bend", import.meta.url), "evidence.mjs"],
      [new URL("./progress.bend", import.meta.url), "progress.mjs"],
    ]);
    const evidence = await loadPolicy<Evidence>(evidenceModule);
    const progress = await loadPolicy<Progress>(progressModule);
    const configured = targets(evidence);
    const floors = actionFloors(configured);
    const layout = value("PLOW_GITHUB_CREDENTIAL_LAYOUT", "legacy");
    const tokenFile = value("PLOW_GITHUB_READ_TOKEN_FILE", "");
    const tokenDirectory = value("PLOW_GITHUB_CREDENTIAL_DIR", "");
    if (layout === "legacy") {
      if (!tokenFile || configured.length !== 1) throw Error("Legacy credentials require one repository and PLOW_GITHUB_READ_TOKEN_FILE");
    } else if (layout !== "per-alias" || !isAbsolute(tokenDirectory)) {
      throw Error("Set PLOW_GITHUB_CREDENTIAL_LAYOUT to per-alias and supply an absolute credential directory");
    }
    const names: unknown = JSON.parse(value("PLOW_GITHUB_JOB_NAMES", '["verify","build","test","lint","release","checks"]'));
    if (!Array.isArray(names) || names.length > 512 ||
        names.some(name => typeof name !== "string" || !evidence.safe_job_name(name))) throw Error("Invalid GitHub job name allowlist");
    const jobNames = list<string>(names);
    const state = readState<State>(checkpoint, () => initial(floor));
    if (state.version !== 1 || state.floor !== floor) throw Error("GitHub checkpoint version or configured history floor changed");
    const spool = evidenceSpool(root, join(spoolRoot, "github"));
    const schedule = configured.flatMap(target => lanes.map(lane => ({ target, lane })));
    for (const { repository, scope } of configured) {
      const prior = state.repositories[repository];
      const configuredFloor = floors.get(scope) ?? floor;
      if (prior && (prior.floor ?? state.floor) !== configuredFloor) {
        throw Error("GitHub repository history floor changed");
      }
      const repoState = state.repositories[repository] ??= emptyRepo();
      repoState.floor = configuredFloor;
      repoState.throttle ??= layout === "legacy" ? state.throttle : 0;
    }
    const contextFor = (target: Target, read: Context["read"]): Context => ({
      read, evidence, progress, now: nowSeconds(), repo: target.repository,
      floor: floors.get(target.scope) ?? floor, receipts, jobNames,
      state: state.repositories[target.repository], records: [], confirmed: [],
    });
    const save = () => atomic(checkpoint, JSON.stringify(state) + "\n");
    const origin = value("PLOW_GITHUB_ORIGIN", "https://api.github.com");
    const unavailable: Context["read"] = async () => { throw new Budget(); };
    do {
      const send = github(origin, requests);
      const readers = new Map<string, Context["read"]>();
      for (const { scope, repository } of configured) {
        const repoState = state.repositories[repository];
        let token: string;
        try {
          token = credential(layout === "legacy" ? tokenFile : join(tokenDirectory, "github-read-" + scope));
        } catch {
          continue;
        }
        readers.set(repository, async (repo, path) => {
          if (repo !== repository) throw Error("GitHub credential route mismatch");
          const due = repoState.throttle ?? 0;
          if (!progress.ready(nowSeconds(), due)) throw new SourceError(429, true, due);
          const reply = await send(repository, path, token);
          if (reply.cooldown) repoState.throttle = reply.cooldown;
          return reply;
        });
      }
      let skipped = 0;
      for (let count = 0; count < steps && skipped < schedule.length && !signal.signal.aborted; ) {
        const index = state.turn % schedule.length;
        const { target, lane } = schedule[index];
        const read = readers.get(target.repository);
        const repoState = state.repositories[target.repository];
        let changed = false;
        if (read && progress.ready(nowSeconds(), repoState.throttle ?? 0)) {
          const context = contextFor(target, read);
          try {
            changed = await step(context, lane);
          } catch (error) {
            if (error instanceof Budget) break;
            if (!(error instanceof SourceError)) throw error;
            if (error.limited) repoState.throttle = progress.resume_at(context.now, 1, error.retryAt);
            errorResult(context, lane, error);
            changed = true;
          }
          if (changed) stage(context, spool, Date.now());
        }
        state.turn = (index + 1) % schedule.length;
        if (changed) {
          save();
          count++;
          skipped = 0;
        } else {
          skipped++;
        }
      }
      save();
      const observed = Date.now();
      for (const target of configured) {
        const transportGap = !readers.has(target.repository) ? "access_denied"
          : progress.ready(nowSeconds(), state.repositories[target.repository].throttle ?? 0) ? "" : "rate_limited";
        const context = contextFor(target, unavailable);
        context.records.push(progress.coverage(target.repository, "actions_retention", "limited", "retention_unknown", context.floor,
          0, 0, 0, 0, "", 0));
        stage(context, spool, observed);
        publishHealth(health, target.scope, healthLines(context, target, observed, transportGap));
      }
      if (once && readers.size === 0) throw Error("No GitHub credential available");
      if (!once && !signal.signal.aborted) await delay(15_000, undefined, { signal: signal.signal }).catch(() => {});
    } while (!once && !signal.signal.aborted);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { await main(); }
  catch {
    console.error("GitHub collector failed. Check its private configuration, compiler, checkpoint and spool.");
    process.exitCode = 1;
  }
}
