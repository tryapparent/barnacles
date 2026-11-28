import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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


async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--once")) throw Error("Expected --once or no arguments");
  const once = args.length === 1;
  const floor = seconds(value("PLOW_GITHUB_ACTIONS_SINCE", ""));
  if (!floor || floor >= nowSeconds() - 15) throw Error("Set PLOW_GITHUB_ACTIONS_SINCE to a past UTC timestamp");
  const tokenFile = value("PLOW_GITHUB_READ_TOKEN_FILE", "");
  if (!tokenFile) throw Error("Set PLOW_GITHUB_READ_TOKEN_FILE");
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
    const names: unknown = JSON.parse(value("PLOW_GITHUB_JOB_NAMES", '["verify","build","test","lint","release","checks"]'));
    if (!Array.isArray(names) || names.length > 512 ||
        names.some(name => typeof name !== "string" || !evidence.safe_job_name(name))) throw Error("Invalid GitHub job name allowlist");
    const jobNames = list<string>(names);
    const state = readState<State>(checkpoint, () => initial(floor));
    if (state.version !== 1 || state.floor !== floor) throw Error("GitHub checkpoint version or configured history floor changed");
    const spool = evidenceSpool(root, join(spoolRoot, "github"));
    const schedule = configured.flatMap(target => lanes.map(lane => ({ target, lane })));
    for (const { repository } of configured) state.repositories[repository] ??= emptyRepo();
    const contextFor = (target: Target, read: Context["read"]): Context => ({
      read, evidence, progress, now: nowSeconds(), repo: target.repository, floor, receipts, jobNames,
      state: state.repositories[target.repository], records: [], confirmed: [],
    });
    const save = () => atomic(checkpoint, JSON.stringify(state) + "\n");
    do {
      let read: Context["read"] = async () => { throw new Budget(); };
      let skipped = 0;
      const ready = progress.ready(nowSeconds(), state.throttle);
      let token = "";
      let credentialGap = "";
      if (ready) {
        try { token = credential(tokenFile); }
        catch { credentialGap = "access_denied"; }
      }
      if (token) {
        const send = github(value("PLOW_GITHUB_ORIGIN", "https://api.github.com"), token, requests);
        read = async (repo, path) => {
          if (!progress.ready(nowSeconds(), state.throttle)) throw new SourceError(429, true, state.throttle);
          const reply = await send(repo, path);
          if (reply.cooldown) state.throttle = reply.cooldown;
          return reply;
        };
        for (let count = 0; count < steps && skipped < schedule.length && !signal.signal.aborted; ) {
          const index = state.turn % schedule.length;
          const { target, lane } = schedule[index];
          const context = contextFor(target, read);
          let changed = false;
          try {
            changed = await step(context, lane);
          } catch (error) {
            if (error instanceof Budget) break;
            if (!(error instanceof SourceError)) throw error;
            if (error.limited) state.throttle = progress.resume_at(context.now, 1, error.retryAt);
            errorResult(context, lane, error);
            changed = true;
          }
          state.turn = (index + 1) % schedule.length;
          if (changed) {
            stage(context, spool, Date.now());
            save();
            count++;
            skipped = 0;
          } else skipped++;
          if (!progress.ready(nowSeconds(), state.throttle)) break;
        }
      }
      save();
      const observed = Date.now();
      const transportGap = credentialGap || (progress.ready(nowSeconds(), state.throttle) ? "" : "rate_limited");
      for (const target of configured) {
        const context = contextFor(target, read);
        context.records.push(progress.coverage(target.repository, "actions_retention", "limited", "retention_unknown", floor,
          0, 0, 0, 0, "", 0));
        stage(context, spool, observed);
        publishHealth(health, target.scope, healthLines(context, target, observed, transportGap));
      }
      if (once && credentialGap) throw Error("GitHub credential unavailable");
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
