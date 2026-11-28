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
    const lane = (t, side) => wav(t) + side * width * (.28 + .024 * Math.sin(t / 37));
    for (const side of [-1, 1]) {
      for (const [spread, fill] of [[.23, "#6a633b99"], [.15, pat("road", .85)], [.055, "#c2a47882"]]) {
        g.beginPath();
        for (const direction of [1, -1]) {
          for (let i = 0; i <= steps; i++) {
            const t = len * (direction === 1 ? i : steps - i) / steps;
            g.lineTo(t, lane(t, side) + direction * (width * spread + rand() * .8));
          }
        }
        g.closePath();
        g.fillStyle = fill;
        g.fill();
      }
    }
    g.restore();
  }
  return { shade, track };
}
