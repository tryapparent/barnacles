export function drawThreads({ bounds, first, g, rand, strip }) {
  const visibleBounds = bounds(first(".timeline-viewport"));
  for (const el of document.querySelectorAll(".bar")) {
    const rail = bounds(el.closest(".rail")),
      r = bounds(el);
    const clip = (r) => {
      const x = Math.max(r.x, rail.x, visibleBounds.x),
        end = Math.min(
          rail.x + rail.w,
          r.x + r.w,
          visibleBounds.x + visibleBounds.w,
        );
      return { ...r, x, w: Math.max(0, end - x) };
    };
    const rect = clip(r);
    if (
      rect.w < 1 ||
      rect.y < visibleBounds.y ||
      rect.y + rect.h > visibleBounds.y + visibleBounds.h
    )
      continue;
    g.save();
    g.beginPath();
    g.rect(rail.x, rail.y, rail.w, rail.h);
    g.clip();

    g.fillStyle = "#76895852";
    g.fillRect(rail.x, rail.y, rail.w, rail.h);
    for (let k = 0; k < 3; k++) {
      const y = rail.y + (rail.h * k) / 3,
        band = g.createLinearGradient(0, y, 0, y + rail.h / 3);
      band.addColorStop(0, "#293f2716");
      band.addColorStop(0.28, "#b5ad721a");
      band.addColorStop(1, "#666e4110");
      g.fillStyle = band;
      g.fillRect(rail.x, y, rail.w, rail.h / 3);
    }
    for (let k = 0; k < rail.w * 0.13; k++) {
      const x = rail.x + rand() * rail.w,
        y = rail.y + 1 + rand() * (rail.h - 3);
      g.strokeStyle = k % 4 ? "#a8a26c60" : "#d6c58b75";
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 2, y - 1, x + 3 + rand() * 4, y - 0.8 - rand());
      g.stroke();
    }
    for (let line = rail.y + 2; line < rail.y + rail.h; line += 5) {
      g.strokeStyle = "#55563238";
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(rail.x, line);
      g.bezierCurveTo(
        rail.x + rail.w * 0.33,
        line + 1,
        rail.x + rail.w * 0.74,
        line - 2,
        rail.x + rail.w,
        line + 0.3,
      );
      g.stroke();
    }
    g.fillStyle = "#cabf8b66";
    g.fillRect(rail.x, rail.y + rail.h - 0.8, rail.w, 0.8);
    g.restore();

    for (const span of el.querySelectorAll(".field-span"))
      strip(
        clip(bounds(span)),
        span.dataset.kind === "2"
          ? "grain"
          : span.dataset.kind === "1"
            ? "soil"
            : "fog",
      );
  }
}
