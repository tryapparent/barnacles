import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { compileLandscape } from "./compiler.mjs";

const output = process.argv[2];
if (!output) throw Error("Pass a destination for the standalone HTML file.");
const local = (path) => new URL(path, import.meta.url);
const scratch = await mkdtemp(join(tmpdir(), "apparent-dev-plow-landscape-"));
const read = (name) => readFile(local(name), "utf8");
const encoded = async (path, type) =>
  "data:" +
  type +
  ";base64," +
  (await readFile(local(path))).toString("base64");
try {
  const compiled = await compileLandscape(scratch);
  const bundle = await build({
    configFile: false,
    plugins: [react()],
    resolve: { alias: { "plow-landscape-policy": compiled } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(local("main.mjs")),
        name: "PlowFarm",
        formats: ["iife"],
      },
    },
  });
  const chunks = [bundle]
    .flat()
    .flatMap((result) => result.output)
    .filter((item) => item.type === "chunk");
  if (chunks.length !== 1) throw Error("Expected one landscape bundle.");
  const textures = {};
  for (const name of ["meadow", "soil", "grain", "oak"])
    textures[name] = await encoded("assets/" + name + ".webp", "image/webp");
  for (const [name, file] of [
    ["horizon", "horizon"],
    ["framingOak", "framing-oak"],
    ["verge", "verge"],
    ["tilth", "tilth"],
  ])
    textures[name] = await encoded("scenery/" + file + ".webp", "image/webp");
  const styles = (
    await Promise.all(
      ["terrain", "world", "zoom"].map((name) => read("view/" + name + ".css")),
    )
  ).join("\n");
  const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const fixture = JSON.parse(await read("fixture.json"));
  const young = await encoded(
    "../../public/assets/youngserif.woff2",
    "font/woff2",
  );
  const serif = await encoded(
    "../../public/assets/source-serif-4.woff2",
    "font/woff2",
  );
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plow · Thread landscape</title>
<style>@font-face{font-family:"Young Serif";src:url(${young})}@font-face{font-family:"Source Serif 4";src:url(${serif});font-weight:200 900}:root{--meadow:url(${textures.meadow});--soil:url(${textures.soil});--grain:url(${textures.grain})}${styles}</style></head><body><div id="plow-root"><div id="landscape-stage" aria-hidden="true"></div><div id="landscape-ui"></div></div>
<script type="application/json" id="trace-data">${json(fixture)}</script><script type="application/json" id="landscape-textures">${json(textures)}</script>
<script>${chunks[0].code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, page);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
