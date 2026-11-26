import yardArtwork from '../assets/yard.webp';
import townArtwork from '../assets/town.webp';

const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const depthAt = (y, horizon, height) => Math.max(0, Math.min(1, (y - horizon) / (height - horizon)));
const perspectiveScale = depth => .44 + .56 * depth;
const nearLight = depth => .18 + .82 * Math.min(1, depth / .56) ** .9;

const silverShipRigs = {
  cutter: {
    hull: 'M49 132 Q100 144 183 133 Q225 127 258 113 Q250 136 227 147 Q149 163 89 158 Q60 155 49 132Z',
    masts: [[139, 111, 73, 0, 13]],
    jibs: 2,
  },
  brig: {
    hull: 'M34 123 Q78 130 141 129 Q215 126 260 108 Q254 127 237 140 Q207 152 167 157 Q90 171 48 151 Q39 143 34 123Z',
    masts: [[112, 112, 68, 3, 8], [176, 92, 53, 2, 10]],
    jibs: 2,
  },
  frigate: {
    hull: 'M23 123 Q78 132 141 130 Q207 130 250 113 L277 98 Q266 124 255 135 Q229 156 189 160 Q95 174 43 156 Q29 147 23 123Z',
    masts: [[78, 88, 43, 3, 7], [139, 122, 62, 4, 10], [195, 103, 52, 3, 11]],
    jibs: 3,
  },
};

const silverShipColors = [[8, 11, 14], [126, 145, 154], [238, 243, 242]];
const shipWaterline = 'M0 148 Q28 147 55 148 T104 149 Q126 147 153 148 T205 147 Q237 148 262 146 T300 148';

function drawSilverShip(ctx, rig, threshold) {
  const { width, height } = ctx.canvas;
  const design = silverShipRigs[rig];
  const belowWater = new Path2D(shipWaterline + ' V180 H0 Z');
  const fill = (ink, path) => {
    ctx.fillStyle = ink;
    ctx.fill(new Path2D(path));
  };
  const stroke = (ink, lineWidth, path) => {
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
    ctx.stroke(new Path2D(path));
  };

  function sailWash(x, y, width, light = 1) {
    const ramp = ctx.createLinearGradient(x, y, x + width, y + width * .17);
    const gray = amount => {
      const value = Math.round(amount * light);
      return `rgb(${value},${value},${value})`;
    };
    ramp.addColorStop(0, gray(104));
    ramp.addColorStop(.22, gray(199));
    ramp.addColorStop(.51, gray(242));
    ramp.addColorStop(.79, gray(217));
    ramp.addColorStop(1, gray(96));
    return ramp;
  }

  function squareSail(x, y, width, height, wind) {
    const left = x - width * .47;
    const right = x + width * .52;
    const sail = new Path2D(`M${left} ${y} Q${x} ${y - 3} ${right} ${y + 1}
      Q${right - width * .1} ${y + height * .47} ${right + width * .17} ${y + height}
      Q${x + wind} ${y + height - 6} ${left + width * .17} ${y + height + 3}
      Q${left + width * .15} ${y + height * .46} ${left} ${y}Z`);
    ctx.fillStyle = sailWash(left, y, width);
    ctx.fill(sail);
    ctx.save();
    ctx.clip(sail);
    fill('#3939395e', `M${left} ${y} Q${x - 6} ${y + height * .52} ${left + wind} ${y + height + 5}
      L${left - 8} ${y + height + 6}Z`);
    stroke('#fafafa8c', 1.2, `M${x + 4} ${y - 2} Q${x - 3} ${y + height * .42} ${x + wind + 5} ${y + height + 3}`);
    stroke('#b0b0b0a0', 1, `M${left + 4} ${y + height * .56} Q${x + wind} ${y + height * .44} ${right + 11} ${y + height * .51}`);
    ctx.restore();
    stroke('#d7d7d7', .75, `M${left - 3} ${y} L${right + 3} ${y + 1}`);
  }

  function drawMast([x, height, width, courses, rake], index) {
    const top = 135 - height;
    stroke('#adadad', 1.7, `M${x} 135 L${x - rake} ${top - 9}`);
    stroke('#898989a0', .75, `M${x - rake} ${top} L${x - 30} 133 M${x - rake} ${top} L${x + 25} 130 M${x - rake * .58} ${top + height * .46} L${x - 22} 133`);
    if (courses === 0) {
      fill(sailWash(45, 33, 94), 'M129 37 L68 58 Q73 84 48 122 Q94 110 137 120Z');
      stroke('#cacaca', 1.2, 'M66 57 L129 37 L137 120 L48 122');
      stroke('#d4d4d480', 1, 'M91 50 Q94 84 98 117');
      return;
    }
    for (let course = 0; course < courses; course++) {
      const progress = course / courses;
      const y = top + 4 + course * (height - 22) / courses;
      const center = x - rake * (1 - progress) + 3;
      squareSail(center, y, width * (.63 + .53 * progress), (height - 20) / courses - 3, rake * .38 + course * 2);
    }
    if (index === 1) {
      fill('#bcbcbc', `M${x - rake} ${top - 7} q9 -4 18 -1 l-4 4 q-9 -1 -14 1Z`);
    }
  }

  function drawHeadsails() {
    if (rig === 'cutter') {
      stroke('#aaaaaa', 1.35, 'M127 21 L283 112 L247 123');
      fill(sailWash(139, 48, 83), 'M137 44 Q172 75 218 116 Q186 107 150 124 Q154 77 137 44Z');
      fill(sailWash(155, 36, 116, .93), 'M151 35 Q220 72 273 111 Q244 108 224 116 Q194 79 151 35Z');
      return;
    }
    const [fore, height] = design.masts.at(-1);
    const top = 135 - height;
    stroke('#aaaaaa', 1.35, `M${fore - 9} ${top + 2} L286 94 L245 127 M244 124 L287 94`);
    for (let index = 0; index < design.jibs; index++) {
      const x = fore + index * 13;
      const y = top + index * 12 + 5;
      const clew = 267 + index * 6;
      const h = 111 + index * 3;
      fill(sailWash(x, y, clew - x, 1 - index * .055),
        `M${x} ${y} Q${x + 22} ${y + 25} ${clew} ${h}
        Q${x + 37} ${h - 7} ${x + 13} ${h + 9}
        Q${x + 20} ${y + 29} ${x} ${y}Z`);
      stroke('#dedede85', .85, `M${x} ${y} Q${x + 22} ${y + 25} ${clew} ${h}`);
    }
  }

  function drawHull() {
    const hull = new Path2D(design.hull);
    const paint = ctx.createLinearGradient(0, 109, 0, 165);
    paint.addColorStop(0, '#828282');
    paint.addColorStop(.25, '#3a3a3a');
    paint.addColorStop(.53, '#252525');
    paint.addColorStop(.91, '#151515');
    paint.addColorStop(1, '#515151');
    ctx.fillStyle = paint;
    ctx.fill(hull);
    ctx.save();
    ctx.clip(hull);
    stroke('#9f9f9f', 1.5, 'M24 124 Q116 146 217 128 Q250 121 274 108');
    stroke('#c4c4c4', rig === 'cutter' ? 2.2 : 3.9, 'M27 141 Q111 162 212 145 Q255 137 273 120');
    stroke('#555', 2.2, 'M28 150 Q106 170 197 153 Q241 146 266 130');
    if (rig !== 'cutter') {
      for (let index = 0; index < 19; index++) {
        const x = 39 + index * 10.5;
        const y = 134 + 9.2 * Math.sin(index / 18 * Math.PI) - index * .31;
        ctx.fillStyle = index % 3 ? '#0c0c0c' : '#717171';
        ctx.fillRect(x, y, 3.5, 2.2);
      }
    }
    ctx.restore();
  }

  function drawWaterContact() {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(belowWater);
    ctx.restore();

    ctx.save();
    ctx.clip(belowWater);
    const wash = ctx.createLinearGradient(9, 0, 296, 0);
    wash.addColorStop(0, '#9c9c9c00');
    wash.addColorStop(.14, '#6f6f6f7a');
    wash.addColorStop(.46, '#858585a3');
    wash.addColorStop(.77, '#b4b4b499');
    wash.addColorStop(1, '#a9a9a900');
    fill(wash, shipWaterline + ' Q272 154 240 154 T188 155 Q158 153 125 155 T72 154 Q38 153 0 148Z');
    stroke('#dededecc', 1.15, 'M35 150 Q59 148 78 150 M96 150 Q126 150 145 149 M172 150 Q194 149 211 148 M225 149 Q246 149 266 147');
    stroke('#939393a1', .9, 'M16 154 Q33 153 52 155 M71 155 Q91 154 118 155 M171 155 Q200 154 227 154 M244 152 Q267 153 281 150');
    for (let index = 0; index < 8; index++) {
      const x = 19 + (index * 57 + 11) % 248;
      const y = 159 + (index * 7) % 11;
      const length = 6 + (index * 5) % 11;
      stroke(index % 3 ? '#68686866' : '#b0b0b085', .85, `M${x} ${y} q${length / 2} -1 ${length} 0`);
    }
    ctx.restore();
  }

  ctx.save();
  ctx.scale(width / 300, height / 180);
  design.masts.forEach(drawMast);
  drawHeadsails();
  drawHull();
  drawWaterContact();
  ctx.restore();

  const frame = ctx.getImageData(0, 0, width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (frame.data[index + 3] < 9) continue;
      const tone = Math.floor(frame.data[index] / 255 * 2 + 1 - threshold(x, y));
      frame.data.set(silverShipColors[tone], index);
    }
  }
  ctx.putImageData(frame, 0, 0);
}

const shoreSourceHeight = 1024;
const shoreWaterlines = [
  [[256,429],[273,401],[286,352],[318,363],[363,407],[393,410],[472,409],[517,432],
    [552,433],[566,402],[601,427],[643,510],[689,518],[712,466],[730,430],[780,456],
    [840,498],[910,546],[975,598],[1024,635]],
  [[350,474],[367,460],[386,410],[425,312],[460,237],[493,165],[514,130],[561,136],
    [608,160],[655,187],[718,204],[758,205],[780,253],[798,333],[838,336],
    [858,316],[878,265],[893,223],[927,235],[977,288],[1024,322]],
];
const harborStacks = [
  {x:106,y:588, reach:180, rise:240, size:46},
  {x:243,y:407, reach:130, rise:178, size:38},
  {x:256,y:252, reach:104, rise:111, size:26},
];
const clampHarbor = value => Math.max(0, Math.min(1, value));
function smoothHarbor(low, high, value) {
  const t = clampHarbor((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

async function decodeHarborShore(url) {
  const bitmap = new Image();
  bitmap.src = url;
  await bitmap.decode();
  const source = document.createElement('canvas');
  source.width = bitmap.width;
  source.height = bitmap.height;
  const ctx = source.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, source.width, source.height);
}

function shoreProjection(width, height, horizon) {
  const factor = (sourceY, right) => {
    const depth = smoothHarbor(139, right ? 640 : 403, sourceY);
    const available = Math.min(width * (right ? .205 : .207), height * (right ? .83 : .89));
    return available / (right ? 408 : 635) * (.18 + .82 * depth);
  };
  const toScene = (x, y, right = false) => [
    right ? width - factor(y, true) * x : factor(y, false) * x,
    y / shoreSourceHeight * height,
  ];
  const shoreline = (right) => {
    const path = shoreWaterlines[Number(right)];
    let segment = 0;
    return Float32Array.from({length:height}, (_, row) => {
      if (row <= horizon) return 0;
      const sampleY = row / height * shoreSourceHeight;
      while (segment < path.length - 2 && sampleY > path[segment + 1][0]) segment++;
      const [[y0,x0],[y1,x1]] = path.slice(segment, segment + 2);
      const x = x0 + (x1 - x0) * clampHarbor((sampleY - y0) / (y1 - y0));
      return x * factor(sampleY, right) * smoothHarbor(y0 < 287 ? 286 : path[0][0] - 4, path[0][0] + 49, sampleY);
    });
  };
  return {factor, toScene, banks:[shoreline(false),shoreline(true)]};
}

function paintRealShore(ctx, sources, width, height, projection, day, threshold) {
  const frame = ctx.createImageData(width, height);
  const samples = [[-.31,-.26],[.31,-.26],[-.31,.26],[.31,.26]];
  for (const [bank, source] of sources.entries()) {
    const right = bank === 1;
    for (let y = 0; y < height; y++) {
      const sourceY = (y + .5) / height * shoreSourceHeight;
      const factor = projection.factor(sourceY, right);
      const depth = smoothHarbor(118, 525, sourceY);
      const clarity = .15 + .85 * depth;
      const radius = Math.ceil(source.width * factor);
      const sourceRow = Math.min(source.height - 1, Math.floor(sourceY));
      for (let x = 0; x < radius; x++) {
        const sourceX = Math.min(source.width - 1, (x + .5) / factor);
        let alpha = 0;
        let luma = 0;
        for (const [offsetX,offsetY] of samples) {
          const sx = Math.max(0, Math.min(source.width - 1, Math.floor(sourceX + offsetX / factor)));
          const sy = Math.max(0, Math.min(source.height - 1, Math.floor(sourceRow + offsetY * shoreSourceHeight / height)));
          const pixel = (sy * source.width + sx) * 4;
          const coverage = source.data[pixel + 3] / 255;
          alpha += coverage;
          luma += coverage * source.data[pixel];
        }
        if (alpha < .01) continue;
        const col = right ? width - 1 - x : x;
        const index = (y * width + col) * 4;
        const light = Math.max(0, luma / (255 * alpha) - .037) ** (day ? 1.15 : 1.34);
        const grain = (threshold(col,y) - .5) * (4.5 + light * 6);
        frame.data[index] = (day ? 16 : 10) + light * (day ? 163 : 122) + grain;
        frame.data[index+1] = (day ? 25 : 17) + light * (day ? 165 : 132) + grain;
        frame.data[index+2] = (day ? 32 : 24) + light * (day ? 168 : 140) + grain;
        frame.data[index+3] = alpha * .25 * clarity * 255;
      }
    }
  }
  ctx.putImageData(frame, 0, 0);
}

function drawHarborLantern(ctx, projection, day) {
  const [x,y] = projection.toScene(258,674,true);
  const unit = ctx.canvas.height / shoreSourceHeight;
  const radius = 39 * unit;
  const glow = ctx.createRadialGradient(x,y,0,x,y,radius);
  glow.addColorStop(0, day ? '#dfbc886e' : '#ffd092c7');
  glow.addColorStop(.22, day ? '#dfbc883f' : '#edb67259');
  glow.addColorStop(1,'#f6c48300');
  ctx.fillStyle = glow;
  ctx.fillRect(x-radius,y-radius,2*radius,2*radius);
  ctx.fillStyle=day ? '#dfc090' : '#ffe7af';
  ctx.fillRect(x-4*unit,y-2*unit,8*unit,5*unit);
}

function makeExhaust() {
  const edge = 72;
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = edge;
  const ctx = sprite.getContext('2d');
  const image = ctx.createImageData(edge,edge);
  for (let y=0;y<edge;y++) {
    for (let x=0;x<edge;x++) {
      const u=(x-edge/2)/(edge/2);
      const v=(y-edge/2)/(edge/2);
      const mottling = .55 + .13*Math.sin(x*.31+y*.47) + .12*Math.cos(x*.57-y*.25) +
        .11*Math.sin(x*.73+y*.62)+.08*Math.cos(x*1.02+y*.74);
      const radial = Math.hypot(u,v)*(.95+.14*Math.sin(Math.atan2(v,u)*4));
      const pixel=(y*edge+x)*4;
      image.data[pixel]=150;
      image.data[pixel+1]=161;
      image.data[pixel+2]=167;
      image.data[pixel+3]=Math.max(0,1-radial)**1.3 * mottling * 252;
    }
  }
  ctx.putImageData(image,0,0);
  return sprite;
}

function paintHarborExhaust(ctx, projection, sprite, phase, day) {
  const unit = ctx.canvas.height / shoreSourceHeight;
  ctx.save();
  for (const [stack, chimney] of harborStacks.entries()) {
    const [originX,originY] = projection.toScene(chimney.x,chimney.y);
    for (let i=0;i<24;i++) {
      const age = (phase / (2*Math.PI) + i/24 + stack*.18) % 1;
      const radius = unit * (10 + chimney.size * age ** .77);
      const lift = age ** .64;
      const x = originX + (chimney.reach * age ** 1.35 + 15*age*Math.sin(phase*2 + age*9 + stack)) * unit;
      const y = originY - (chimney.rise * lift + 15*age*Math.cos(phase*2 + age*6)) * unit;
      ctx.globalAlpha = (day ? .92 : .84) * (1-age)**.94 * (.68+.32*Math.sin(i*8+phase)**2);
      ctx.drawImage(sprite,x-radius,y-radius*.69,radius*2,radius*1.38);
    }
  }
  ctx.restore();
}

export function mountHarbor(scene, contacts) {
  const context = scene.getContext('2d');
  const ground = document.createElement('canvas');
  const banks = document.createElement('canvas');
  const fog = document.createElement('canvas');
  const fogContext = fog.getContext('2d');
  const quadrants = [0, 2, 3, 1];
  const threshold = (x, y) => {
    const cell = bayer[(y & 3) * 4 + (x & 3)];
    const quadrant = quadrants[((y >> 2) & 1) * 2 + ((x >> 2) & 1)];
    return (cell * 4 + quadrant + .5) / 64;
  };
  const vessels = contacts.map(contact => ({...contact, sprite: document.createElement('canvas')}));
  const exhaust = makeExhaust();
  let realShores;
  let projection;
  let shores;
  let water;
  let haze;
  let horizon;
  let progress = 0;
  let day = true;
  let disposed = false;

  function placeShips() {
    const scale = scene.width * .105 / 152;
    for (const vessel of vessels) {
      const {sprite} = vessel;
      const anchorage = scene.height * vessel.row;
      const depth = depthAt(anchorage, horizon, scene.height);
      const width = scale * perspectiveScale(depth) * 104 * 300 / 226;
      sprite.width = Math.round(width);
      sprite.height = Math.round(width * .6);
      if (!sprite.width || !sprite.height) continue;
      drawSilverShip(sprite.getContext('2d', {willReadFrequently: true}), 'brig', threshold);
      vessel.y = anchorage - sprite.height * (148 / 180 - .5);
      vessel.light = nearLight(depth);
      const top = Math.max(horizon, Math.floor(anchorage - sprite.height * .82));
      const bottom = Math.min(scene.height - 1, Math.ceil(anchorage + 18 * scale + 3));
      const [left, right] = shores.map(shore =>
        shore.subarray(top, bottom + 1).reduce((reach, x) => Math.max(reach, x), 0));
      const clearance = sprite.width / 2 + 10;
      vessel.x = Math.max(left + clearance, Math.min(scene.width * vessel.column, scene.width - right - clearance));
    }
  }

  function paintGround(width, height, day) {
    const ctx = ground.getContext('2d');
    const frame = ctx.createImageData(width, height);
    const base = day ? [4, 11, 17] : [2, 7, 13];
    for (let y = 0; y < height; y++) {
      const depth = (y - horizon) / (height - horizon);
      const skyline = 12 * Math.exp(-((depth + .01) ** 2) / .009);
      for (let x = 0; x < width; x++) {
        const perspective = .28 + .72 * Math.sin(Math.PI * x / width);
        const localTone = (Math.sin(x*.137-y*.184) * Math.cos(x*.043 + y*.47) + .52*Math.sin(x*1.8+y*2.16)) * 2;
        const waterGrain = depth >= 0 ? Math.max(0,.25-threshold(x,y)) * (6 + 17*depth) : 0;
        const shade = localTone + waterGrain + skyline * perspective;
        const pixel = (y * width + x) * 4;
        frame.data[pixel] = base[0]+shade*.78;
        frame.data[pixel+1] = base[1]+shade;
        frame.data[pixel+2] = base[2]+shade*1.18;
        frame.data[pixel+3] = 255;
      }
    }
    ctx.putImageData(frame, 0, 0);
  }

  function paintSea(width, height, phase) {
    const [left, right] = shores;
    context.save();
    context.clip(water);
    const swell = Math.sin(phase);
    for (let row = 0; row < 16; row++) {
      const depth = ((row + .7) / 16) ** 1.52;
      const y = horizon + (height - horizon) * depth;
      const offset = Math.floor(y);
      const available = width - left[offset] - right[offset];
      const segment = available / (row < 7 ? 7 : 5);
      for (let patch = 0; patch < 8; patch++) {
        const begin = left[offset] + segment * (patch - .7 + .20 * Math.sin(row * 2.1 + patch));
        const end = begin + segment * (.41 + .25 * Math.sin(row + patch * 2.3) ** 2);
        const bend = (1.2 + depth * 8.5) * Math.sin(phase + row * 1.25 + patch * 2);
        const shift = (2 + depth * 4) * Math.sin(phase + row * .51);
        context.beginPath();
        context.moveTo(begin + shift, y + bend * .25 + swell);
        context.quadraticCurveTo((begin + end) / 2 + shift, y + bend, end + shift, y + bend * .38);
        const alpha = (.14 + depth * .26) * (.58 + .42 * Math.sin(row + patch * 1.4) ** 2);
        context.strokeStyle = `rgba(130,167,183,${alpha})`;
        context.lineWidth = .8 + depth * .83;
        context.setLineDash([1.8 + depth * 2.7, 2.6]);
        context.lineDashOffset = swell * 2;
        context.stroke();
      }
    }
    context.setLineDash([1.6, 3.4]);
    context.lineDashOffset = swell * 3;
    for (const [index, outline] of shores.entries()) {
      const direction = index === 0 ? 1 : -1;
      const xAt = y => (index === 0 ? outline[y] : width - outline[y]) + direction * (3.5 + 1.45 * Math.sin(y * .1 + phase));
      context.beginPath();
      const onset = Math.floor(horizon + (height - horizon) * .19);
      context.moveTo(xAt(onset), onset);
      for (let y = onset + 1; y < height; y++) context.lineTo(xAt(y), y);
      context.strokeStyle = '#91adb666';
      context.lineWidth = 1.1;
      context.stroke();
    }
    context.restore();
  }

  function paintFog(width, height, phase, day) {
    const [left, right] = shores;
    const data = haze.data;
    const fogWidth = fog.width;
    const fogHeight = fog.height;
    for (let x = 0; x < fogWidth; x++) {
      const horizontal = x / fogWidth;
      const screenX = horizontal * width;
      const drift = horizontal * Math.PI * 2 - phase;
      const roll = Math.sin(drift * 2) * .055 + Math.sin(drift * 3 + .4) * .023;
      for (let y = 0; y < fogHeight; y++) {
        const vertical = y / fogHeight;
        const row = Math.floor(vertical * height);
        const shoreDistance = Math.min(Math.abs(screenX - left[row]), Math.abs(width - screenX - right[row]));
        const coastal = 1 / (1 + (shoreDistance / (width * .082)) ** 2);
        const center = horizon / height + .045 + roll + coastal * .058;
        const band = Math.max(0, 1 - Math.abs(vertical - center) / .22) ** 2;
        const pools = Math.max(0, .49 - Math.abs(vertical - .63 + roll)) * coastal;
        const strands = .82 + .18 * Math.sin(drift*3 + vertical*14 + .6*Math.cos(y*.33));
        const density = (band * .44 + pools * .36) * strands;
        const index = (y * fogWidth + x) * 4;
        data[index] = day ? 118 : 97;
        data[index + 1] = day ? 144 : 122;
        data[index + 2] = day ? 151 : 137;
        data[index + 3] = density * (82 + 16 * threshold(x,y));
      }
    }
    fogContext.putImageData(haze, 0, 0);
    context.imageSmoothingEnabled = true;
    context.drawImage(fog, 0, 0, width, height);
  }

  function render(nextProgress) {
    progress = nextProgress;
    if (!water) return;
    const { width, height } = scene;
    const phase = progress * 2 * Math.PI;
    const drift = Math.sin(phase);
    context.drawImage(ground, 0, 0);
    paintSea(width, height, phase);
    for (const vessel of vessels) {
      const {sprite, x, y} = vessel;
      if (!sprite.width || !sprite.height) continue;
      context.globalAlpha = .57 + vessel.light * .43;
      context.drawImage(sprite, Math.round(x - sprite.width / 2 + drift * vessel.drift * 4),
        Math.round(y - sprite.height / 2 + drift * vessel.drift * 2));
    }
    context.globalAlpha = 1;
    context.drawImage(banks, 0, 0);
    if (realShores) paintHarborExhaust(context, projection, exhaust, phase, day);
    paintFog(width, height, phase, day);
  }

  function rebuild() {
    const width = scene.clientWidth;
    const height = scene.clientHeight;
    if (width < 32 || height < 20) return;
    scene.width = ground.width = banks.width = width;
    scene.height = ground.height = banks.height = height;
    fog.width = Math.ceil(width / 2);
    fog.height = Math.ceil(height / 2);
    haze = fogContext.createImageData(fog.width, fog.height);
    horizon = Math.round(height * .28);
    projection = shoreProjection(width,height,horizon);
    shores = projection.banks;
    const [left, right] = shores;
    water = new Path2D();
    water.moveTo(left[horizon], horizon);
    for (let row = horizon + 1; row < height; row++) water.lineTo(left[row], row);
    water.lineTo(left.at(-1), height);
    water.lineTo(width - right.at(-1), height);
    for (let row = height - 1; row >= horizon; row--) water.lineTo(width - right[row], row);
    water.closePath();
    placeShips();
    paintGround(width, height, day);
    const bankContext = banks.getContext('2d');
    if (realShores) {
      paintRealShore(bankContext, realShores, width, height, projection, day, threshold);
      drawHarborLantern(bankContext, projection, day);
    }
    render(progress);
  }

  Promise.all([yardArtwork, townArtwork].map(decodeHarborShore)).then(images => {
    if (disposed) return;
    realShores = images;
    scene.dataset.artwork = 'ready';
    rebuild();
  }).catch(() => {
    if (!disposed) scene.dataset.artwork = 'unavailable';
  });
  const resize = new ResizeObserver(rebuild);
  resize.observe(scene);
  rebuild();
  return {
    render,
    setLight(light) {
      if (light === day) return;
      day = light;
      rebuild();
    },
    dispose() {
      disposed = true;
      resize.disconnect();
    },
  };
}
