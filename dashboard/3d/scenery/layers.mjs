export const rakingLight = `
float fieldLightNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f*f*(3.-2.*f);
  vec4 index = dot(cell, vec2(1., 47.)) + vec4(0., 1., 47., 48.);
  vec4 corners = fract(sin(index) * 15317.13);
  return mix(mix(corners.x, corners.y, f.x), mix(corners.z, corners.w, f.x), f.y);
}
vec3 rakingLight(vec2 world) {
  vec2 lightSpace = mat2(.91, -.41, .41, .91) * world;
  float cloud = fieldLightNoise(lightSpace / vec2(128., 79.));
  float branchShade = fieldLightNoise(lightSpace / vec2(68., 24.) + cloud);
  float sun = smoothstep(.16, .86, .74 * cloud + .26 * branchShade);
  return mix(vec3(.76, .77, .78), vec3(1.21, 1.08, .88), sun);
}`;

export const plowedSoil = `
vec3 plowedSoil(vec2 world, float around, sampler2D tilth) {
  vec2 sampleAt = mat2(.958, .287, -.287, .958) * world;
  vec3 loam = texture2D(tilth, sampleAt / vec2(123., 103.)).rgb;
  vec3 crumbs = texture2D(tilth, sampleAt.yx / vec2(41., 54.) + .37).rgb;
  float clod = dot(loam, vec3(.33, .53, .14));
  float ripple = .034 * sin(world.y * .075 + world.x * .12);
  float profile = around + ripple + (clod - .22) * .43;
  float shoulder = .5 + .5 * cos(6.283 * (profile - .31));
  float crest = smoothstep(.67, 1., shoulder) * smoothstep(.16, .52, clod);
  vec3 diffuse = mix(loam, crumbs, .19) * mix(.79, 1.26, shoulder);
  return (diffuse + vec3(.040, .028, .020) + crest * vec3(.13, .088, .035)) * rakingLight(world);
}`;

export function paintShoulder(g, x1, z1, x2, z2, width) {
  const length = Math.hypot(x2 - x1, z2 - z1);
  if (length < 1) return;
  const dx = (x2 - x1) / length;
  const dz = (z2 - z1) / length;
  let seed = (Math.round(x1 * 37 + z1 * 61) >>> 0) || 23;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  g.save();
  for (const side of [-1, 1]) {
    for (let at = random() * 5; at < length; at += 1.2 + random() * 6) {
      const kink = Math.sin(at * .021) * 1.2 + Math.sin(at * .006) * 2.1;
      const offset = kink + side * (width / 2 + random() * 4);
      const x = x1 + dx * at - dz * offset;
      const z = z1 + dz * at + dx * offset;
      const sun = Math.sin(x * .06 + z * .043) + random() * .9;
      const h = 1 + random() * 3.6;
      g.strokeStyle = sun > .65 ? "#b79a566e" : "#52532a9e";
      g.lineWidth = .55;
      g.beginPath();
      g.moveTo(x - .2, z);
      g.quadraticCurveTo(x - .8, z - h * .6, x - 1.9, z - h);
      g.moveTo(x, z);
      g.quadraticCurveTo(x + .1, z - h, x + 1, z - h * 1.2);
      g.moveTo(x + .5, z);
      g.lineTo(x + 2.4, z - h * .65);
      g.stroke();
      if (random() > .9) {
        g.fillStyle = "#d6bc828c";
        g.fillRect(x - 2, z - h, 1.1, .7);
      }
    }
  }
  g.restore();
}

const layerStyle = {
  position: "absolute",
  pointerEvents: "none",
  userSelect: "none",
  transformOrigin: "0 0",
};

function layer(parent, className, styles = {}) {
  const el = document.createElement("div");
  el.className = className;
  Object.assign(el.style, layerStyle, styles);
  parent.append(el);
  return el;
}

function imageLayer(parent, name, src) {
  const el = document.createElement("img");
  el.className = name;
  el.alt = "";
  el.draggable = false;
  el.src = src;
  Object.assign(el.style, layerStyle, { left: "0", top: "0", maxWidth: "none" });
  parent.append(el);
  return el;
}

const nearWoods = [
  [-.31, .36, .74, false],
  [-.012, .29, .98, true],
  [.235, .22, .69, false],
  [.409, .34, 1.0, false],
  [.694, .27, .82, true],
  [.923, .32, .92, false],
  [1.18, .27, .73, true],
];

export function mountScenery(root, sources) {
  const container = layer(root, "farm-scenery", {
    inset: "0", overflow: "hidden", zIndex: "1",
  });
  container.setAttribute("aria-hidden", "true");
  container.inert = true;
  const hills = layer(container, "farm-distance", {
    left: "0", top: "0", right: "0", backgroundColor: "#d6a978",
    backgroundImage: 'url("' + sources.horizon + '")',
    backgroundRepeat: "no-repeat", filter: "saturate(.72)",
    maskImage: "linear-gradient(to bottom, black 68%, transparent)",
  });
  const hedge = layer(container, "farm-woodland", {
    left: "0", top: "0",
    maskImage: "linear-gradient(to bottom, black 66%, transparent 100%)",
  });
  for (const [x, width, height, mirror] of nearWoods) {
    const trees = imageLayer(hedge, "farm-wood", sources.hedgerow);
    Object.assign(trees.style, {
      top: "auto", bottom: "0", left: x * 100 + "%",
      height: height * 100 + "%", width: width * 100 + "%",
      transform: mirror ? "scaleX(-1)" : "", transformOrigin: "center",
    });
  }
  const oak = imageLayer(container, "farm-framing-oak", sources.framingOak);
  const verge = imageLayer(container, "farm-verge", sources.verge);
  let board, pose, w, h, base, homeX, homeY, rim, hedgeHeight;
  const colors = matchMedia("(forced-colors: active)");
  function visibility() {
    container.hidden = colors.matches;
  }
  colors.addEventListener("change", visibility);
  visibility();
  function layout(next) {
    board = next;
    w = root.clientWidth;
    h = root.clientHeight;
    base = Math.min(w / board.width, h / (board.height * .93), 1);
    homeX = (w - board.width * base) / 2;
    homeY = (h - board.height * base * .93) / 2;
    rim = homeY + (board.summary.y - 3) * base * .93;
    hedgeHeight = Math.max(22, board.summary.y * base * .47);
    hedge.style.width = w + "px";
    hedge.style.height = hedgeHeight + "px";
    oak.style.width = w * .5 + "px";
    oak.style.height = h * 1.065 + "px";
    verge.style.width = w + "px";
    verge.style.height = Math.max(36, Math.min(110, h * .105)) + "px";
    if (pose) view(pose);
  }
  function view(next) {
    pose = next;
    if (!board || !base) return;
    const zoom = pose.s / base;
    const dx = pose.x - homeX;
    const dy = pose.y - homeY;
    const projectedRim = pose.y + (board.summary.y - 3) * pose.s * pose.p;
    const nearScale = zoom ** .45;
    const relativeRim = projectedRim - rim;
    const dive = Math.max(0, zoom - 1);
    const ridgeBottom = Math.max(0, Math.min(projectedRim, rim + relativeRim * .52 - h * .42 * dive));
    hills.style.height = ridgeBottom + "px";
    const ridgeWidth = w * Math.max(1.4, 1.4 * zoom ** .21);
    const ridgeHeight = Math.max(ridgeBottom * 1.4, ridgeWidth * .17);
    const skyX = Math.min(0, Math.max(w - ridgeWidth, (w - ridgeWidth) * .48 + dx * .12));
    const skyY = Math.min(0, ridgeBottom * .22 - ridgeHeight * .19);
    hills.style.backgroundSize = ridgeWidth + "px " + ridgeHeight + "px";
    hills.style.backgroundPosition = skyX + "px " + skyY + "px";
    const woodsBottom = Math.min(projectedRim, rim + relativeRim * .67 - h * .50 * dive);
    hedge.style.transform = "translate(" + dx * .29 + "px," +
      (woodsBottom - hedgeHeight * nearScale) + "px) scale(" + nearScale + ")";
    const foregroundScale = zoom ** .67;
    const oakX = -w * .009 + dx * 1.2 - w * .72 * dive;
    const oakY = -h * .038 + Math.min(0, dy * 1.2 - h * 1.02 * dive);
    oak.style.transform = "translate(" + oakX + "px," + oakY + "px) scale(" + foregroundScale + ")";
    const vergeHeight = Math.max(36, Math.min(110, h * .105));
    const vergeY = h - vergeHeight * .62 + dy * 1.12 + h * (zoom - 1);
    verge.style.transform = "translate(" + dx * 1.1 + "px," + vergeY + "px) scale(" + foregroundScale + ")";
  }
  return {layout, view};
}
