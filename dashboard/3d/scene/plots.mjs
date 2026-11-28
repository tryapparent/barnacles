import { fieldGeometry } from "./geometry.mjs";

export function plotSpecs(board) {
  const specs = board.surfaces
    .filter((d) => d.r.w > 0 && d.r.h > 0)
    .map((d) => ({
      slot: d.slot ?? d.key,
      material: d.material,
      r: d.r,
      small: !!d.small,
      shade: d.shade,
    }));
  for (const [index, run] of board.runs.entries()) {
    if (run.length < 2) {
      const [x, y] = run[0];
      specs.push({
        slot: "trend/point/" + index,
        material: "point",
        r: { x: x - 3, y: y - 1, w: 6, h: 2 },
      });
      continue;
    }
    const r = {
      x: run[0][0],
      y: board.trend.y,
      w: run.at(-1)[0] - run[0][0],
      h: board.trend.h,
    };
    specs.push({
      slot: "trend/run/" + index,
      material: "trend",
      r,
      points: run.map(([x, y]) => [x - r.x, y - r.y]),
    });
  }
  return specs;
}
export function plotMesh(spec, plants) {
  const { r, small, material, points, slot } = spec;
  let surface = [],
    canopy = [];
  const verts = [],
    grassLocations = [],
    fogVertices = [];
  const local = { x: 0, y: 0, w: r.w, h: r.h, till: small ? -0.12 : -0.32 };
  const { fogBank, grains, furrows } = fieldGeometry({
    verts,
    grassLocations,
    fogVertices,
  });
  function quad(out, x0, x1, lower0, lower1, upper0, upper1) {
    for (const [x, z] of [
      [x0, lower0],
      [x1, lower1],
      [x0, upper0],
      [x0, upper0],
      [x1, lower1],
      [x1, upper1],
    ])
      out.push(x, 0, z, 1, 1, 1, -1, 0, 0);
  }
  if (material === "point") {
    for (const [x, z] of [
      [0, 0],
      [r.w, 0],
      [0, r.h],
      [0, r.h],
      [r.w, 0],
      [r.w, r.h],
    ])
      verts.push(x, 0.34, z, 0.95, 0.82, 0.49, -1, 0, 0);
  } else if (material === "fog") fogBank(local);
  else if (material === "trend") {
    for (let i = 1; i < points.length; i++) {
      const [[x0, y0], [x1, y1]] = [points[i - 1], points[i]];
      quad(surface, x0, x1, 0, 0, y0, y1);
      quad(canopy, x0, x1, y0, y1, r.h, r.h);
    }
    function beam(a, b, height, thickness) {
      const color = [.60, .49, .32];
      for (const [x,y,z] of [[a[0],height,a[1]],[b[0],height,b[1]],
        [a[0],height+thickness,a[1]],[a[0],height+thickness,a[1]],
        [b[0],height,b[1]],[b[0],height+thickness,b[1]]]) {
        verts.push(x,y,z,...color,-1,0,0);
      }
    }
    for (let i=1;i<points.length;i++) {
      const a=points[i-1], b=points[i];
      beam(a,b,4.6,1.1);
      beam(a,b,2.1,.72);
      const posts=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/16));
      for(let post=0;post<posts;post++) {
        const t=post/posts, x=a[0]+(b[0]-a[0])*t, z=a[1]+(b[1]-a[1])*t;
        beam([x-.65,z],[x+.65,z],0,6.3);
      }
    }
    const end=points.at(-1);
    beam([end[0]-.65,end[1]],[end[0]+.65,end[1]],0,6.3);
    if (plants)
      grains(
        local,
        (x) => {
          const index = Math.min(
            points.length - 2,
            Math.floor((x / r.w) * (points.length - 1)),
          );
          const [a, b] = [points[index], points[index + 1]];
          return 16 + a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
        },
        false,
        false,
        slot + "/grain",
      );
  } else {
    quad(material === "grain" ? canopy : surface, 0, r.w, 0, 0, r.h, r.h);
    if (material === "grain" && plants)
      grains(local, null, small, false, slot + "/grain");
    if (material === "soil") furrows(local, small);
  }
  return {
    surface,
    canopy,
    relief: verts,
    plants: grassLocations,
    fog: fogVertices,
  };
}
