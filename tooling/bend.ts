import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const revision = "9c586f094f4fc88bef440dc8b4d77a2f92c257cc";
const sources = {
  "main.ts": "a9caec19d6d42a3c6314766170db05fd47bbbc5fcc71207c9aadbbaad51d83ec",
  "bend.ts": "24e424ae6a540bd8930a26b8e87a270d2be7c16835a3dbf85adc43348b0ce6e6",
  "comp.ts": "d5e46919252986ff1469c2c8e462bb1c8bb6daa339f0d76e38b9d7efa105ed00",
  "safe.ts": "8f5d72dd6fe5adb612e5276d15d7648a98d113d8df343b675721399d23a2b36c",
  "base.bend": "9a457145eacff52a36340cf86400b64b94b6eccc124c8ef3cf48bba4eab29af0",
};

export async function buildPolicy(directory: string, source: URL, filename: string): Promise<string> {
  const [output] = await buildPolicies(directory, [[source, filename]]);
  return output;
}

export async function buildPolicies(directory: string, policies: ReadonlyArray<readonly [URL, string]>) {
  const scratch = mkdtempSync(join(directory, "bend-"));
  try {
    const verified = await Promise.all(Object.entries(sources).map(async ([file, digest]) => {
      const url = `https://raw.githubusercontent.com/bendlang/bend/${revision}/bend2/${file}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok) throw new Error(`Bend2 download failed for ${file} (HTTP ${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw new Error(`Bend2 integrity check failed for ${file}`);
      }
      return { file, bytes };
    }));
    for (const { file, bytes } of verified) writeFileSync(join(scratch, file), bytes, { flag: "wx" });
    const compile = `
      import { load } from "./main.ts";
      import { pathToFileURL } from "node:url";
      import { writeFileSync } from "node:fs";
      const [input, output] = process.argv.slice(1);
      const { source } = await load(pathToFileURL(input).href, null, () => {
        throw new Error("Expected local Bend source");
      });
      writeFileSync(output, source);
    `;
    return policies.map(([source, filename]) => {
      const output = resolve(directory, filename);
      execFileSync(process.execPath, [
        "--stack-size=4096", "--experimental-transform-types", "--input-type=module", "-e", compile, fileURLToPath(source), output,
      ], {
        cwd: scratch,
        timeout: 60_000,
        stdio: "inherit",
        env: {
          ...process.env,
          TMPDIR: scratch,
          BEND_NO_TELEMETRY: "1",
          BEND_LIB: join(scratch, "bend-lib"),
          BEND_HUB: "http://127.0.0.1:1",
          BENDTT: "",
        },
      });
      return output;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function loadPolicy<T>(path: string): Promise<T> {
  return (await import(pathToFileURL(path).href)).default;
}
