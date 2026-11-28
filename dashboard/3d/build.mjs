import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const output = process.argv[2];
if (!output) throw Error("Pass a destination for the standalone HTML file.");
const local = (path) => new URL(path, import.meta.url);
const scratch = await mkdtemp(join(tmpdir(), "apparent-dev-plow-landscape-"));
const texture = async (name) =>
  "data:image/webp;base64," +
  (await readFile(local("assets/" + name + ".webp"))).toString("base64");
try {
  execFileSync(
    process.execPath,
    [fileURLToPath(local("../plow/build.ts")), scratch],
    { stdio: "inherit" },
  );
  const shell = await readFile(join(scratch, "index.html"), "utf8");
  const bundle = await build({
    configFile: false,
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(local("main.mjs")),
        name: "PlowFarm",
        formats: ["iife"],
      },
    },
  });
  const chunk = [bundle]
    .flat()
    .flatMap((result) => result.output)
    .filter((item) => item.type === "chunk");
  if (chunk.length !== 1) throw Error("Expected one landscape bundle.");
  const sources = {};
  for (const name of ["meadow", "soil", "grain", "road", "oak"])
    sources[name] = await texture(name);
  const grass = await texture("grass");
  const styles = await Promise.all(
    ["terrain", "world", "zoom"].map((name) =>
      readFile(local("view/" + name + ".css"), "utf8"),
    ),
  );
  const fixture = JSON.stringify(
    JSON.parse(await readFile(local("fixture.json"), "utf8")),
  );
  const scene = `<style>:root{--meadow:url(${grass});--grain:url(${sources.grain})}${styles.join("\n")}</style>
<script type="application/json" id="landscape-textures">${JSON.stringify(sources)}</script>
<script>${chunk[0].code.replace(/<\/script/gi, "<\\/script")}</script>`;
  const surface = await texture("surface");
  const page = shell
    .replace(
      /data-field-texture="[^"]+"/,
      () => `data-field-texture="${surface}"`,
    )
    .replace(/data-field="[^"]+"/, () => `data-field="${grass}"`)
    .replace(
      /(<script type="application\/json" id="trace-data">)[\s\S]*?(<\/script>)/,
      (_, open, close) => open + fixture + close,
    )
    .replaceAll("#dfbf89", "#a5b6b7")
    .replace("</html>", () => scene + "</html>");
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, page);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
