export function botanicalModel(distant) {
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
    for (let side = 0; side < 3; side++) {
      const a = side * Math.PI * 2 / 3,
        b = a + Math.PI * 2 / 3,
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
  if (distant) {
    const straw=[.62,.58,.27],leaf=[.36,.45,.13],ear=[.80,.69,.36];
    facet([-.04,0,0],[.05,0,0],[.12,1.72,0],straw);
    for(let j=0;j<4;j++) {
      const a=j*2.41,dx=Math.cos(a),dz=Math.sin(a),y=.15+j*.21;
      const base=[0,y,0],tip=[.83*dx,y+.28,.83*dz];
      const ridge=[.43*dx,y+.34,.43*dz];
      facet(base,[ridge[0]-.15*dz,ridge[1]-.08,ridge[2]+.15*dx],tip,leaf);
      facet(base,tip,ridge,shade(leaf,1.17));
    }
    facet([.05,1.40,0],[.20,1.54,.04],[.11,1.95,0],ear);
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
    const green = [0.32 + j * 0.019, 0.43 + j * 0.015, 0.085];
    function blade(t, side) {
      const belly = Math.sin(Math.PI * t);
      const across = side * width * belly;
      const reach = span * t;
      const y = h + .28 * t + .32 * belly - Math.abs(side) * belly * .055;
      return [dx * reach - dz * across, y, dz * reach + dx * across];
    }
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const t = k/2, end = (k+1)/2;
        const base=blade(t,0), edge=blade(t,side), next=blade(end,0), rim=blade(end,side);
        const low=shade(green,.88+.10*t+.08*side), high=shade(green,.94+.12*end+.08*side);
        if(k>0) { vertex(base,low); vertex(edge,low); vertex(next,high); }
        if(k<1) { vertex(edge,low); vertex(rim,high); vertex(next,high); }
      }
    }
  }
  for (let j = 0; j < 4; j++) {
    const a = j * 2.4,
      dx = Math.cos(a),
      dz = Math.sin(a),
      y = 1.32 + j * 0.105;
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
