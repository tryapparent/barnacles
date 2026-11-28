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
      const crest = clamp(x + (end - x) * .43);
      const taper = Math.max(.02, Math.min(1, (z-r.y)/4, (r.y+r.h-z)/4,
        (crest-r.x)/4, (r.x+r.w-crest)/4));
      return [
        [clamp(x), 0.05, z, 0],
        [
          crest,
          ht * taper * (1 + 0.19 * Math.sin(z * 0.13 + x * 0.07)),
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
        crownDepth = Math.sin(u * Math.PI) * Math.sin(v * Math.PI);
      const y = (1 - v) * span;
      verts.push(
        x + (u - .5) * span,
        y,
        z + crownDepth * r * .42,
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
  function cottage(x, z, width, depth, height, angle) {
    const wall = [.64,.52,.34], gable = [.48,.38,.26];
    const door = [.18,.145,.10], roof = [.45,.25,.15], tile = [.53,.32,.20];
    const front = depth / 2, back = -front, left = -width / 2, right = -left;
    const peak = height + depth * .35;
    function face(color, ...corners) {
      for (let i = 2; i < corners.length; i++) {
        for (const [u, y, v] of [corners[0], corners[i-1], corners[i]]) {
          verts.push(x + u*Math.cos(angle)-v*Math.sin(angle), y,
            z + u*Math.sin(angle)+v*Math.cos(angle), ...color, -5, y, 0);
        }
      }
    }
    for (const end of [left,right]) {
      face(gable,[end,0,front],[end,height,front],[end,peak,0],[end,height,back],[end,0,back]);
    }
    for (const v of [front,back]) {
      face(wall,[left,0,v],[right,0,v],[right,height,v],[left,height,v]);
      face(v===front?tile:roof,[left-1,height,v*1.12],[right+1,height,v*1.12],
        [right+1,peak,0],[left-1,peak,0]);
    }
    for (const col of [-.32,0,.32]) {
      const u=width*col, sill=col===0?0:height*.38, edge=width*(col===0?.09:.045);
      face(door,[u-edge,sill,front+.15],[u+edge,sill,front+.15],
        [u+edge,height*.79,front+.15],[u-edge,height*.79,front+.15]);
    }
  }
  function verge(x, z, size, rand) {
    const vertex = (point, color) => verts.push(...point, ...color, -3, 0, 0);
    const stonePoint = (i, j) => {
      const a = i*Math.PI/14, latitude = j*Math.PI/18;
      const radius = size*Math.cos(latitude)*(1+.06*Math.sin(3*a)+.035*Math.cos(5*a+latitude));
      const light = .74+.20*Math.sin(latitude)+.12*Math.cos(a+1.1)*Math.cos(latitude);
      return [x+Math.cos(a)*radius, size*(.56*Math.sin(latitude)-.06),
        z+Math.sin(a)*radius*.70, .42*light,.42*light,.31*light,-4,0,0];
    };
    for (let j=0;j<9;j++) for (let i=0;i<28;i++) {
      const a=stonePoint(i,j), b=stonePoint(i+1,j);
      const c=stonePoint(i,j+1), d=stonePoint(i+1,j+1);
      verts.push(...a,...b,...c,...c,...b,...d);
    }
    for(let clump=0;clump<15;clump++) {
      const baseX=x+(rand()-.5)*size*4.4, baseZ=z+(rand()-.46)*size*1.7;
      for(let stalk=0;stalk<10;stalk++) {
        const sx=baseX+(rand()-.5)*5, sz=baseZ+rand()*5;
        const ht=size*(.25+rand()*.62), lean=(rand()-.58)*ht*.68;
        const tone=rand()>.52?[.67,.52,.27]:[.39,.37,.17];
        const waist=[sx+lean*.30,ht*.67,sz], tip=[sx+lean,ht,sz];
        for(const v of [[sx-.42,0,sz],[sx+.42,0,sz],waist,waist,[waist[0]+.58,waist[1],sz],tip]) vertex(v,tone);
        if(stalk%3===0) {
          const grain=[.80,.64,.38];
          for(const v of [tip,[tip[0]+1.2,ht+1.8,sz],[tip[0]+lean*.25,ht+3.4,sz]]) vertex(v,grain);
        }
      }
    }
  }
  return { grains, furrows, timber, canopyShadow, fogBank, cottage, verge };
}
