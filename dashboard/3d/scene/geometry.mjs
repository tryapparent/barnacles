export function fieldGeometry({
  verts,
  grassLocations,
  cutLocations,
  fogVertices,
  g,
  shade,
}) {
  function grains(r, edge, small = false, cut = false, identity = "") {
    const gap = small ? 4.8 : 8.3,
      row = small ? 4.3 : 6.2;
    let seed = 2166136261;
    for (const ch of identity)
      seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    const hash = (col, line, salt) => {
      let h =
        seed ^
        Math.imul(col + 1, 73856093) ^
        Math.imul(line + 1, 19349663) ^
        Math.imul(salt, 83492791);
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    for (let col = 0; col * gap < r.w; col++) {
      for (let line = 0; line * row < r.h; line++) {
        const x = r.x + (col + 0.33) * gap + hash(col, line, 1) * 0.66;
        const z = r.y + (line + 0.33) * row + hash(col, line, 2) * 0.85;
        if (x >= r.x + r.w || z >= r.y + r.h || (edge && z < edge(x))) continue;
        const height = (small ? 4.1 : 7.8) * (0.78 + hash(col, line, 3) * 0.46);
        (cut ? cutLocations : grassLocations).push(
          x,
          z,
          height,
          hash(col, line, 4) * 6.28,
        );
      }
    }
  }
  function furrows(r, small = false) {
    const gap = small ? 5 : 14,
      ht = small ? 0.8 : 2.7;
    function surface(a, b, c) {
      for (const [x, y, z, t] of [a, b, c])
        verts.push(x, y, z, 1, 1, 1, 5 + t, 0, 0);
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
        [clamp(x), 0.05, z, 0],
        [
          clamp(x + (end - x) * 0.43),
          ht * (1 + 0.19 * Math.sin(z * 0.13 + x * 0.07)),
          z,
          0.43,
        ],
        [clamp(end), 0.05, z, 1],
      ];
    }
    const margin = Math.abs(tilt) * r.h + gap;
    for (let x = r.x - margin; x < r.x + r.w + margin; x += gap) {
      let top = ring(x, x + gap, r.y);
      for (let j = 1; j <= steps; j++) {
        const bottom = ring(x, x + gap, r.y + (r.h * j) / steps);
        surface(top[0], bottom[0], top[1]);
        surface(bottom[0], bottom[1], top[1]);
        surface(top[1], bottom[1], top[2]);
        surface(bottom[1], bottom[2], top[2]);
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
  return { grains, furrows, timber, canopyShadow, fogBank };
}
