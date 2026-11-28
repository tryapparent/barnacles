export function drawPlots({
  bounds,
  worldRect,
  chosen,
  plots,
  g,
  fogBank,
  seedbed,
  furrows,
  grains,
  tri,
  first,
  worldBox,
  camera,
  scaleY,
}) {
  const categories = [...document.querySelectorAll("#tiles>.category-tile")];
  for (const el of categories) {
    const r = bounds(el);
    if (!r.w) continue;
    const kind = el.classList.contains("agent")
      ? "grain"
      : el.classList.contains("workflow")
        ? "soil"
        : "fog";
    const beds =
      plots.length && chosen?.el === el
        ? plots.map((p, i) => ({
            ...p.r,
            x: p.r.x + 0.6,
            y: p.r.y + 0.6,
            w: p.r.w - 1.2,
            h: p.r.h - 1.2,
            till: i % 2 ? -0.075 : 0.055,
          }))
        : [{ ...r, till: 0.04 }];
    for (const bed of beds) {
      if (kind === "fog") {
        fogBank(bed);
        continue;
      }
      seedbed(bed, kind);
      if (kind === "soil") furrows(bed);
      else grains(bed, null, false);
    }
  }
  for (const { r } of plots.slice(1)) {
    const parent = worldRect(chosen.el),
      vertical = r.x <= parent.x + 0.5;
    const x = r.x,
      z = r.y,
      width = vertical ? r.w : 1.8,
      height = vertical ? 1.8 : r.h;
    tri(
      [x, 2.9, z],
      [x + width, 2.9, z],
      [x, 2.9, z + height],
      [0.63, 0.5, 0.29],
    );
    tri(
      [x + width, 2.9, z],
      [x + width, 2.9, z + height],
      [x, 2.9, z + height],
      [0.62, 0.49, 0.28],
    );
  }
  const svg = first(".trend-plot svg"),
    curve = svg?.querySelector(".trend-series"),
    field = svg?.querySelector("foreignObject");
  if (
    field &&
    curve &&
    first(".batch-trigger")?.getAttribute("aria-expanded") !== "true"
  ) {
    const r = bounds(field);
    seedbed(r, "soil");
    const len = curve.getTotalLength(),
      mat = svg.getScreenCTM(),
      line = [];
    for (let i = 0; i <= 85; i++) {
      const p = curve.getPointAtLength((len * i) / 85).matrixTransform(mat);
      line.push([
        (p.x - worldBox.left) / camera.s,
        (p.y - worldBox.top) / scaleY,
      ]);
    }
    g.save();
    g.beginPath();
    g.moveTo(...line[0]);
    for (const pt of line) g.lineTo(...pt);
    g.lineTo(r.x + r.w, r.y + r.h);
    g.lineTo(r.x, r.y + r.h);
    g.closePath();
    g.clip();
    seedbed(r, "grain");
    g.restore();
    let seg = 0;
    grains(r, (x) => {
      while (seg < line.length - 2 && line[seg + 1][0] < x) seg++;
      const [a, b] = [line[seg], line[seg + 1]];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || 1);
    });
  }
}
