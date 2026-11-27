import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { analysisApiUrl, feedPayload } from "./worker.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const collector = "%h/.local/share/barnacles/harbor";
const hostname = "plow.tryapparent.com";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw Error(`Set ${name}.`);
  return value;
}

function accessConfig() {
  const team = required("PLOW_ACCESS_TEAM");
  const audience = required("PLOW_ACCESS_AUDIENCE");
  if (!/^[a-z0-9-]+$/.test(team) || !/^[a-f0-9]{64}$/.test(audience)) throw Error("Invalid Plow Access settings.");
  return { team, audience };
}

function originPort() {
  const port = process.env.PLOW_FRONTEND_PORT || "3033";
  if (!/^\d{1,5}$/.test(port) || +port < 1024 || +port > 65535) throw Error("Invalid Plow frontend port.");
  return port;
}

function node(args: string[]) {
  execFileSync(process.execPath, args, { cwd: source, stdio: "inherit", timeout: 150_000 });
}

type Release = { source: string; revision: string; assets: string };

function compose(release: Release, feed: string) {
  execFileSync("docker", ["compose", "-p", "plow-dashboard", "-f", join(release.source, "compose.yaml"),
    "up", "-d", "--wait", "--wait-timeout", "25", "plow-dashboard"], {
    stdio: "inherit", timeout: 60_000,
    env: { ...process.env, PLOW_RELEASE: release.revision, PLOW_FRONTEND_ASSETS: release.assets, PLOW_FRONTEND_FEED: feed },
  });
}

async function sync() {
  accessConfig();
  originPort();
  const analysis = process.env.PLOW_ANALYSIS_API_URL;
  if (analysis && !analysisApiUrl(analysis)) throw Error("Expected a private HTTPS analysis API URL.");
  const database = resolve(required("PLOW_EVIDENCE_DATABASE"));
  const state = resolve(required("PLOW_FRONTEND_STATE"));
  const revision = (await readFile(join(source, "..", "revision"), "utf8")).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("Expected a verified collector release revision.");
  const feed = join(state, "feed");
  const active = join(state, "active.json");
  const assets = join(state, revision);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(feed, { recursive: true, mode: 0o700 });
  const previous: Release | undefined = await readFile(active, "utf8").then(JSON.parse, error => {
    if (error.code !== "ENOENT") throw error;
  });
  const scratch = await mkdtemp(join(tmpdir(), "apparent-dev-plow-frontend-"));
  try {
    const projection = join(scratch, "timeline.json");
    node(["dashboard/plow/build.ts", "--project-feed", database, projection]);
    const candidateFeed = join(state, "timeline.next");
    const raw = await readFile(projection, "utf8");
    feedPayload(raw);
    await writeFile(candidateFeed, raw, { mode: 0o600 });
    await rename(candidateFeed, join(feed, "timeline.json"));
    const built = await readFile(join(assets, "worker.mjs")).then(() => true, error => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
    if (!built) {
      const candidateAssets = await mkdtemp(join(state, "build-"));
      try {
        node(["dashboard/plow/build.ts", candidateAssets]);
        await rename(candidateAssets, assets);
      } finally {
        await rm(candidateAssets, { recursive: true, force: true });
      }
    }
    const next = { source, revision, assets };
    try {
      compose(next, feed);
    } catch (error) {
      if (previous) compose(previous, feed);
      throw error;
    }
    const receipt = join(state, "active.next");
    await writeFile(receipt, JSON.stringify(next), { mode: 0o600 });
    await rename(receipt, active);
    if (previous?.assets && previous.assets !== assets) await rm(previous.assets, { recursive: true, force: true });
    console.log(`Plow dashboard is healthy at revision ${revision}.`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function unit(name: string) {
  if (name === "service") return `[Unit]
Description=Refresh and deploy the verified Plow dashboard

[Service]
Type=oneshot
EnvironmentFile=%h/.config/plow-frontend/compose.env
ExecStart=/usr/bin/flock -n -E 0 ${collector}/deploy.lock /usr/bin/node ${collector}/current/source/dashboard/plow/deploy.ts --sync
TimeoutStartSec=390
UMask=0077
`;
  if (name === "timer") return `[Unit]
Description=Refresh the Plow dashboard every fifteen minutes

[Timer]
OnStartupSec=1min
OnUnitInactiveSec=15min

[Install]
WantedBy=timers.target
`;
  throw Error("Expected service or timer.");
}

type Route = { id: string; pattern: string; script: string | null; request_limit_fail_open: boolean };
type Rule = { hostname?: string; service: string; path?: string; originRequest?: object };
type TunnelConfig = { ingress: Rule[]; "warp-routing": { enabled: boolean } };

async function ingress(action: string) {
  if (!["status", "apply", "rollback"].includes(action)) throw Error("Expected status, apply, or rollback.");
  const { team, audience } = accessConfig();
  const account = required("PLOW_CF_ACCOUNT");
  const zone = required("PLOW_CF_ZONE");
  const tunnel = required("PLOW_CF_TUNNEL");
  const application = required("PLOW_CF_ACCESS_APP");
  if (![account, zone].every(id => /^[a-f0-9]{32}$/.test(id)) ||
      ![tunnel, application].every(id => /^[a-f0-9-]{36}$/.test(id))) throw Error("Invalid Cloudflare resource IDs.");
  const token = (await readFile(required("PLOW_CF_TOKEN_FILE"), "utf8")).trim();

  async function api<T>(path: string, method = "GET", body?: object): Promise<T> {
    const result = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await result.json() as { success: boolean; result: T; errors?: { code: number }[] };
    if (!result.ok || !payload.success) {
      throw Error(`Cloudflare ${method} ${path} failed with HTTP ${result.status} (${payload.errors?.map(error => error.code).join(",")}).`);
    }
    return payload.result;
  }

  const accountPath = `accounts/${account}`;
  try {
    await api(`${accountPath}/tokens/verify`);
  } catch {
    await api("user/tokens/verify");
  }
  const { aud, type, self_hosted_domains: domains } = await api<{ aud: string; type: string; self_hosted_domains: string[] }>(
    `${accountPath}/access/apps/${application}`);
  if (aud !== audience || type !== "self_hosted" || !domains.includes(hostname + "/app") || !domains.includes(hostname + "/app/*")) {
    throw Error("The existing Access application must protect both Plow dashboard paths.");
  }
  const routesPath = `zones/${zone}/workers/routes`;
  const routeBody = { pattern: hostname + "/app*", script: "plow-private-preview", request_limit_fail_open: false };
  const configuration = `${accountPath}/cfd_tunnel/${tunnel}/configurations`;
  const { config } = await api<{ config: TunnelConfig }>(configuration);
  const route = (await api<Route[]>(routesPath)).find(item => item.pattern === routeBody.pattern);
  if (route && (route.script !== routeBody.script || route.request_limit_fail_open !== false)) {
    throw Error("Unexpected existing Worker route for the Plow dashboard.");
  }

  const publicRule = { service: "http://127.0.0.1:3032", hostname };
  const fallback = { service: "http_status:404" };
  const dashboardRule = {
    service: `http://127.0.0.1:${originPort()}`, hostname, path: "^/app/?$",
    originRequest: { access: { required: true, teamName: team, audTag: [audience] } },
  };
  const legacy = [publicRule, fallback];
  const desired = [dashboardRule, ...legacy];
  const alreadyRouted = isDeepStrictEqual(config.ingress, desired);
  if (!alreadyRouted && !isDeepStrictEqual(config.ingress, legacy)) {
    throw Error("The Plow Tunnel has unexpected rules. Inspect them before changing routing.");
  }

  async function setRules(rules: Rule[]) {
    await api(configuration, "PUT", { config: { ...config, ingress: rules } });
    const updated = await api<{ config: TunnelConfig }>(configuration);
    if (!isDeepStrictEqual(updated.config.ingress, rules)) throw Error("Tunnel rules failed readback.");
  }
  async function verifyPublic() {
    for (const path of ["/app", "/app/", "/", "/brand/"]) {
      const response = await fetch(`https://${hostname}${path}`, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
      if (path.startsWith("/app")) {
        const redirect = new URL(response.headers.get("Location") ?? `https://${hostname}`);
        if (response.status !== 302 || redirect.origin !== `https://${team}.cloudflareaccess.com` ||
            redirect.pathname !== `/cdn-cgi/access/login/${hostname}`) throw Error(`Expected Cloudflare Access on ${path}.`);
      } else if (response.status !== 200) {
        throw Error(`Plow public path ${path} returned ${response.status}.`);
      }
      await response.body?.cancel();
    }
  }
  async function verifyAuthenticated() {
    const revision = required("PLOW_RELEASE");
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("Expected the dashboard release to verify.");
    const tokens = `${accountPath}/access/service_tokens`;
    const policies = `${accountPath}/access/apps/${application}/policies`;
    const name = `Plow cutover smoke ${randomUUID()}`;
    const credential = await api<{ id: string; client_id: string; client_secret: string }>(tokens, "POST", { name, duration: "10m" });
    let policy: { id: string } | undefined;
    try {
      const current = await api<{ precedence: number }[]>(policies);
      const precedence = Math.max(0, ...current.map(item => item.precedence)) + 1;
      policy = await api(policies, "POST", {
        name, precedence, decision: "non_identity",
        include: [{ service_token: { token_id: credential.id } }],
      });
      for (const path of ["/app", "/app/"]) {
        for (let attempt = 1; ; attempt++) {
          const response = await fetch(`https://${hostname}${path}`, {
            method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8_000),
            headers: { "CF-Access-Client-Id": credential.client_id, "CF-Access-Client-Secret": credential.client_secret },
          });
          if (response.status === 200 && response.headers.get("X-Plow-Revision") === revision) break;
          if (attempt === 5) throw Error(`Authenticated route ${path} returned HTTP ${response.status} or the wrong release.`);
          await setTimeout(4000);
        }
      }
    } finally {
      if (policy) await api(`${policies}/${policy.id}`, "DELETE");
      await api(`${tokens}/${credential.id}`, "DELETE");
    }
    console.log("Authenticated both app paths through Cloudflare and verified the Clanker revision.");
  }
  async function restore() {
    if (!(await api<Route[]>(routesPath)).some(item => item.pattern === routeBody.pattern)) {
      await api(routesPath, "POST", routeBody);
    }
    await setRules(legacy);
    await verifyPublic();
  }
  if (action === "status") {
    await verifyPublic();
    console.log(`Plow Tunnel dashboard route: ${alreadyRouted ? "configured" : "absent"}. Worker route: ${route ? "present" : "absent"}.`);
    return;
  }
  if (action === "rollback") {
    await restore();
    console.log("Restored the Plow Worker route.");
    return;
  }

  const origin = `http://127.0.0.1:${originPort()}`;
  const probe = await fetch(origin + "/_health", { signal: AbortSignal.timeout(5_000) });
  const denied = await fetch(origin + "/app", { signal: AbortSignal.timeout(5_000) });
  await denied.body?.cancel();
  if (probe.status !== 204 || denied.status !== 403) throw Error("Expected a healthy, Access-protected dashboard origin.");
  await verifyPublic();
  try {
    if (!alreadyRouted || route) {
      if (!alreadyRouted) await setRules(desired);
      if (route) {
        await setTimeout(5000);
        await api(`${routesPath}/${route.id}`, "DELETE");
      }
    }
    if (process.env.PLOW_CF_SMOKE_ACCESS === "1") await verifyAuthenticated();
    await verifyPublic();
    if ((await api<Route[]>(routesPath)).some(item => item.pattern === routeBody.pattern)) throw Error("Worker route still active.");
  } catch (error) {
    if (route) await restore();
    throw error;
  }
  console.log("Plow dashboard routing points to Clanker and Cloudflare Access protects both app paths.");
}

const [, , command, arg] = process.argv;
if (command === "--sync") await sync();
else if (command === "--unit") process.stdout.write(unit(arg));
else if (command === "--ingress") await ingress(arg);
else throw Error("Use --sync, --unit service|timer, or --ingress status|apply|rollback.");
