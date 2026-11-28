import { operationParcels, projectLabels } from "./parcels.mjs";
import { createInspectors } from "./inspect.mjs";
export function createCamera(first) {
  const root = first("#plow-root"),
    main = first("main");
  const camera = { x: 0, y: 0, s: 1, p: 0.93 },
    goal = { ...camera };
  let chosen = null,
    lastTrigger = null,
    flight = 0,
    manual = false,
    homeScale = 1,
    renderCamera = () => {},
    rendererResize = () => {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const hud = document.createElement("div");
  hud.className = "farm-hud";
  hud.innerHTML =
    '<div class="farm-word">plow</div><div class="farm-tools"><button type="button" class="home" hidden>↩ Whole farm</button><button type="button" class="minus" aria-label="Zoom out">−</button><button type="button" class="plus" aria-label="Zoom in">+</button></div><section class="farm-detail" hidden aria-label="Selected field"><h2></h2><div class="readout"></div><div class="facts"></div></section>';
  root.append(hud);
  const story = document.createElement("p");
  story.className = "field-story";
  story.textContent =
    "One allotment per thread. Mown grass lies outside its recorded interval.";
  first(".timeline-heading-row").after(story);
  const tags = document.createElement("div");
  tags.className = "land-labels";
  hud.prepend(tags);
  let labelAnchors = [];
  const parcels = document.createElement("div");
  parcels.className = "parcel-layer";
  hud.insertBefore(parcels, hud.querySelector(".farm-detail"));
  let plots = [];
  function clearPlots() {
    plots = [];
    parcels.replaceChildren();
    rendererResize();
  }
  function resetLabels() {
    labelAnchors = [];
    tags.replaceChildren();
  }
  const placeLabels = () => projectLabels(root, camera, plots, labelAnchors);
  const home = hud.querySelector(".home"),
    detail = hud.querySelector(".farm-detail");
  const nameEl = detail.querySelector("h2"),
    valueEl = detail.querySelector(".readout"),
    facts = detail.querySelector(".facts");
  const tabStops = new Map();
  let fieldNavigation = false;
  function syncTabStops() {
    if (!fieldNavigation) return;
    for (const e of main.querySelectorAll(
      "button,a[href],input,summary,[tabindex]",
    )) {
      if (!tabStops.has(e)) tabStops.set(e, e.getAttribute("tabindex"));
      e.tabIndex = -1;
    }
  }
  function restrictTabStops(on) {
    fieldNavigation = on;
    if (on) {
      syncTabStops();
      return;
    }
    for (const [e, v] of tabStops) {
      if (!e.isConnected) continue;
      if (v === null) e.removeAttribute("tabindex");
      else e.setAttribute("tabindex", v);
    }
    tabStops.clear();
  }
  new MutationObserver(syncTabStops).observe(main, {
    childList: true,
    subtree: true,
  });
  const all = (s) => [...document.querySelectorAll(s)];
  function screen() {
    return { w: root.clientWidth, h: root.clientHeight };
  }
  function worldRect(el) {
    const r = el.getBoundingClientRect(),
      m = main.getBoundingClientRect();
    return {
      x: (r.left - m.left) / camera.s,
      y: (r.top - m.top) / (camera.s * camera.p),
      w: r.width / camera.s,
      h: r.height / (camera.s * camera.p),
    };
  }
  function applyCamera() {
    main.style.transform =
      "matrix(" +
      [camera.s, 0, 0, camera.s * camera.p, camera.x, camera.y].join(",") +
      ")";
    renderCamera();
    placeLabels();
  }
  function animate() {
    cancelAnimationFrame(flight);
    const begin = { ...camera },
      start = performance.now(),
      duration = reduced.matches ? 0 : 760;
    function tick(now) {
      const t = duration ? Math.min(1, (now - start) / duration) : 1,
        q = t * t * (3 - 2 * t);
      for (const k of ["x", "y", "s", "p"])
        camera[k] = begin[k] + (goal[k] - begin[k]) * q;
      applyCamera();
      if (t < 1) flight = requestAnimationFrame(tick);
      else {
        flight = 0;
        if (!chosen && !manual) delete document.body.dataset.focused;
      }
    }
    if (duration) flight = requestAnimationFrame(tick);
    else tick(start);
  }
  function updateControls() {
    home.hidden = !chosen && !manual;
    hud.querySelector(".minus").disabled = goal.s <= homeScale + 0.012;
    hud.querySelector(".plus").disabled = goal.s >= homeScale * 9 - 0.01;
  }
  function layoutHome(immediate = false) {
    const { w, h } = screen();
    homeScale = Math.min(w / main.offsetWidth, h / (main.offsetHeight * 0.93));
    Object.assign(goal, {
      s: homeScale,
      p: 0.93,
      x: (w - main.offsetWidth * homeScale) / 2,
      y: (h - main.offsetHeight * homeScale * 0.93) / 2,
    });
    if (immediate) {
      if (!chosen && !manual) delete document.body.dataset.focused;
      cancelAnimationFrame(flight);
      flight = 0;
      Object.assign(camera, goal);
      applyCamera();
    } else animate();
    updateControls();
  }
  function focusRect(r, el, type, minScale = 0) {
    const { w, h } = screen(),
      mobile = w < 550;
    const freeW = w * (mobile ? 0.8 : 0.74),
      freeH = h * (mobile ? 0.43 : 0.53);
    const s = Math.max(
      Math.min(minScale, homeScale * 9),
      homeScale * 1.38,
      Math.min(
        homeScale * 8,
        freeW / Math.max(18, r.w),
        freeH / (Math.max(20, r.h) * 0.72),
      ),
    );
    const cx = r.x + r.w * 0.5,
      cy = r.y + r.h * 0.5,
      p = 0.66;
    Object.assign(goal, {
      s,
      p,
      x: w * 0.49 - cx * s,
      y: h * (mobile ? 0.49 : 0.47) - cy * s * p,
    });
    restrictTabStops(true);
    resetLabels();
    chosen = { type, el };
    manual = false;
    document.body.dataset.focused = type;
    updateControls();
    animate();
  }
  let forwarding = false;
  function dispatch(el) {
    if (!el) return;
    forwarding = true;
    try {
      el.click();
    } finally {
      forwarding = false;
    }
  }
  function reset(restore = true) {
    restrictTabStops(false);
    clearPlots();
    resetLabels();
    const trigger = lastTrigger;
    chosen = null;
    manual = false;
    document.body.dataset.focused = "returning";
    if (!first("#collapse")?.hidden) dispatch(first("#collapse"));
    const ins = first("#thread-inspector");
    if (ins && !ins.hidden) dispatch(ins.querySelector("button"));
    if (first(".batch-trigger")?.getAttribute("aria-expanded") === "true")
      dispatch(first(".batch-trigger"));
    detail.hidden = true;
    facts.replaceChildren();
    layoutHome();
    if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  function present(title, value) {
    detail.hidden = false;
    nameEl.textContent = title;
    valueEl.textContent = value;
    facts.replaceChildren();
  }
  function fieldDetails(el) {
    const title = el.querySelector(".category-name").textContent,
      value = el.querySelector(".category-metric").textContent;
    const r = worldRect(el);
    lastTrigger = el;
    focusRect(r, el, "field");
    const parentScale = goal.s;
    present(title, value);
    function operations() {
      clearPlots();
      const nativeButtons = all("#operation-tiles .operation-tile");
      for (const { native, piece, button, metric } of operationParcels(
        nativeButtons,
        r,
        screen().w < 600,
      )) {
        button.onclick = () => {
          dispatch(native);
          const selected = native.getAttribute("aria-pressed") === "true";
          for (const plot of plots)
            plot.button.setAttribute(
              "aria-pressed",
              String(selected && plot.button === button),
            );
          nameEl.textContent = selected
            ? native.querySelector(".operation-name").textContent
            : title;
          valueEl.textContent = selected ? metric.textContent : value;
          focusRect(
            selected ? piece : r,
            el,
            "field",
            selected ? parentScale * 1.32 : 0,
          );
          chosen.sub = selected ? piece : null;
          rendererResize();
        };
        parcels.append(button);
        plots.push({ r: piece, button });
      }
      placeLabels();
      rendererResize();
      if (!plots.length)
        facts.textContent = first("#operation-empty")?.textContent || "";
    }
    queueMicrotask(() => {
      if (chosen?.el !== el) return;
      dispatch(el);
      operations();
      home.focus({ preventScroll: true });
    });
  }
  const { threadDetails, batchDetails } = createInspectors({
    clearPlots,
    first,
    worldRect,
    remember: (target) => (lastTrigger = target),
    focusRect,
    dispatch,
    tags,
    labelAnchorsForRow: (item) => labelAnchors.push(item),
    placeLabels,
    present,
    facts,
    home,
    all,
    rememberBatch: (index) => (chosen.batch = index),
  });
  function zoomAt(factor, x, y) {
    const s = Math.min(homeScale * 9, Math.max(homeScale, goal.s * factor));
    if (s <= homeScale + 0.005) {
      reset(false);
      return;
    }
    const ratio = s / camera.s;
    Object.assign(goal, {
      s,
      p: camera.p,
      x: x - (x - camera.x) * ratio,
      y: y - (y - camera.y) * ratio,
    });
    manual = true;
    updateControls();
    animate();
  }
  home.onclick = () => reset();
  hud.querySelector(".plus").onclick = () =>
    zoomAt(1.6, screen().w / 2, screen().h * 0.45);
  hud.querySelector(".minus").onclick = () =>
    zoomAt(1 / 1.6, screen().w / 2, screen().h * 0.45);
  let suppressClick = false,
    drag = null;
  root.addEventListener(
    "click",
    (event) => {
      if (forwarding) return;
      if (suppressClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const el = event.target;
      if (hud.contains(el)) return;
      const category = el.closest(".category-tile"),
        thread = el.closest(".fit-thread,.inspectable"),
        chart = el.closest(".trend-plot svg"),
        batch = el.closest(".batch-trigger");
      if (!category && !thread && !chart && !batch) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (category) {
        if (chosen?.type === "field") dispatch(first("#collapse"));
        fieldDetails(category);
      } else if (thread) queueMicrotask(() => threadDetails(thread));
      else if (batch) queueMicrotask(() => batchDetails(0, batch));
      else {
        const box = chart
          .querySelector("foreignObject")
          .getBoundingClientRect();
        const f = Math.max(
          0,
          Math.min(1, (event.clientX - box.left) / box.width),
        );
        const button = first(".batch-trigger");
        dispatch(button);
        requestAnimationFrame(() => {
          const n = all(".trend-batch-panel tbody tr").length;
          batchDetails(Math.round(f * (n - 1)), button);
        });
      }
    },
    true,
  );
  for (const phase of ["keydown", "keyup"])
    root.addEventListener(
      phase,
      (e) => {
        if (
          (e.key !== "Enter" && e.key !== " ") ||
          !e.target.closest(
            ".category-tile,.fit-thread,.inspectable,.batch-trigger",
          )
        )
          return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (phase === "keydown" && !e.repeat) e.target.click();
      },
      true,
    );
  root.addEventListener(
    "wheel",
    (e) => {
      if (hud.contains(e.target) && e.target.closest(".farm-detail")) return;
      e.preventDefault();
      const r = root.getBoundingClientRect();
      zoomAt(
        Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.003),
        e.clientX - r.left,
        e.clientY - r.top,
      );
    },
    { passive: false, capture: true },
  );
  root.addEventListener(
    "pointerdown",
    (e) => {
      if (home.hidden || hud.contains(e.target) || e.button !== 0) return;
      drag = {
        x: e.clientX,
        y: e.clientY,
        bx: camera.x,
        by: camera.y,
        id: e.pointerId,
        moved: false,
      };
    },
    true,
  );
  root.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    root.setPointerCapture(e.pointerId);
    cancelAnimationFrame(flight);
    flight = 0;
    const { w, h } = screen();
    camera.x = Math.max(
      w * 0.25 - main.offsetWidth * camera.s,
      Math.min(w * 0.75, drag.bx + dx),
    );
    camera.y = Math.max(
      h * 0.25 - main.offsetHeight * camera.s * camera.p,
      Math.min(h * 0.75, drag.by + dy),
    );
    Object.assign(goal, camera);
    applyCamera();
    e.preventDefault();
  });
  function stopDrag() {
    if (drag?.moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 35);
    }
    drag = null;
  }
  root.addEventListener("pointerup", stopDrag);
  root.addEventListener("pointercancel", stopDrag);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Home") {
      if (!home.hidden) {
        e.preventDefault();
        reset();
      }
    }
  });
  let lastSize = screen();
  const resizeCamera = () => {
    const current = screen(),
      old = lastSize;
    lastSize = current;
    const field = chosen?.type === "field" ? chosen.el.dataset.kind : null;
    const op = plots.findIndex(
      (p) => p.button.getAttribute("aria-pressed") === "true",
    );
    const thread =
      chosen?.type === "thread" ? all(".trace .bar").indexOf(chosen.el) : -1;
    const batch = chosen?.type === "batch" ? chosen.batch : null;
    const free =
      !chosen && manual
        ? {
            s: camera.s / homeScale,
            x: (old.w * 0.5 - camera.x) / camera.s,
            y: (old.h * 0.5 - camera.y) / (camera.s * camera.p),
          }
        : null;
    if (chosen || manual) reset(false);
    layoutHome(true);
    rendererResize();
    if (field !== null) {
      const el = first('.category-tile[data-kind="' + field + '"]');
      if (el) {
        fieldDetails(el);
        if (op >= 0) requestAnimationFrame(() => plots[op]?.button.click());
      }
    } else if (thread >= 0) threadDetails(all(".trace .inspectable")[thread]);
    else if (batch != null) batchDetails(batch, first(".batch-trigger"));
    else if (free) {
      manual = true;
      goal.s = homeScale * free.s;
      goal.x = current.w * 0.5 - free.x * goal.s;
      goal.y = current.h * 0.5 - free.y * goal.s * goal.p;
      Object.assign(camera, goal);
      applyCamera();
      updateControls();
    }
  };
  new ResizeObserver(resizeCamera).observe(root);
  requestAnimationFrame(() => layoutHome(true));
  document.fonts.ready.then(() => {
    if (!chosen && !manual) layoutHome(true);
  });

  return {
    root,
    main,
    camera,
    screen,
    worldRect,
    reduced,
    get chosen() {
      return chosen;
    },
    get plots() {
      return plots;
    },
    onRender(schedule, redraw) {
      renderCamera = schedule;
      rendererResize = redraw;
    },
  };
}
