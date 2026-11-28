import { createProgram, bindTextures } from "./gpu.mjs";
import { groundMaterials } from "./ground.mjs";
import { fieldGeometry } from "./geometry.mjs";
import { botanicalModel } from "./plants.mjs";
import { plotMesh, plotSpecs } from "./plots.mjs";
import { paintRows } from "./timeline.mjs";

export const idleMetrics = {
  frames: 0,
  drawCalls: 0,
  lastDrawCalls: 0,
  uploadedBytes: 0,
  meshUploads: 0,
  groundUploads: 0,
  visibleInstances: 0,
  peakInstances: 0,
  visibleParcels: 0,
  culledParcels: 0,
  frameMs: 0,
};

export function mountLandscape(root, sources, shoulder = () => {}) {
  const canvas = document.createElement("canvas");
  canvas.id = "farm-scene";
  canvas.setAttribute("aria-hidden", "true");
  root.prepend(canvas);
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: true,
    powerPreference: "low-power",
  });
  const counters = { ...idleMetrics };
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = matchMedia("(forced-colors: active)");
  let board,
    pose = { x: 0, y: 0, s: 1, p: 0.93 },
    frame = 0,
    timer = 0,
    suspended = false,
    ready = false,
    visible = true;
  let draw,
    sync,
    lost = false;
  const stats = () => ({
    ...counters,
    webgl: !!gl && ready,
    hidden: document.hidden,
    reducedMotion: motion.matches,
  });
  function schedule() {
    if (
      !gl ||
      !ready ||
      suspended ||
      !visible ||
      frame ||
      document.hidden ||
      contrast.matches
    )
      return;
    frame = requestAnimationFrame((now) => {
      frame = 0;
      draw(now);
    });
  }
  if (!gl) return { stats, layout() {}, view() {}, pause() {} };
  function initialize(images) {
    const program = createProgram(gl);
    const locations = new Map();
    function loc(key) {
      if (!locations.has(key))
        locations.set(key, gl.getUniformLocation(program, key));
      return locations.get(key);
    }
    const attrs = ["p", "color", "tex", "flex", "spot"].map((key) =>
      gl.getAttribLocation(program, key),
    );
    const instancing = gl.getExtension("ANGLE_instanced_arrays");
    const cache = new Map();
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE);
    for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, param, gl.LINEAR);
    bindTextures(gl, loc, images, texture);
    gl.uniform3f(loc("mistTint"), 0.65, 0.71, 0.72);
    function upload(data) {
      if (!data.length) return null;
      const buf = gl.createBuffer(),
        array = new Float32Array(data);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      counters.uploadedBytes += array.byteLength;
      return { buf, count: data.length / 9 };
    }
    const botanical = instancing ? upload(botanicalModel(false)) : null;
    const plane = upload(
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 1],
        [1, 0],
        [1, 1],
      ].flatMap(([u, v]) => [u, -0.2, v, 1, 1, 1, u, v, 0]),
    );
    function attributes(buf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [i, count, offset] of [
        [0, 3, 0],
        [1, 3, 3],
        [2, 2, 6],
        [3, 1, 8],
      ]) {
        gl.enableVertexAttribArray(attrs[i]);
        gl.vertexAttribPointer(
          attrs[i],
          count,
          gl.FLOAT,
          false,
          36,
          offset * 4,
        );
      }
    }
    function triangles(resource) {
      if (!resource) return;
      attributes(resource.buf);
      gl.drawArrays(gl.TRIANGLES, 0, resource.count);
      counters.lastDrawCalls++;
    }
    let backdropKey = "",
      trees = null;
    function backdrop(b) {
      const key = [
        b.width,
        b.height,
        b.summary.y,
        b.trendZone.y,
        b.timeline.y,
        b.axis.y,
        b.threads.length,
      ].join("/");
      if (key === backdropKey) return;
      backdropKey = key;
      let seed = 428;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const ground = document.createElement("canvas");
      const scale = Math.min(
        1.5,
        devicePixelRatio,
        gl.getParameter(gl.MAX_TEXTURE_SIZE) / Math.max(b.width, b.height),
      );
      ground.width = Math.ceil(b.width * scale);
      ground.height = Math.ceil(b.height * scale);
      const g = ground.getContext("2d", { alpha: false });
      g.scale(scale, scale);
      const { track, shade } = groundMaterials(g, images, rand);
      const photo = images.meadow,
        srcW = Math.min(photo.width, (photo.height * b.width) / b.height);
      gl.uniform2f(
        loc("grassCrop"),
        (1 - srcW / photo.width) / 2,
        srcW / photo.width,
      );
      g.save();
      g.filter = "blur(1.6px)";
      g.drawImage(
        photo,
        (photo.width - srcW) / 2,
        0,
        srcW,
        photo.height,
        0,
        0,
        b.width,
        b.height,
      );
      g.restore();
      const veil = g.createLinearGradient(0, 0, b.width, b.height);
      veil.addColorStop(0, "#b8964438");
      veil.addColorStop(0.44, "#3d311e4a");
      veil.addColorStop(1, "#48442d36");
      g.fillStyle = veil;
      g.fillRect(0, 0, b.width, b.height);
      const cross = b.timeline.y - 19,
        width = Math.max(7, Math.min(15, b.width * 0.009));
      {
        const fork = (b.summary.x + b.summary.w + b.trendZone.x) / 2;
        const crest = b.summary.y * .72;
        track(fork, crest, fork + 2, cross, width);
        track(fork, crest, fork - 16, crest * .6, width * .72);
        track(fork - 20, crest * .45, fork + 12, 2, width * .42);
        shoulder(g, fork, 0, fork + 2, cross, width);
      }
      track(-5, cross, b.width + 5, cross - 2, width);
      shoulder(g, -5, cross, b.width + 5, cross - 2, width);
      paintRows(g, b);
      const verts = [];
      const { timber, canopyShadow, cottage, verge } = fieldGeometry({ g, verts, shade });
      const yard = b.trendZone.x + b.trendZone.w;
      cottage(yard + 31, cross - 36, 48, 21, 12, .23);
      cottage(yard + 84, cross - 19, 24, 15, 10, -.29);
      for (const [dx, dz, radius] of [[26,-79,13],[53,-86,15],[80,-69,12],[106,-57,13]]) {
        canopyShadow(yard+dx,cross+dz,radius);
        timber(yard+dx,cross+dz,radius);
      }
      for (const [across, depth, radius] of [[.952,.987,39],[.9,1.01,22],[.185,1.007,15]]) {
        verge(b.width*across,b.height*depth,radius,rand);
      }
      if (trees) gl.deleteBuffer(trees.buf);
      trees = upload(verts);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, ground);
      counters.groundUploads++;
      counters.uploadedBytes += ground.width * ground.height * 3;
    }
    function discard(mesh) {
      for (const part of Object.values(mesh))
        if (part?.buf) gl.deleteBuffer(part.buf);
    }
    let lastBoard;
    sync = () => {
      if (!board || lastBoard === board) return;
      lastBoard = board;
      backdrop(board);
      const retained = new Set();
      for (const spec of plotSpecs(board)) {
        const { slot, material, r, small, points } = spec;
        retained.add(slot);
        const signature = JSON.stringify([material, r.w, r.h, small, points]);
        const prior = cache.get(slot);
        if (prior?.signature === signature) {
          prior.r = r;
          continue;
        }
        if (prior) discard(prior.mesh);
        const data = plotMesh(spec, !!instancing);
        const mesh = Object.fromEntries(
          Object.entries(data).map(([key, vertices]) => [
            key,
            upload(vertices),
          ]),
        );
        if (mesh.plants) mesh.plants.count = data.plants.length / 4;
        cache.set(slot, { signature, r, mesh });
        counters.meshUploads++;
      }
      for (const [slot, rec] of cache)
        if (!retained.has(slot)) {
          discard(rec.mesh);
          cache.delete(slot);
        }
    };
    function plants(items, shadow) {
      if (!instancing || !botanical || !items.length) return;
      const spot = attrs[4];
      gl.uniform1f(loc("plant"), 1);
      gl.uniform1f(loc("shadow"), shadow);
      attributes(botanical.buf);
      gl.enableVertexAttribArray(spot);
      instancing.vertexAttribDivisorANGLE(spot, 1);
      for (const { r, mesh } of items) {
        gl.uniform2f(loc("origin"), r.x, r.y);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.plants.buf);
        gl.vertexAttribPointer(spot, 4, gl.FLOAT, false, 16, 0);
        instancing.drawArraysInstancedANGLE(
          gl.TRIANGLES,
          0,
          botanical.count,
          mesh.plants.count,
        );
        counters.lastDrawCalls++;
      }
      instancing.vertexAttribDivisorANGLE(spot, 0);
      gl.disableVertexAttribArray(spot);
      gl.uniform1f(loc("plant"), 0);
      gl.uniform1f(loc("shadow"), 0);
    }
    draw = (now) => {
      if (!board || lost) return;
      const start = performance.now();
      sync();
      const vw = root.clientWidth,
        vh = root.clientHeight,
        dpr = Math.min(1.65, devicePixelRatio);
      if (
        canvas.width !== Math.round(vw * dpr) ||
        canvas.height !== Math.round(vh * dpr)
      ) {
        canvas.width = Math.round(vw * dpr);
        canvas.height = Math.round(vh * dpr);
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      counters.lastDrawCalls = 0;
      const lift = Math.sqrt(1 - pose.p * pose.p) / pose.p;
      gl.clearColor(0.21, 0.25, 0.12, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform2f(loc("view"), board.width, board.height);
      gl.uniform2f(loc("screenSize"), vw, vh);
      gl.uniform4fv(loc("lens"), pose.lens ?? [1,1,0,0]);
      gl.uniform4f(loc("cam"), pose.x, pose.y, pose.s, pose.p);
      gl.uniform1f(loc("lift"), lift);
      gl.uniform1f(loc("time"), motion.matches ? 0 : now / 1000);
      gl.uniform2f(loc("origin"), 0, 0);
      gl.uniform1f(loc("cover"), 0);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      triangles(plane);
      const inView = [...cache.values()].filter(
        ({ r }) =>
          pose.x + (r.x + r.w + 9) * pose.s > 0 &&
          pose.x + (r.x - 9) * pose.s < vw &&
          pose.y + (r.y + r.h + 9) * pose.s * pose.p > 0 &&
          pose.y + (r.y - 34 * lift) * pose.s * pose.p < vh,
      );
      for (const { r, mesh } of inView) {
        gl.uniform2f(loc("origin"), r.x, r.y);
        gl.uniform1f(loc("cover"), 1);
        triangles(mesh.surface);
        gl.uniform1f(loc("cover"), 2);
        triangles(mesh.canopy);
        gl.uniform1f(loc("cover"), 0);
        triangles(mesh.relief);
      }
      const planted = inView.filter(
        ({ mesh }) => mesh.plants && pose.s * 0.93 > 0.31,
      );
      counters.visibleInstances = planted.reduce(
        (n, { mesh }) => n + mesh.plants.count,
        0,
      );
      counters.peakInstances = Math.max(
        counters.peakInstances,
        counters.visibleInstances,
      );
      counters.visibleParcels = inView.length;
      counters.culledParcels = cache.size - inView.length;
      gl.disable(gl.DEPTH_TEST);
      plants(planted, 1);
      gl.uniform2f(loc("origin"), 0, 0);
      gl.uniform1f(loc("shadow"), 1);
      triangles(trees);
      gl.uniform1f(loc("shadow"), 0);
      gl.enable(gl.DEPTH_TEST);
      triangles(trees);
      plants(planted, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const { r, mesh } of inView)
        if (mesh.fog) {
          gl.uniform2f(loc("origin"), r.x, r.y);
          triangles(mesh.fog);
        }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      counters.frames++;
      counters.drawCalls += counters.lastDrawCalls;
      counters.frameMs = performance.now() - start;
      document.body.classList.add("farm-ready");
      clearTimeout(timer);
      if (!motion.matches && !document.hidden && visible)
        timer = setTimeout(schedule, 50);
    };
    ready = true;
    schedule();
  }
  function wake() {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = 0;
    schedule();
  }
  motion.addEventListener("change", wake);
  contrast.addEventListener("change", wake);
  document.addEventListener("visibilitychange", wake);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    wake();
  }).observe(root);
  let images;
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
    ready = false;
    wake();
    document.body.classList.remove("farm-ready");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = false;
    if (images) initialize(images);
  });
  Promise.all(
    ["tilth", "grain", "oak", "meadow", "road"].map(async (name) => {
      const img = new Image();
      img.src = sources[name];
      await img.decode();
      return [name, img];
    }),
  ).then((entries) => {
    images = Object.fromEntries(entries);
    if (!lost) initialize(images);
  });
  return {
    stats,
    pause(value) {
      suspended = value;
      wake();
    },
    layout(next) {
      if (board === next) return;
      board = next;
      schedule();
    },
    view(next) {
      pose = next;
      schedule();
    },
  };
}
