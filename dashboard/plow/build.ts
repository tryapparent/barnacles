import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { buildPolicies } from "../../tooling/bend.ts";

const output = process.argv[2];
if (!output) throw new Error("Pass an existing build output directory.");

const source = (file: string) => readFile(new URL(file, import.meta.url), "utf8");
const base64 = async (file: string) => (await readFile(new URL(file, import.meta.url))).toString("base64");
const [compiled] = await buildPolicies(resolve(output), [[new URL("policy/preview.bend", import.meta.url), "policy.mjs"]]);
const policy = (await readFile(compiled, "utf8")).replace("export default {", "const policy = {");
const ui = await build({ configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)) });
const outputs = Array.isArray(ui) ? ui : [ui];
const [browser] = outputs;
if (outputs.length !== 1 || !("output" in browser) || browser.output.length !== 1 || browser.output[0].type !== "chunk") {
  throw new Error("Expected one self-contained Plow browser bundle.");
}
const script = [policy, browser.output[0].code, "PlowUI.mountDashboard();",
  await source("view/timeline.mjs"), await source("view/summary.mjs")].join("\n");
const timelineStyles = (await source("view/timeline.css"))
  .replace("__PLOW_YOUNG_SERIF__", await base64("../../public/assets/youngserif.woff2"))
  .replace("__PLOW_GEIST__", await base64("assets/geist.woff2"));
const summaryStyles = (await source("view/summary.css")).replace("__PLOW_SOURCE_SERIF__", await base64("../../public/assets/source-serif-4.woff2"));
const page = (await source("view/index.html"))
  .replace("__PLOW_FIELD__", await base64("../../public/assets/field.jpg"))
  .replace('<style id="timeline-css"></style>', () => `<style>\n${timelineStyles}</style>`)
  .replace('<style id="summary-css"></style>', () => `<style>\n${summaryStyles}</style>`)
  .replace("{{SCRIPT}}", () => script.replace(/<\/script/gi, "<\\/script"));
await writeFile(resolve(output, "index.html"), page);
const worker = (await source("worker.mjs")).replace('"__PLOW_HTML__"', () => JSON.stringify(page));
await writeFile(resolve(output, "worker.mjs"), worker);
