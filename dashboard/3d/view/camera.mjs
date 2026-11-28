import { hillside } from "../scene/ground.mjs";
export function groundScreen(pose, w, h, x, z, above = 0) {
  const [breadth,slope,tilt,offset]=pose.lens;
  const ground=(pose.y+z*pose.p*pose.s)/h;
  const altitude=(pose.terrain.height(x,z)+above)*pose.s/h;
  const depth=1+tilt*(.5-ground-.84*altitude);
  return [w/2+(pose.x+x*pose.s-w/2)*breadth/depth,
    h*(offset+(slope*ground-pose.vertical*altitude)/depth)];
}

function labelOrigin(label,world) {
  let x=0,z=0;
  for(let node=label;node && node!==world;node=node.offsetParent){
    x+=node.offsetLeft;
    z+=node.offsetTop;
  }
  return [x,z];
}

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
  let labelPositions=new WeakMap();
  document.fonts.ready.then(()=>{labelPositions=new WeakMap(); if(active && layout) paint();});
  function paint() {
    root.style.setProperty("--scale", pose.s);
    root.style.setProperty("--pitch", pose.p);
    const breadth = .935, slope = .57, tilt = .44, offset = .192;
    const far = 1 + tilt / 2;
    pose.terrain = layout && hillside(layout);
    pose.lens = [breadth, slope, tilt, offset];
    const world = root.querySelector("main");
    if (world) {
      const height = root.clientHeight, center = root.clientWidth / 2;
      const k = -tilt / height;
      const altitude = Math.sqrt(1-pose.p*pose.p);
      const vertical = altitude + (1.18-altitude)*tilt/.44;
      pose.vertical = vertical;
      const plane = [breadth,0,0,0, center*k,slope-offset*tilt,0,k,
        center*k*.84,-vertical-offset*tilt*.84,1,k*.84, center*(far-breadth),offset*height*far,0,far];
      const affine = [pose.s,0,0,0, 0,pose.s*pose.p,0,0, 0,0,pose.s,0, pose.x,pose.y,0,1];
      world.style.transform = "matrix3d(" + plane + ") matrix3d(" + affine + ")";
      if (pose.terrain) {
        for (const panel of world.querySelectorAll("#summary-panel,.agent-work-trend,#timeline-panel"))
          panel.style.transform = "matrix3d(" + pose.terrain.plane(panel.id === "timeline-panel") + ")";
      }
      if (pose.terrain && !document.body.dataset.focused) {
        const labels=world.querySelectorAll("h2,.batch-trigger,.inspectable .sample-title");
        for (const label of labels) {
          let origin=labelPositions.get(label);
          if(!origin) {origin=labelOrigin(label,world);labelPositions.set(label,origin);}
          const [x,z]=origin;
          const project=(u,v)=>groundScreen(pose,center*2,height,u,v);
          const [px,py]=project(x,z), [xx,xy]=project(x+1,z), [yx,yy]=project(x,z+1);
          const a=xx-px,b=xy-py,c=yx-px,d=yy-py;
          const determinant=a*d-b*c;
          if(Math.abs(determinant)<.0001) continue;
          const size=label.closest("#timeline-panel") ? .84 : .95;
          const scale=Math.min(base*1.08,1)*size/determinant;
          const inset = label.classList.contains("sample-title") && pose.s <= base*1.01
            ? Math.max(0,14-px)/determinant : 0;
          label.style.transformOrigin="0 0";
          label.style.transform="matrix("+[d*scale,-b*scale,-c*scale,a*scale,d*inset,-b*inset]+")";
        }
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
    if(layout!==board) labelPositions=new WeakMap();
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
          y: (h - board.height * base * 0.93) / 2 + h*.044,
        },
        immediate,
      );
      return;
    }
    const r = item.kind === "batch" ? board.trend : item.r,
      p = 0.48;
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
    const centerX=r.x+r.w*.5, centerZ=r.y+r.h*.5;
    const altitude=hillside(board).height(centerX,centerZ)*s/h;
    const row=.565-.192;
    const ground=(row*1.22+altitude*(1.18-row*.44*.84))/(.57+row*.44);
    move(
      {
        s,
        p,
        x: w * .5 - centerX * s,
        y: h * ground - centerZ * s * p,
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
