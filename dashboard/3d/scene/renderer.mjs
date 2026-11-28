import { createProgram, bindTextures } from "./gpu.mjs";
import { botanicalModel } from "./plants.mjs";
import { groundMaterials } from "./ground.mjs";
import { fieldGeometry } from "./geometry.mjs";
import { drawPlots } from "./plots.mjs";
import { drawThreads } from "./timeline.mjs";
export function mountLandscape(controller, first, sources) {
  const { root, main, worldRect, camera, screen, reduced } = controller;
  let windEnabled = !reduced.matches;
  const canvas = document.createElement("canvas");
  canvas.id = "farm-scene";
  canvas.setAttribute("aria-hidden", "true");
  root.insertBefore(canvas, main);
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  if (!gl) return;
  const program = createProgram(gl);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [key, n, at] of [
    ["p", 3, 0],
    ["color", 3, 3],
    ["tex", 2, 6],
    ["flex", 1, 8],
  ]) {
    const loc = gl.getAttribLocation(program, key);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 36, at * 4);
  }
  const loc = (k) => gl.getUniformLocation(program, k),
    view = loc("view"),
    lift = loc("lift"),
    time = loc("time");
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE);
  for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
    gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
  const ground = document.createElement("canvas"),
    g = ground.getContext("2d", { alpha: false }),
    images = {};

  const wind = first(".field-settings input[type=checkbox]");
  let verts = [],
    seed = 42,
    size = [0, 0],
    treeStart = 0,
    count = 0,
    dirty = true,
    frame = 0,
    timer = 0,
    ready = false,
    visible = true;
  function rand() {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  }
  function point(x, y, z, col, flex = 0) {
    verts.push(x, y, z, ...col, -1, 0, flex);
  }
  function tri(a, b, c, col) {
    point(...a, col);
    point(...b, col);
    point(...c, col);
  }

  let worldBox,
    scaleY = 1;
  function bounds(el) {
    return worldRect(el);
  }
  const { shade, seedbed, track } = groundMaterials(g, images, rand);
  const instancing = gl.getExtension("ANGLE_instanced_arrays");
  const spot = gl.getAttribLocation(program, "spot"),
    plantMode = loc("plant");
  const instanceBuffer = gl.createBuffer(),
    plantBuffer = gl.createBuffer();
  let grassLocations = [],
    cutLocations = [],
    registry = [],
    plantRanges = [];
  const standing = botanicalModel(false),
    straw = botanicalModel(true);
  const model = new Float32Array(standing.length + straw.length);
  model.set(standing);
  model.set(straw, standing.length);
  gl.bindBuffer(gl.ARRAY_BUFFER, plantBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, model, gl.STATIC_DRAW);
  function attributes(buf) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (const [key, n, at] of [
      ["p", 3, 0],
      ["color", 3, 3],
      ["tex", 2, 6],
      ["flex", 1, 8],
    ]) {
      const attr = gl.getAttribLocation(program, key);
      gl.enableVertexAttribArray(attr);
      gl.vertexAttribPointer(attr, n, gl.FLOAT, false, 36, at * 4);
    }
  }
  function storePlants() {
    registry = grassLocations.concat(cutLocations);
    plantRanges = [
      [0, standing.length / 9, 0, grassLocations.length / 4],
      [
        standing.length / 9,
        straw.length / 9,
        grassLocations.length,
        cutLocations.length / 4,
      ],
    ];
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(registry), gl.STATIC_DRAW);
  }
  function drawPlants(shadows) {
    attributes(plantBuffer);
    gl.uniform1f(plantMode, 1);
    gl.uniform1f(loc("shadow"), shadows ? 1 : 0);
    for (const [firstVertex, n, offset, copies] of plantRanges) {
      if (!copies) continue;
      if (instancing) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        gl.enableVertexAttribArray(spot);
        gl.vertexAttribPointer(spot, 4, gl.FLOAT, false, 16, offset * 4);
        instancing.vertexAttribDivisorANGLE(spot, 1);
        instancing.drawArraysInstancedANGLE(
          gl.TRIANGLES,
          firstVertex,
          n,
          copies,
        );
        instancing.vertexAttribDivisorANGLE(spot, 0);
        gl.disableVertexAttribArray(spot);
      } else {
        gl.disableVertexAttribArray(spot);
        for (let j = 0; j < copies; j += 3) {
          const i = offset + j * 4;
          gl.vertexAttrib4f(
            spot,
            registry[i],
            registry[i + 1],
            registry[i + 2],
            registry[i + 3],
          );
          gl.drawArrays(gl.TRIANGLES, firstVertex, n);
        }
      }
    }
    gl.uniform1f(plantMode, 0);
    gl.uniform1f(loc("shadow"), 0);
    attributes(buffer);
  }
  let fogStart = 0;
  const fogVertices = [];
  const { grains, furrows, timber, canopyShadow, fogBank, strip } =
    fieldGeometry({
      verts,
      grassLocations,
      cutLocations,
      fogVertices,
      g,
      rand,
      shade,
      seedbed,
    });
  function rebuild() {
    dirty = false;
    seed = 419;
    worldBox = main.getBoundingClientRect();
    const w = main.clientWidth,
      h = main.clientHeight;
    scaleY = worldBox.height / h;
    size = [w, h];
    if (!w || !h) return;
    const resolution = Math.min(
      1.5,
      devicePixelRatio,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) / Math.max(w, h),
    );
    ground.width = Math.ceil(w * resolution);
    ground.height = Math.ceil(h * resolution);
    g.scale(resolution, resolution);
    const photo = images.meadow;
    const srcW = Math.min(photo.width, (photo.height * w) / h);
    gl.uniform2f(
      loc("grassCrop"),
      (1 - srcW / photo.width) / 2,
      srcW / photo.width,
    );
    g.drawImage(
      photo,
      (photo.width - srcW) / 2,
      0,
      srcW,
      photo.height,
      0,
      0,
      w,
      h,
    );
    for (let i = 0; i < 110; i++) {
      const x = rand() * w,
        z = rand() * h,
        r = 25 + rand() * 170;
      shade(
        x,
        z,
        r,
        r * 0.76,
        i % 3 ? "rgba(64,67,19,.12)" : "rgba(219,188,57,.19)",
      );
    }
    const light = g.createLinearGradient(0, 0, w, h);
    light.addColorStop(0, "#a7952420");
    light.addColorStop(0.53, "#20290132");
    light.addColorStop(1, "#5b571c32");
    g.fillStyle = light;
    g.fillRect(0, 0, w, h);
    const left = bounds(first("#summary-panel")),
      right = bounds(first(".agent-work-trend")),
      timeline = bounds(first("#timeline-panel"));
    const fork = (left.x + left.w + right.x) / 2,
      cross = timeline.y - 15;
    const sideBySide = right.x > left.x + left.w * 0.95;
    if (sideBySide)
      track(fork - 5, -10, fork, cross, Math.max(7, Math.min(18, w * 0.0105)));
    else track(-10, right.y - 9, w + 10, right.y - 9, 6);
    track(-10, cross, w + 10, cross - 2, Math.max(8, Math.min(17, w * 0.009)));
    verts.length = 0;
    fogVertices.length = 0;
    grassLocations.length = 0;
    cutLocations.length = 0;
    const { chosen, plots } = controller;
    drawPlots({
      bounds,
      worldRect,
      chosen,
      plots,
      g,
      fogBank,
      seedbed,
      furrows,
      grains,
      tri,
      first,
      worldBox,
      camera,
      scaleY,
    });
    drawThreads({ bounds, first, g, rand, strip });
    const trees = sideBySide
      ? [
          [
            left.x + left.w * 0.34,
            Math.max(37, left.y - 14),
            Math.min(58, Math.max(35, w * 0.038)),
          ],
          [
            fork + 1,
            Math.max(40, right.y - 8),
            Math.min(54, Math.max(32, w * 0.036)),
          ],
          [-8, cross + 23, 32],
          [w + 13, cross - 14, 33],
        ]
      : [
          [w * 0.48, 19, 18],
          [w - 4, right.y - 10, 18],
          [-8, cross + 8, 14],
        ];
    treeStart = 6 + verts.length / 9;
    for (const [x, z, r] of trees) {
      canopyShadow(x, z, r);
      timber(x, z, r);
    }
    for (const [x, z, r] of trees) {
      for (let i = 0; i < 85; i++) {
        const a = rand() * 6.28,
          d = (0.65 + rand() * 1.4) * r,
          px = x + Math.cos(a) * d,
          pz = z + Math.sin(a) * d * 0.46;
        if (px < 1 || pz < 0) continue;
        g.fillStyle = i % 4 ? "#a9a762" : "#f3e5bb";
        g.beginPath();
        g.ellipse(
          px,
          pz,
          rand() * 1.35 + 0.35,
          rand() * 0.86 + 0.4,
          0,
          0,
          6.283,
        );
        g.fill();
      }
    }
    if (chosen?.sub) {
      const p = chosen.sub;
      g.strokeStyle = "#e9d58e";
      g.lineWidth = 1.2;
      g.strokeRect(
        p.x + 0.6,
        p.y + 0.6,
        Math.max(0, p.w - 1.2),
        Math.max(0, p.h - 1.2),
      );
    }
    const plane = [];
    for (const [x, z, u, v] of [
      [0, 0, 0, 0],
      [w, 0, 1, 0],
      [w, h, 1, 1],
      [0, 0, 0, 0],
      [w, h, 1, 1],
      [0, h, 0, 1],
    ])
      plane.push(x, -0.2, z, 1, 1, 1, u, v, 0);
    fogStart = 6 + verts.length / 9;
    const all = new Float32Array(
      plane.length + verts.length + fogVertices.length,
    );
    all.set(plane);
    all.set(verts, plane.length);
    all.set(fogVertices, plane.length + verts.length);
    count = all.length / 9;
    const picker = document.querySelectorAll(
      ".field-settings-controls input[type=color]",
    )[2];
    const tint = picker?.value || "#a5b6b7";
    gl.uniform3f(
      loc("mistTint"),
      ...tint
        .slice(1)
        .match(/../g)
        .map((c) => parseInt(c, 16) / 255),
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, all, gl.STATIC_DRAW);
    storePlants();
    attributes(buffer);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, ground);
  }
  const schedule = () => {
    if (ready && visible && !frame && !document.hidden)
      frame = requestAnimationFrame(draw);
  };
  const redraw = () => {
    dirty = true;
    schedule();
  };
  function draw(ms) {
    frame = 0;
    if (dirty) rebuild();
    const [w, h] = size;
    if (!w || !h) return;
    const { w: vw, h: vh } = screen(),
      dpr = Math.min(devicePixelRatio, 1.65);
    if (
      canvas.width !== Math.round(vw * dpr) ||
      canvas.height !== Math.round(vh * dpr)
    ) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.uniform2f(view, w, h);
    gl.uniform2f(loc("screenSize"), vw, vh);
    gl.uniform4f(loc("cam"), camera.x, camera.y, camera.s, camera.p);
    gl.uniform1f(
      lift,
      Math.sqrt(Math.max(0, 1 - camera.p * camera.p)) / camera.p,
    );
    gl.uniform1f(time, windEnabled ? ms / 1000 : 0);
    gl.uniform1f(loc("shadow"), 0);
    gl.uniform1f(plantMode, 0);
    attributes(buffer);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.DEPTH_TEST);
    drawPlants(true);
    gl.uniform1f(loc("shadow"), 1);
    gl.drawArrays(gl.TRIANGLES, treeStart, fogStart - treeStart);
    gl.uniform1f(loc("shadow"), 0);
    gl.enable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 6, fogStart - 6);
    drawPlants(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, fogStart, count - fogStart);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    clearTimeout(timer);
    if (windEnabled && visible && !document.hidden)
      timer = setTimeout(schedule, 50);
  }
  controller.onRender(schedule, redraw);
  new ResizeObserver(redraw).observe(main);
  new MutationObserver(redraw).observe(first(".board"), {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeFilter: [
      "class",
      "style",
      "hidden",
      "aria-expanded",
      "aria-pressed",
    ],
  });
  first(".field-settings")?.addEventListener("input", redraw);
  first(".timeline-viewport").addEventListener("scroll", redraw, {
    passive: true,
  });
  wind?.addEventListener("change", redraw);
  document.addEventListener("visibilitychange", schedule);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  }).observe(main);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    ready = false;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    document.body.classList.remove("farm-ready");
  });
  canvas.addEventListener("webglcontextrestored", () => location.reload());
  if (first(".trend-plot svg"))
    first(".trend-plot svg").setAttribute("preserveAspectRatio", "none");
  reduced.addEventListener("change", () => {
    windEnabled = !reduced.matches;
    schedule();
  });
  Promise.all(
    Object.entries(sources).map(async ([name, url]) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      images[name] = img;
    }),
  ).then(() => {
    bindTextures(gl, loc, images, texture);
    ready = true;
    document.body.classList.add("farm-ready");
    redraw();
    document.fonts.ready.then(redraw);
  });
}
