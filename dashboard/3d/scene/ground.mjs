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
  return { shade, track };
}
