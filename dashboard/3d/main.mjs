import { createElement as h, Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { control, LandscapeBoard, GroundLabels, projectLabels } from "./view/board.mjs";
import { mountScenery, paintShoulder } from "./scenery/layers.mjs";
import policy from "plow-landscape-policy";
import { createCamera } from "./view/camera.mjs";
import {
  decodeFeed,
  readScene,
  landscapeLayout,
  list,
} from "./view/parcels.mjs";
import { Inspector } from "./view/inspect.mjs";
import { wideViewport, widthNotice } from "./widescreen.mjs";
import { idleMetrics, mountLandscape } from "./scene/renderer.mjs";

const root = document.querySelector("#plow-root"),
  react = createRoot(document.querySelector("#landscape-ui"));
const stage = document.querySelector("#landscape-stage");
const wide = wideViewport();
const initialFeed = () =>
  JSON.parse(document.querySelector("#trace-data").textContent);
let supported, pendingFeed, resumeFocus;
let scene,
  board,
  snapshot = "",
  revision = 0,
  request = 0,
  retry,
  lastFocus,
  status = "",
  stale = false,
  key = null;
let renderer, scenery;
const camera = createCamera(root, (pose, base, target, moved) => {
  root.toggleAttribute("data-away", moved);
  const minus = root.querySelector(".minus"),
    plus = root.querySelector(".plus");
  if (minus) minus.disabled = target <= base + 0.0001;
  if (plus) plus.disabled = target >= base * 9 - 0.0001;
  if (board) projectLabels(root, pose);
  renderer?.view(pose);
  scenery?.view(pose);
});
function focusKey(target) {
  const el = [...root.querySelectorAll("[data-target]")].find(
    (el) =>
      el.dataset.target === target &&
      el.tabIndex >= 0 &&
      el.getClientRects().length,
  );
  (
    el ??
    document.getElementById(target) ??
    root.querySelector("#summary-heading")
  )?.focus({ preventScroll: true });
}
function relayout() {
  board = landscapeLayout(scene, root.clientWidth, revision, key, policy);
}
function paint() {
  if (!supported) {
    flushSync(() =>
      react.render(
        h(
          "section",
          { className: "width-notice", role: "main", tabIndex: -1 },
          h("h1", null, "Plow"),
          h("p", null, widthNotice),
        ),
      ),
    );
    return;
  }
  document.body.dataset.focused = board?.objects.get(key)?.kind ?? "";
  if (["category", "operation"].includes(document.body.dataset.focused))
    document.body.dataset.focused = "field";
  flushSync(() => react.render(h(Farm)));
  renderer?.layout(board);
  if (board) scenery?.layout(board);
}
function choose(target, source) {
  const before = board.objects.get(key),
    item = board.objects.get(target);
  if (!item) return;
  if (!before) lastFocus = item.kind === "batch" ? "trend" : target;
  key = policy.enter(key ?? "", item.target);
  const currentField = (d) =>
    d?.kind === "operation" ? d.parent : d?.kind === "category" ? d.key : null;
  if (currentField(before) !== currentField(board.objects.get(key))) relayout();
  paint();
  camera.fit(board, board.objects.get(key));
  if (source === "batch-step") {
    const choices = [...root.querySelectorAll(".facts button")];
    const direction = item.index > before.index ? 1 : 0;
    (choices[direction].disabled
      ? choices[1 - direction]
      : choices[direction]
    ).focus({ preventScroll: true });
  } else if (item.kind === "operation") {
    const active = [...root.querySelectorAll(".parcel-button")].find(
      (el) => el.dataset.target === item.key,
    );
    (active?.tabIndex === 0 ? active : root.querySelector(".home"))?.focus({
      preventScroll: true,
    });
  } else root.querySelector(".home")?.focus({ preventScroll: true });
}
function home(restore = true) {
  const was = lastFocus;
  key = null;
  lastFocus = null;
  if (!board) return;
  relayout();
  paint();
  camera.fit(board, null);
  if (restore && was) focusKey(was);
}
function Farm() {
  const selected = board?.objects.get(key);
  return h(
    Fragment,
    null,
    board &&
      h(LandscapeBoard, { board, selected, choose, height: root.clientHeight }),
    board && h(GroundLabels, { board, selected }),
    h(
      "div",
      { className: "farm-hud" },
      h(
        "div",
        { className: "farm-word" },
        "plow",
        h("small", null, "Synthetic farm"),
      ),
      h(
        "nav",
        { className: "farm-tools", "aria-label": "Landscape camera" },
        control({ className: "home", onClick: () => home() }, "↩ Whole farm"),
        control(
          {
            className: "minus",
            "aria-label": "Zoom out",
            onClick: () => camera.zoom(1 / 1.6),
          },
          "−",
        ),
        control(
          {
            className: "plus",
            "aria-label": "Zoom in",
            onClick: () => camera.zoom(1.6),
          },
          "+",
        ),
      ),
      h(
        "div",
        {
          className: "farm-status",
          role: "status",
          "data-stale": stale || undefined,
        },
        status,
        stale && control({ onClick: () => refresh(retry) }, "Retry"),
      ),
      h(Inspector, { board, item: selected, select: choose }),
    ),
  );
}
async function refresh(provider = initialFeed) {
  const ticket = ++request;
  retry = provider;
  pendingFeed = null;
  try {
    const feed = await (typeof provider === "function" ? provider() : provider);
    if (ticket !== request) return false;
    if (!wide.matches) {
      pendingFeed = { feed };
      return false;
    }
    const decoded = decodeFeed(feed);
    const next = JSON.stringify(decoded);
    if (next === snapshot) {
      if (stale) {
        status = "Snapshot restored.";
        stale = false;
        paint();
      }
      return true;
    }
    const projected = readScene(policy, decoded);
    const oldItem = board?.objects.get(key);
    const focused = document.activeElement?.dataset.target;
    const focusItem = board?.objects.get(focused);
    const nextRevision = revision + 1;
    let nextBoard = landscapeLayout(
      projected,
      root.clientWidth,
      nextRevision,
      key,
      policy,
    );
    const targets = list([...nextBoard.objects.keys()]);
    const destination = oldItem
      ? policy.restore(oldItem.target, targets)
      : null;
    const selection = nextBoard.objects.has(destination) ? destination : null;
    let change = "";
    if (destination && destination !== key) {
      const label =
        nextBoard.objects.get(destination)?.name ??
        {
          timeline: "the timeline",
          trend: "agent work share",
          summary: "the summary",
        }[destination];
      change = "Snapshot updated. Returned to " + label + ".";
      nextBoard = landscapeLayout(
        projected,
        root.clientWidth,
        nextRevision,
        selection,
        policy,
      );
    }
    const restoredFocus = focusItem
      ? policy.restore(focusItem.target, targets)
      : null;
    if (!change && restoredFocus && restoredFocus !== focused)
      change =
        "Snapshot updated. Focus returned to " +
        (restoredFocus === "trend" ? "agent work share." : "the timeline.");
    const previousKey = key;
    scene = projected;
    board = nextBoard;
    key = selection;
    snapshot = next;
    revision = nextRevision;
    status = change || (stale ? "Snapshot restored." : "");
    stale = false;
    paint();
    if (!oldItem && camera.manual) camera.paint();
    else camera.fit(board, board.objects.get(key), true);
    if (
      previousKey !== key ||
      (focused && !board.objects.has(focused) && focused !== "trend")
    ) {
      const parent =
        destination === "trend" || restoredFocus === "trend"
          ? "trend"
          : "timeline";
      if (key) root.querySelector(".home").focus({ preventScroll: true });
      else
        focusKey(
          parent === "trend" && !board.batches.length
            ? "trend-heading"
            : parent,
        );
      lastFocus = key;
    }
    return true;
  } catch {
    if (ticket !== request) return false;
    stale = true;
    status = scene
      ? "Refresh failed. Showing the last usable snapshot."
      : "Snapshot unavailable.";
    paint();
    return false;
  }
}
root.addEventListener("landscape-home", () => home(false));
document.addEventListener("keydown", (event) => {
  if (
    supported &&
    ["Escape", "Home"].includes(event.key) &&
    (key || camera.manual)
  ) {
    event.preventDefault();
    home();
  }
});
let viewportSize = "";
function syncViewport() {
  const size = root.clientWidth + "/" + root.clientHeight;
  if (size === viewportSize && supported === wide.matches) return;
  viewportSize = size;
  if (!wide.matches) {
    if (supported === false) return;
    if (supported)
      resumeFocus =
        document.activeElement?.dataset.target ?? (key ? "home" : null);
    supported = false;
    root.dataset.supported = "false";
    stage.hidden = true;
    camera.enable(false);
    renderer?.pause(true);
    paint();
    if (resumeFocus)
      root.querySelector(".width-notice")?.focus({ preventScroll: true });
    return;
  }
  supported = true;
  root.dataset.supported = "true";
  stage.hidden = false;
  if (!renderer) {
    const sources = JSON.parse(
      document.querySelector("#landscape-textures").textContent,
    );
    renderer = mountLandscape(stage, sources, paintShoulder);
    scenery = mountScenery(stage, sources);
  }
  renderer.pause(false);
  camera.enable(true);
  if (scene) {
    relayout();
    paint();
    camera.resize(board, board.objects.get(key));
    if (resumeFocus === "home")
      root.querySelector(".home")?.focus({ preventScroll: true });
    else if (resumeFocus) focusKey(resumeFocus);
    resumeFocus = null;
  }
  if (pendingFeed) refresh(pendingFeed.feed);
  else if (!request) refresh();
  else if (!scene) paint();
}
wide.addEventListener("change", syncViewport);
new ResizeObserver(syncViewport).observe(root);
window.plowLandscape = {
  refresh,
  stats: () => ({
    ...idleMetrics,
    webgl: false,
    ...renderer?.stats(),
    supported,
    revision,
    selection: key,
    stale,
  }),
  layout: () => structuredClone(board),
};
syncViewport();
