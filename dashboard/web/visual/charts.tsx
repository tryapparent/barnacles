import { useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button } from "../controls";

type Category = {
  kind: number;
  name: string;
  style: string;
  duration: string;
  share: string;
  expanded: boolean;
  select: () => void;
};

type Operation = {
  key: string;
  name: string;
  metric?: string;
  active?: boolean;
  select: () => void;
};

type Overview = {
  total: string;
  note: string;
  categories: Category[];
  breakdown?: string;
  operations: Operation[];
  emptyOperations: boolean;
  close: () => void;
  clearOperation?: () => void;
};

let overview: Overview | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function renderSummary(model: Overview) {
  flushSync(() => {
    overview = model;
    listeners.forEach(listener => listener());
  });
}

export function Summary({ fieldTexture }: { fieldTexture?: string }) {
  const model = useSyncExternalStore(subscribe, () => overview);
  return <section className="summary-panel" id="summary-panel" aria-labelledby="summary-heading">
    <div className="summary-top">
      <h2 id="summary-heading">Where time went</h2>
      <p id="summary-total">{model?.total}</p>
    </div>
    <p id="summary-note" className="summary-note">{model?.note}</p>
    <div className="summary-tiles">
    <div id="tiles" className="treemap">
      {model?.categories.map(category => <Button type="button" key={category.kind}
        className={`category-tile ${category.style}`} data-kind={category.kind}
        aria-expanded={category.expanded} aria-controls="operation-panel" onClick={category.select}>
        <span className="category-name">{category.name}</span>
        <span className="category-metric">{category.duration}<span className="category-share">{category.share}</span></span>
        <span className="category-icon" aria-hidden="true">{category.expanded ? "−" : "+"}</span>
      </Button>)}
    </div>
    {fieldTexture && <FieldSurface texture={fieldTexture} />}
    </div>
    <section id="operation-panel" hidden={!model?.breakdown} aria-labelledby="operation-heading"
      onKeyDown={event => {
        if (event.key === "Escape" && model?.clearOperation) {
          event.preventDefault();
          model.clearOperation();
        }
      }}>
      <div className="operation-heading">
        <h3 id="operation-heading">{model?.breakdown}</h3>
        <Button type="button" id="collapse" aria-label="Close breakdown" onClick={model?.close}><span aria-hidden="true">×</span></Button>
      </div>
      <div id="operation-tiles" role="group" aria-label="Operations">
        {model?.operations.map(operation => <Button type="button" key={operation.key}
          className="operation-tile" data-operation={operation.key} aria-pressed={operation.active} onClick={operation.select}>
          {operation.metric ? <>
            <span className="operation-name">{operation.name}<span className="selected-indicator" aria-hidden="true">✓</span></span>
            <span className="operation-metric">{operation.metric}</span>
          </> : operation.name}
        </Button>)}
      </div>
      <p id="operation-empty" className="summary-note" hidden={!model?.emptyOperations}>No operations in this range. Try zooming out.</p>
    </section>
  </section>;
}

const fieldPalettes = [
  { name: "Soil", color: "#543b2a", kind: "workflow" },
  { name: "Crops", color: "#91ad5f", kind: "agent" },
  { name: "Unobserved", color: "#dfbf89", kind: "unclear" },
];

export function FieldSettings() {
  return <details className="field-settings" id="field-settings" hidden
    onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
    <summary>Field colors</summary>
    <div className="field-settings-controls">
      {fieldPalettes.map(({ name, color }) => <label key={name}>{name}<input type="color" defaultValue={color} /></label>)}
      <label>Wind<input type="checkbox" defaultChecked /></label>
    </div>
  </details>;
}

function rgb(value: string) {
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
}

function shade(color: number[], tone: number) {
  return color.map(channel => Math.round(Math.max(0, Math.min(255, channel + tone))));
}

function luminance(color: number[]) {
  return color.reduce((value, channel, index) => {
    const srgb = channel / 255;
    const linear = srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
    return value + linear * [.2126, .7152, .0722][index];
  }, 0);
}

function contrast(first: number, second: number) {
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

function safePalette(value: string) {
  const center = rgb(value);
  const light = luminance(center);
  const brandText = light > .26 ? "#1a130d" : "#fff4df";
  const label = contrast(luminance(rgb(brandText)), light) >= 4.55
    ? brandText
    : light > .179 ? "#000000" : "#ffffff";
  const labelLight = luminance(rgb(label));
  let amplitude = 66;
  while (amplitude > 0 && [-amplitude, amplitude].some(end =>
    contrast(labelLight, luminance(shade(center, end))) < 4.5)) amplitude--;
  return { center, label, amplitude };
}

function textureLayer(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d");
}

function installMaterialRelief(root: HTMLElement, atlas: HTMLImageElement) {
  const output = textureLayer(320, 80);
  if (!output) return;
  const { width, height } = output.canvas;
  output.drawImage(atlas, 0, 0, atlas.width, atlas.height / 2, 0, 0, width, height);
  const map = output.getImageData(0, 0, width, height);
  output.drawImage(atlas, 0, atlas.height / 2, atlas.width, atlas.height / 2, 0, 0, width, height);
  const sand = output.getImageData(0, 0, width, height);
  const relief = output.createImageData(width, height);
  for (const [source, channel, name] of [[map, 0, "soil"], [map, 1, "canopy"], [sand, 0, "sand-relief"]] as const) {
    for (let offset = 0; offset < source.data.length; offset += 4) {
      const tone = source.data[offset + channel] - 128;
      const color = tone >= 0 ? 255 : 0;
      relief.data[offset] = color;
      relief.data[offset + 1] = color;
      relief.data[offset + 2] = color;
      relief.data[offset + 3] = Math.abs(tone) * 1.55;
    }
    output.putImageData(relief, 0, 0);
    root.style.setProperty(`--field-${name}`, `url("${output.canvas.toDataURL()}")`);
  }
}

function FieldSurface({ texture }: { texture: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const wrapper = canvas?.parentElement;
    const plot = wrapper?.querySelector<HTMLElement>("#tiles");
    const settings = document.querySelector<HTMLDetailsElement>("#field-settings");
    const root = wrapper?.closest("main");
    const context = canvas?.getContext("2d");
    const wind = settings?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!canvas || !wrapper || !plot || !settings || !wind || !root || !context) return;
    const inputs = [...settings.querySelectorAll<HTMLInputElement>('input[type="color"]')];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const forced = matchMedia("(forced-colors: active)");
    wind.checked = !reduced.matches;
    wind.disabled = reduced.matches;

    const atlas = new Image();
    let map: ImageData | undefined;
    let sand: ImageData | undefined;
    let materials: CanvasRenderingContext2D[] = [];
    let leaves: CanvasRenderingContext2D | null = null;
    let paintedCanopy: CanvasRenderingContext2D | null = null;
    let paletteKey = "";
    let parcels: { x: number; y: number; width: number; height: number }[] = [];
    let frame = 0;
    let lastPaint = -Infinity;

    function draw(time: number) {
      if (!context || !leaves || !canvas || !parcels.length) return;
      const canopy = leaves.canvas;
      const scale = canvas.height / 160;
      const band = Math.max(1, Math.round(3 * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      parcels.forEach(({ x, y, width, height }, index) => {
        if (!width || !height) return;
        context.save();
        context.beginPath();
        context.rect(x, y, width, height);
        context.clip();
        context.drawImage(materials[index].canvas, 0, 0);
        if (index === 1) {
          for (let row = y; row < y + height; row += band) {
            const strip = Math.min(band, y + height - row);
            const sway = time ? scale * (2.5 * Math.sin(time * .0019 + row / scale * .040) +
              1.3 * Math.sin(time * .0027 - row / scale * .094)) : 0;
            context.drawImage(canopy, x, row, width, strip, x + sway, row, width, strip);
          }
        }
        context.restore();
      });
    }

    function animate(time: number) {
      if (time - lastPaint >= 32) {
        draw(time);
        lastPaint = time;
      }
      frame = requestAnimationFrame(animate);
    }

    function sync() {
      cancelAnimationFrame(frame);
      draw(0);
      if (parcels.length && wind?.checked && !reduced.matches && !forced.matches && !document.hidden) {
        frame = requestAnimationFrame(animate);
      }
    }

    function recolor() {
      if (!canvas || !wrapper || !plot || !root || !map || !sand || !materials.length || !leaves || !paintedCanopy) return;
      const { width, height } = canvas;
      const tiles = fieldPalettes.map(({ kind }) => plot.querySelector<HTMLElement>(".category-tile." + kind));
      const [soil, crops, unobserved] = tiles;
      const size = plot.getBoundingClientRect();
      if (!soil || !crops || !unobserved || !size.width || !size.height) return;
      parcels = [soil, crops, unobserved].map(tile => {
        const box = tile.getBoundingClientRect();
        const x = Math.round((box.left - size.left) * width / size.width);
        const y = Math.round((box.top - size.top) * height / size.height);
        const right = Math.round((box.right - size.left) * width / size.width);
        const bottom = Math.round((box.bottom - size.top) * height / size.height);
        return { x, y, width: right - x, height: bottom - y };
      });
      const trend = root.querySelector(".trend-plot svg");
      const trendWidth = trend?.getBoundingClientRect().width;
      if (trendWidth) {
        root.style.setProperty("--field-paint-width", `${size.width * 400 / trendWidth}px`);
        root.style.setProperty("--field-paint-height", `${size.height * 400 / trendWidth}px`);
      }
      const nextPaletteKey = inputs.map(input => input.value).join();
      if (paletteKey !== nextPaletteKey) {
        paletteKey = nextPaletteKey;
        const shades = inputs.map(input => safePalette(input.value));
        tiles.forEach((tile, index) => tile?.style.setProperty("--field-label", shades[index].label));
        const groundColors = shades.map(({ center, amplitude }, parcel) => Array.from({ length: 256 }, (_, index) =>
          shade(center, (index / 255 * 2 - 1) * amplitude * (parcel === 1 ? .9 : 1))));
        const cropColors = Array.from({ length: 256 }, (_, index) =>
          shade(shades[1].center, Math.max(-1, Math.min(1, (index - 128) / 94)) * shades[1].amplitude));
        const terrain = materials.map(material => material.createImageData(width, height));
        const canopy = leaves.createImageData(width, height);
        for (let offset = 0; offset < map.data.length; offset += 4) {
          for (const [parcel, image] of terrain.entries()) {
            image.data.set(groundColors[parcel][(parcel === 2 ? sand : map).data[offset]], offset);
            image.data[offset + 3] = 255;
          }
          canopy.data.set(cropColors[map.data[offset + 1]], offset);
          canopy.data[offset + 3] = map.data[offset + 2];
        }
        materials.forEach((material, index) => material.putImageData(terrain[index], 0, 0));
        leaves.putImageData(canopy, 0, 0);
        paintedCanopy.drawImage(materials[1].canvas, 0, 0);
        paintedCanopy.drawImage(leaves.canvas, 0, 0);
        for (const [name, material] of [["soil", materials[0]], ["canopy", paintedCanopy]] as const) {
          root.style.setProperty(`--field-paint-${name}`, `url("${material.canvas.toDataURL()}")`);
        }
      }
      wrapper.classList.add("field-ready");
      if (settings) settings.hidden = false;
      sync();
    }

    const resize = new ResizeObserver(recolor);
    const tileChanges = new MutationObserver(changes => {
      if (changes.some(change => change.attributeName === "style")) recolor();
      else sync();
    });
    const updateMotion = () => {
      wind.disabled = reduced.matches;
      if (reduced.matches) wind.checked = false;
      sync();
    };
    atlas.onload = () => {
      const { width } = atlas;
      const height = atlas.height / 2;
      canvas.width = width;
      canvas.height = height;
      const ground = textureLayer(width, height);
      const cropGround = textureLayer(width, height);
      const sandGround = textureLayer(width, height);
      leaves = textureLayer(width, height);
      paintedCanopy = textureLayer(width, height);
      if (!ground || !cropGround || !sandGround || !leaves || !paintedCanopy) return;
      materials = [ground, cropGround, sandGround];
      ground.drawImage(atlas, 0, height, width, height, 0, 0, width, height);
      sand = ground.getImageData(0, 0, width, height);
      ground.drawImage(atlas, 0, 0, width, height, 0, 0, width, height);
      map = ground.getImageData(0, 0, width, height);
      installMaterialRelief(root, atlas);
      recolor();
    };
    atlas.src = texture;
    resize.observe(plot);
    const trendPlot = root.querySelector(".trend-plot");
    if (trendPlot) resize.observe(trendPlot);
    tileChanges.observe(plot, { attributes: true, attributeFilter: ["inert", "style"] });
    for (const input of inputs) input.addEventListener("input", recolor);
    wind.addEventListener("change", sync);
    reduced.addEventListener("change", updateMotion);
    forced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      atlas.onload = null;
      resize.disconnect();
      tileChanges.disconnect();
      cancelAnimationFrame(frame);
      for (const input of inputs) input.removeEventListener("input", recolor);
      wind.removeEventListener("change", sync);
      reduced.removeEventListener("change", updateMotion);
      forced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [texture]);
  return <canvas ref={ref} className="field-canvas" aria-hidden="true" />;
}
