import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPolicies } from "../../tooling/bend.ts";

const output = process.argv[2];
if (!output) throw new Error("Pass an existing build output directory.");

const source = (file: string) => readFile(new URL(file, import.meta.url), "utf8");
const font = async (file: string) => (await readFile(new URL(file, import.meta.url))).toString("base64");
const [compiled] = await buildPolicies(resolve(output), [[new URL("policy/preview.bend", import.meta.url), "policy.mjs"]]);
const policy = (await readFile(compiled, "utf8")).replace("export default {", "const policy = {");
const script = [policy, await source("view/timeline.mjs"), await source("view/summary.mjs")].join("\n");
const timelineStyles = (await source("view/timeline.css"))
  .replace("__PLOW_YOUNG_SERIF__", await font("../../public/assets/youngserif.woff2"))
  .replace("__PLOW_GEIST__", await font("assets/geist.woff2"));
const summaryStyles = await source("view/summary.css");
const page = (await source("view/index.html"))
  .replace('<style id="timeline-css"></style>', () => `<style>\n${timelineStyles}</style>`)
  .replace('<style id="summary-css"></style>', () => `<style>\n${summaryStyles}</style>`)
  .replace("{{SCRIPT}}", () => script.replace(/<\/script/gi, "<\\/script"));
await writeFile(resolve(output, "index.html"), page);
const worker = (await source("worker.mjs")).replace('"__PLOW_HTML__"', () => JSON.stringify(page));
await writeFile(resolve(output, "worker.mjs"), worker);
