import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandscape } from "./compiler.mjs";
import {
  decodeFeed,
  landscapeLayout,
  list,
  readScene,
} from "./view/parcels.mjs";
import { plotMesh, plotSpecs } from "./scene/plots.mjs";

let scratch, policy;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "apparent-dev-landscape-test-"));
  policy = await loadLandscape(scratch);
});
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
const trace = (end, work = [], wait = [], errors = []) => ({
  startUtcMs: 0,
  end,
  work,
  wait,
  errors,
});
const feed = (traces, threads = []) => ({
  observed: 0,
  traces,
  history: { first: 1, threads },
});
function layout(input, width = 1024, revision = 1, selected = null) {
  return landscapeLayout(
    readScene(policy, decodeFeed(input)),
    width,
    revision,
    selected,
    policy,
  );
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("area uses clipped policy milliseconds across overlapping threads, including a millisecond subplot", () => {
  const input = feed([
    trace(
      1,
      [
        [0, 0.001, "Tiny"],
        [0.001, 0.75, "Other"],
        [1, 5, "Outside"],
      ],
      [[0.5, 0.9, "Queue"]],
    ),
    trace(1, [], [[0, 1, "Queue"]]),
  ]);
  for (const width of [1024, 1100, 1280]) {
    const b = layout(input, width);
    for (const d of b.categories) {
      close((d.r.w * d.r.h) / (b.summary.w * b.summary.h), d.duration / 2000);
      for (const op of d.operations)
        close((op.r.w * op.r.h) / (d.r.w * d.r.h), op.duration / d.duration);
    }
    assert.equal(
      b.categories[1].operations.find((d) => d.name === "Tiny").duration,
      1,
    );
    assert.equal(b.categories[2].duration, 100);
    assert.equal(b.threads[0].parts.at(-1).material, "fog");
  }
});
test("zero area and a point-only thread retain separate targets", () => {
  const b = layout(feed([trace(0, [], [], [0])]));
  assert.ok(b.categories.every((d) => d.r.w * d.r.h === 0));
  assert.equal(b.threads[0].parts.length, 0);
  assert.equal(b.threads[0].failures.length, 1);
  assert.equal(b.threads[0].failures[0].r.w, 0);
  assert.equal(b.surfaces.filter((d) => d.r.w * d.r.h > 0).length, 0);
});
test("missing batches break measured runs and preserve a singleton measured zero", () => {
  const threads = [
    [0, 1],
    [0, 0],
    [1, 1],
    [1, 0],
    [0, 0],
    [0, 1],
  ].flatMap(([work, workflow]) => Array(10).fill({ work, workflow }));
  const b = layout(feed([], threads));
  assert.deepEqual(
    b.runs.map((run) => run.length),
    [1, 2, 1],
  );
  assert.deepEqual(
    b.batches.map((item) => item.value),
    ["0.0%", "Unknown", "50.0%", "100.0%", "Unknown", "0.0%"],
  );
  const specs = plotSpecs(b);
  assert.equal(specs.filter((spec) => spec.material === "trend").length, 1);
  assert.equal(specs.filter((spec) => spec.material === "point").length, 2);
  assert.ok(
    specs
      .filter((spec) => spec.material === "point")
      .every((spec) => plotMesh(spec, false).relief.length > 0),
  );
});
test("category and operation controls survive a refresh, scoped timeline and batch ordinals expire", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixture.json", import.meta.url)),
  );
  const original = layout(fixture),
    changed = layout(
      { ...fixture, traces: fixture.traces.slice().reverse() },
      1024,
      2,
    );
  const keys = list([...changed.objects.keys()]);
  const thread = original.threads[0],
    batch = original.batches[0],
    op = original.categories[0].operations[0];
  assert.equal(policy.restore(thread.target, keys), "timeline");
  assert.equal(policy.restore(thread.parts[0].target, keys), "timeline");
  assert.equal(policy.restore(batch.target, keys), "trend");
  assert.equal(policy.restore(op.target, keys), op.key);
  assert.equal(policy.restore(op.target, list([op.parent])), op.parent);
  assert.equal(policy.enter(op.key, op.target), op.parent);
});
test("growing, translating, shrinking and replaying a parcel retain each surviving local plant", () => {
  const draw = (w, h, x, slot = "grain") => {
    const mesh = plotMesh(
      { r: { x, y: 7, w, h }, slot, material: "grain" },
      true,
    );
    return Array.from({ length: mesh.plants.length / 4 }, (_, i) =>
      mesh.plants.slice(i * 4, i * 4 + 4),
    );
  };
  const first = draw(44, 30, 0);
  assert.deepEqual(
    draw(90, 70, 20).filter(([x, z]) => x < 44 && z < 30),
    first,
  );
  assert.deepEqual(draw(44, 30, 76), first);
  assert.deepEqual(
    first.filter(([x, z]) => x < 17 && z < 19),
    draw(17, 19, 0),
  );
  assert.notDeepEqual(draw(44, 30, 0, "neighbor"), first);
  assert.deepEqual(draw(44, 30, 0), first);
});
