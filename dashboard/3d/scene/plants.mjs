export function botanicalModel(cut) {
  const v = [];
  const shade = (c, q) => c.map((n) => n * q);
  function vertex(p, c) {
    v.push(...p, ...c, -1, 0, p[1] * 0.115);
  }
  function facet(a, b, c, tone) {
    vertex(a, tone);
    vertex(b, tone);
    vertex(c, tone);
  }
  function stem(x, z, height, r, tint) {
    for (let side = 0; side < 4; side++) {
      const a = (side * Math.PI) / 2,
        b = a + Math.PI / 2,
        col = shade(tint, 0.67 + 0.3 * Math.max(0, Math.cos(a + 1)));
      const p = [x + Math.cos(a) * r, 0, z + Math.sin(a) * r],
        q = [x + Math.cos(b) * r, 0, z + Math.sin(b) * r];
      const s = [
          x + 0.12 + Math.cos(a) * r * 0.56,
          height,
          z + Math.sin(a) * r * 0.56,
        ],
        t = [
          x + 0.12 + Math.cos(b) * r * 0.56,
          height,
          z + Math.sin(b) * r * 0.56,
        ];
      facet(p, q, t, col);
      facet(p, t, s, col);
    }
  }
  if (cut) {
    for (let j = 0; j < 4; j++) {
      const a = j * 2.4;
      stem(
        Math.cos(a) * 0.37,
        Math.sin(a) * 0.37,
        0.55 + j * 0.11,
        0.073,
        [0.74, 0.61, 0.31],
      );
    }
    return v;
  }
  stem(0, 0, 1.55, 0.048, [0.61, 0.63, 0.2]);
  for (let j = 0; j < 5; j++) {
    const a = j * 2.41,
      dx = Math.cos(a),
      dz = Math.sin(a),
      h = 0.14 + j * 0.18,
      span = 0.98 - j * 0.105,
      width = 0.182 - j * 0.012;
    const q = [dx * span * 0.58, h + 0.44, dz * span * 0.58],
      tip = [dx * span, h + 0.25, dz * span],
      base = [0, h, 0];
    const l = [q[0] - dz * width, q[1] - 0.07, q[2] + dx * width],
      r = [q[0] + dz * width, q[1] - 0.07, q[2] - dx * width];
    const mid = [q[0], q[1] + 0.045, q[2]],
      green = [0.32 + j * 0.019, 0.43 + j * 0.015, 0.085];
    facet(base, l, mid, shade(green, 0.7));
    facet(base, mid, r, green);
    facet(l, tip, mid, shade(green, 1.06));
    facet(mid, tip, r, shade(green, 1.33));
  }
  for (let j = 0; j < 6; j++) {
    const a = j * 2.4,
      dx = Math.cos(a),
      dz = Math.sin(a),
      y = 1.32 + j * 0.072;
    const O = [0.11, y, 0],
      tip = [0.11 + dx * 0.16, y + 0.23, dz * 0.16],
      left = [0.11 + dx * 0.094 - dz * 0.065, y + 0.1, dz * 0.094 + dx * 0.065],
      right = [
        0.11 + dx * 0.094 + dz * 0.065,
        y + 0.1,
        dz * 0.094 - dx * 0.065,
      ],
      ridge = [0.11 + dx * 0.18, y + 0.12, dz * 0.18];
    facet(O, left, ridge, [0.55, 0.48, 0.19]);
    facet(O, ridge, right, [0.69, 0.62, 0.25]);
    facet(left, tip, ridge, [0.78, 0.68, 0.32]);
    facet(ridge, tip, right, [0.87, 0.77, 0.39]);
    facet(
      left,
      tip,
      [tip[0] + dx * 0.1, tip[1] + 0.13, tip[2] + dz * 0.1],
      [0.66, 0.59, 0.26],
    );
  }
  return v;
}
