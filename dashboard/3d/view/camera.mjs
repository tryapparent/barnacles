export function createCamera(root, update) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const pose = { x: 0, y: 0, s: 1, p: 0.93 };
  let goal = { ...pose },
    base = 1,
    frame = 0,
    moved = false,
    drag,
    suppress = false;
  let layout,
    lastSize,
    active = true;
  function paint() {
    root.style.setProperty("--scale", pose.s);
    root.style.setProperty("--pitch", pose.p);
    const blend = Math.min(1, Math.max(0, 2 - pose.s / base));
    const breadth = 1 - .16 * blend;
    const slope = 1 - .35 * blend;
    const tilt = .44 * blend;
    const offset = .115 * blend;
    const far = 1 + tilt / 2;
    pose.lens = [breadth, slope, tilt, offset];
    const world = root.querySelector("main");
    if (world) {
      const height = root.clientHeight, center = root.clientWidth / 2;
      const k = -tilt / height;
      const plane = [breadth, 0, 0, 0, center*k, slope-offset*tilt, 0, k,
        0, 0, 1, 0, center*(far-breadth), offset*height*far, 0, far];
      const affine = [pose.s, 0, 0, pose.s*pose.p, pose.x, pose.y];
      world.style.transform = "matrix3d(" + plane + ") matrix(" + affine + ")";
      const labels = world.querySelectorAll("h2,.category-tile .parcel-type,.field-story,.tick,.axis,.inspectable .sample-title,.inspectable .meta");
      for (const label of labels) label.style.removeProperty("transform");
      if (blend > 0) {
        const bounds = Array.from(labels, label => label.getBoundingClientRect());
        labels.forEach((label, index) => {
          const r = bounds[index];
          const x = r.x + r.width / 2, y = (r.y + r.height / 2) / height - offset;
          const depth = far - tilt * y * far / (slope + tilt*y);
          const dx = breadth / depth, dy = slope*far / (depth*depth);
          const shear = (x-center)*tilt / (height*depth);
          const size = 1 - .13*blend;
          label.style.transform = "matrix(" + [size/dx,0,-size*pose.p*shear/(dx*dy),size/dy,0,0] + ")";
        });
      }
    }
    update(pose, base, goal.s, moved);
  }
  function move(next, immediate = false, duration = 480) {
    cancelAnimationFrame(frame);
    goal = next;
    const start = performance.now(),
      previous = { ...pose };
    function tick(now) {
      const t =
        immediate || motion.matches ? 1 : Math.min(1, Math.max(0, now - start) / duration);
      const ease = t * t * (3 - 2 * t);
      for (const key of ["x", "y", "s", "p"])
        pose[key] = previous[key] + (goal[key] - previous[key]) * ease;
      paint();
      frame = t < 1 ? requestAnimationFrame(tick) : 0;
    }
    tick(start);
  }
  function fit(board, item, immediate = false) {
    layout = board;
    const w = root.clientWidth,
      h = root.clientHeight;
    lastSize = { w, h };
    base = Math.min(w / board.width, h / (board.height * 0.93), 1);
    moved = !!item;
    if (!item) {
      move(
        {
          s: base,
          p: 0.93,
          x: (w - board.width * base) / 2,
          y: (h - board.height * base * 0.93) / 2,
        },
        immediate,
      );
      return;
    }
    const r = item.r,
      p = 0.72;
    const s = Math.min(
      base * 9,
      Math.max(
        base * 1.35,
        Math.min(
          (w * 0.78) / Math.max(10, r.w),
          (h * 0.46) / Math.max(12, r.h * p),
        ),
      ),
    );
    move(
      {
        s,
        p,
        x: w * 0.5 - (r.x + r.w * 0.5) * s,
        y: h * 0.48 - (r.y + r.h * 0.5) * s * p,
      },
      immediate,
      item.kind === "category" || item.kind === "operation" ? 1200 : 480,
    );
  }
  function resize(board, item) {
    if (!moved || item || !lastSize || !layout) {
      fit(board, item, true);
      return;
    }
    const u = (lastSize.w / 2 - pose.x) / pose.s / layout.width;
    const v = (lastSize.h / 2 - pose.y) / (pose.s * pose.p) / layout.height;
    const ratio = pose.s / base;
    const w = root.clientWidth,
      h = root.clientHeight;
    base = Math.min(w / board.width, h / (board.height * 0.93), 1);
    const s = Math.min(base * 9, Math.max(base, base * ratio));
    lastSize = { w, h };
    layout = board;
    move(
      {
        s,
        p: pose.p,
        x: w / 2 - u * board.width * s,
        y: h / 2 - v * board.height * s * pose.p,
      },
      true,
    );
  }
  function zoom(
    factor,
    x = root.clientWidth / 2,
    y = root.clientHeight * 0.46,
  ) {
    const s = Math.max(base, Math.min(base * 9, goal.s * factor));
    if (s <= base + 0.00001) {
      root.dispatchEvent(new Event("landscape-home"));
      return;
    }
    moved = true;
    move({
      s,
      p: pose.p,
      x: x - ((x - pose.x) * s) / pose.s,
      y: y - ((y - pose.y) * s) / pose.s,
    });
  }
  root.addEventListener(
    "wheel",
    (event) => {
      if (!active || event.target.closest(".farm-detail,details")) return;
      event.preventDefault();
      zoom(
        Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.003),
        event.clientX,
        event.clientY,
      );
    },
    { passive: false },
  );
  root.addEventListener("pointerdown", (event) => {
    if (
      !active ||
      event.button !== 0 ||
      !moved ||
      event.target.closest(".farm-hud")
    )
      return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ox: pose.x,
      oy: pose.y,
      active: false,
    };
  });
  root.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId || !layout) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (!drag.active && Math.hypot(dx, dy) < 5) return;
    drag.active = true;
    root.setPointerCapture(event.pointerId);
    cancelAnimationFrame(frame);
    pose.x = Math.max(
      root.clientWidth * 0.2 - layout.width * pose.s,
      Math.min(root.clientWidth * 0.8, drag.ox + dx),
    );
    pose.y = Math.max(
      root.clientHeight * 0.2 - layout.height * pose.s * pose.p,
      Math.min(root.clientHeight * 0.8, drag.oy + dy),
    );
    goal = { ...pose };
    paint();
  });
  function end() {
    if (drag?.active) {
      suppress = true;
      setTimeout(() => (suppress = false), 0);
    }
    drag = null;
  }
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  root.addEventListener(
    "click",
    (event) => {
      if (suppress) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  motion.addEventListener("change", (event) => {
    if (active && event.matches) move(goal, true);
  });
  return {
    pose,
    enable(value) {
      active = value;
      if (!active) {
        cancelAnimationFrame(frame);
        drag = null;
      }
    },
    fit,
    zoom,
    resize,
    get manual() {
      return moved;
    },
    paint,
  };
}
