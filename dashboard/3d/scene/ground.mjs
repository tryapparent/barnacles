export function groundMaterials(g, images, rand) {
  function pat(k, sx, sy = sx) {
    const pat = g.createPattern(images[k], "repeat");
    pat.setTransform(new DOMMatrix().scale(sx, sy));
    return pat;
  }
  function gradient(x, y, r, inner, outer) {
    const a = g.createRadialGradient(x, y, 0, x, y, r);
    a.addColorStop(0, inner);
    a.addColorStop(1, outer);
    return a;
  }
  function shade(x, y, rx, ry, color) {
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    g.fillStyle = gradient(0, 0, rx, color, "transparent");
    g.fillRect(-rx, -rx, 2 * rx, 2 * rx);
    g.restore();
  }
  function seedbed(r, kind, small = false) {
    if (!r || r.w < 0.4 || r.h < 0.4) return;
    const s =
      kind === "soil"
        ? small
          ? 0.18
          : 0.83
        : kind === "grain"
          ? small
            ? 0.29
            : 0.76
          : small
            ? 0.28
            : 0.77;
    g.save();
    g.fillStyle = pat(
      kind === "grain" ? "soil" : kind,
      kind === "grain" ? 0.37 : s,
    );
    g.translate(r.x, r.y);
    if (kind === "soil" && !small) g.drawImage(images.soil, 0, 0, r.w, r.h);
    else g.fillRect(0, 0, r.w, r.h);
    const picks = document.querySelectorAll(
      ".field-settings-controls input[type=color]",
    );
    const idx = kind === "soil" ? 0 : kind === "grain" ? 1 : 2;
    if (
      picks[idx] &&
      picks[idx].value !== ["#543b2a", "#91ad5f", "#dfbf89"][idx]
    ) {
      g.save();
      g.globalCompositeOperation = "color";
      g.fillStyle = picks[idx].value;
      g.fillRect(0, 0, r.w, r.h);
      g.restore();
    }
    g.fillStyle =
      kind === "soil"
        ? "rgba(39,18,4,.13)"
        : kind === "grain"
          ? "rgba(37,51,15,.46)"
          : "rgba(236,185,96,.2)";
    g.fillRect(0, 0, r.w, r.h);
    const ridge = g.createLinearGradient(0, 0, 0, r.h);
    ridge.addColorStop(0, "#34210855");
    ridge.addColorStop(0.1, "#40230500");
    ridge.addColorStop(1, "#a7713614");
    g.fillStyle = ridge;
    g.fillRect(0, 0, r.w, r.h);
    g.restore();
  }
  function track(x1, z1, x2, z2, width) {
    const dx = x2 - x1,
      dz = z2 - z1,
      len = Math.hypot(dx, dz),
      steps = Math.ceil(len / 4);
    g.save();
    g.translate(x1, z1);
    g.rotate(Math.atan2(dz, dx));
    const wav = (t) =>
      1.2 * Math.sin(t * 0.021) +
      0.55 * Math.sin(t * 0.073) +
      2.1 * Math.sin(t * 0.006);
    for (const [spread, fill] of [
      [1.8, "#746533"],
      [0.8, "#9e8954"],
      [0, pat("road", 1.15, 1.1)],
    ]) {
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = (len * i) / steps;
        g.lineTo(t, wav(t) - width / 2 - spread - rand() * 0.95);
      }
      for (let i = steps; i >= 0; i--) {
        const t = (len * i) / steps;
        g.lineTo(t, wav(t) + width / 2 + spread + rand() * 1.5);
      }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    }
    for (let i = 0; i < len * 0.65; i++) {
      const x = rand() * len;
      g.fillStyle = rand() > 0.5 ? "#dabc877a" : "#59472565";
      g.fillRect(
        x,
        wav(x) + (rand() - 0.5) * width,
        rand() * 2.8 + 0.3,
        rand() * 1.2 + 0.4,
      );
    }
    g.restore();
  }
  return { shade, seedbed, track };
}
