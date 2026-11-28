import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";

export function compileLandscape(directory) {
  return buildPolicy(directory, new URL("./landscape.bend", import.meta.url), "landscape.mjs");
}

export async function loadLandscape(directory) {
  return loadPolicy(await compileLandscape(directory));
}
