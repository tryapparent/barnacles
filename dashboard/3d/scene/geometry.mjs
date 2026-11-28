export function fieldGeometry({
  verts,
  grassLocations,
  cutLocations,
  fogVertices,
  g,
  rand,
  shade,
  seedbed,
}) {
  function grains(r, edge, small = false, cut = false) {
    if (r.w < 1 || r.h < 1) return;
    const gap = cut ? (small ? 4.7 : 8.5) : small ? 4.8 : 8.3,
      row = small ? 4.3 : 6.2;
    for (let x = r.x + gap * 0.33; x < r.x + r.w - 0.2; x += gap) {
      const top = edge ? Math.max(r.y, edge(x)) : r.y;
      for (let z = top + row * 0.33; z < r.y + r.h - 0.2; z += row) {
        const h = cut ? (small ? 1.75 : 2.9) : small ? 3.9 : 6.35;
        (cut ? cutLocations : grassLocations).push(
          x + rand() * 0.66,
          z + rand() * 0.85,
          h * (0.78 + rand() * 0.46),
          rand() * 6.28,
        );
      }
    }
  }
  function furrows(r, small = false) {
    const gap = small ? 5 : 9,
      ht = small ? 0.78 : 1.55;
    function surface(a, b, c, light) {
      for (const [x, y, z] of [a, b, c])
        verts.push(x, y, z, light, light, light, 5 + x / 210, 2 + z / 180, 0);
    }
    const tilt = r.till || 0,
      steps = Math.max(1, Math.ceil(r.h / 12));
    function ring(x, end, z) {
      const shift =
        tilt * (z - r.y - r.h * 0.5) +
        0.68 * Math.sin(z * 0.043 + x * 0.063) +
        0.46 * Math.sin(z * 0.067 + x * 0.12);
      const clamp = (v) => Math.min(r.x + r.w, Math.max(r.x, v + shift));
      return [
        [clamp(x), 0.05, z],
        [
          clamp(x + (end - x) * 0.43),
          ht * (1 + 0.19 * Math.sin(z * 0.13 + x * 0.07)),
          z,
        ],
        [clamp(end), 0.05, z],
      ];
    }
    const margin = Math.abs(tilt) * r.h + gap;
    for (let x = r.x - margin; x < r.x + r.w + margin; x += gap) {
      let top = ring(x, x + gap, r.y);
      for (let j = 1; j <= steps; j++) {
        const bottom = ring(x, x + gap, r.y + (r.h * j) / steps);
        const lit = 1.09 + 0.065 * Math.sin(x * 0.42 + j * 0.39);
        surface(top[0], bottom[0], top[1], lit);
        surface(bottom[0], bottom[1], top[1], lit - 0.015);
        surface(top[1], bottom[1], top[2], 0.89);
        surface(bottom[1], bottom[2], top[2], 0.9);
        top = bottom;
      }
    }
  }
  function timber(x, z, r) {
    const n = 18,
      span = r * 3.08;
    function vertex(i, j) {
      const u = i / n,
        v = j / n,
        dx = (u - 0.49) * 2,
        dy = (v - 0.49) * 2,
        arch = Math.sqrt(Math.max(0, 1 - dx * dx * 0.88 - dy * dy));
      const y =
        r *
        arch *
        (1.52 + 0.28 * Math.sin(u * 13 + v * 7)) *
        (1 - Math.pow(v, 7));
      verts.push(
        x + (u - 0.49) * span,
        y,
        z + (v - 0.94) * span * 0.82 + y * 0.35,
        1,
        1,
        1,
        u + 2,
        v,
        -r,
      );
    }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        vertex(i, j);
        vertex(i + 1, j);
        vertex(i, j + 1);
        vertex(i + 1, j);
        vertex(i + 1, j + 1);
        vertex(i, j + 1);
      }
  }
  function canopyShadow(x, z, r) {
    g.save();
    g.translate(x, z);
    g.rotate(0.55);
    for (let i = 0; i < 16; i++) {
      const t = i / 16;
      shade(
        r * (0.5 + t * 1.9),
        r * (0.5 + t * 0.4),
        r * (0.6 + 0.55 * t),
        r * (0.36 + 0.42 * t),
        "rgba(39,30,9,.23)",
      );
    }
    g.restore();
  }

  function fogBank(r) {
    if (r.w <= 0 || r.h <= 0) return;
    const height = Math.min(32, Math.max(3, Math.min(r.w * 0.65, r.h * 0.64)));
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      fogVertices.push(
        r.x + r.w * u,
        height * (1 - v),
        r.y + r.h * v,
        r.w,
        r.h,
        height,
        -8 - u,
        v,
        0,
      );
    }
  }
  function strip(r, kind) {
    if (r.w < 1 || r.h < 1) return;
    if (kind === "fog") {
      fogBank(r);
      return;
    }
    seedbed(r, kind, true);
    if (kind === "grain") grains(r, null, true);
    else furrows(r, true);
  }
  return { grains, furrows, timber, canopyShadow, fogBank, strip };
}
