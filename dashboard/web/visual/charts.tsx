import { useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button, Card } from "../controls";

const fieldPalettes = ["#543b2a", "#91ad5f", "#dfbf89"];

type Category = {
  kind: number;
  name: string;
  style: string;
  duration: string;
  weight: number;
  share: string;
  expanded: boolean;
  select: () => void;
};

type Operation = {
  key: string;
  name: string;
  metric: string;
  weight: number;
  share: string;
  active?: boolean;
  select: () => void;
};

type Overview = {
  total: string;
  hasTime: boolean;
  categories: Category[];
  breakdown?: string;
  operations: Operation[];
  recovery?: { key: string; name: string };
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

function parcelTracks([first, ...rest]: number[], left: number, right: number) {
  if (rest.length === 0) return;
  const column = (minimum: number, duration: number) => `minmax(${minimum}px, ${Math.max(1, duration)}fr)`;
  return {
    gridTemplateColumns: `${column(left, first)} ${column(right, rest.reduce((total, weight) => total + weight, 0))}`,
    gridTemplateRows: rest.map(weight => column(44, weight)).join(" "),
  };
}

export function Summary({ fieldTexture }: { fieldTexture?: string }) {
  const model = useSyncExternalStore(subscribe, () => overview);
  const operationTracks = model ? parcelTracks(model.operations.map(({ weight }) => weight), 104, 104) : undefined;
  return <Card className="summary-panel" id="summary-panel" aria-labelledby="summary-heading" aria-describedby="overview-period"
    onKeyDown={event => {
      if (event.key === "Escape" && model?.breakdown) {
        event.preventDefault();
        (model.clearOperation ?? model.close)();
      }
    }}>
    <div className="summary-surface" aria-hidden="true" />
    <div className="summary-top">
      <h2 id="summary-heading">{model?.breakdown ?? "Where time went"}</h2>
      <p id="summary-total" className={model?.hasTime ? "visually-hidden" : undefined}>{model?.total}</p>
      <Button type="button" id="collapse" hidden={!model?.breakdown} aria-label="Close breakdown"
        title="Return to Where time went" onClick={model?.close}>
        <span aria-hidden="true">↖</span>
      </Button>
    </div>
    <div className="summary-tiles">
    <div className="summary-proportions" aria-hidden="true" data-breakdown={!!model?.breakdown} hidden={!model?.hasTime}>
      {model?.categories.map(category => <span key={category.kind}
        className={`summary-segment ${category.style}`} style={{ flexGrow: category.weight }} />)}
      {fieldTexture && <FieldSurface texture={fieldTexture} />}
    </div>
    <div id="tiles" className="treemap" inert={!!model?.breakdown} hidden={!model?.hasTime}>
      {model?.categories.map(category => <Button type="button" key={category.kind}
        className={`category-tile ${category.style}`} data-kind={category.kind}
        aria-expanded={category.expanded} aria-controls="operation-panel" aria-description={category.share + " of measured time"} onClick={category.select}>
        <span className="category-name">{category.name}</span>
        <span className="category-metric">{category.duration} <span>{category.share}</span></span>
        <span className="category-icon" aria-hidden="true">{category.expanded ? "−" : "+"}</span>
      </Button>)}
    </div>
    <section id="operation-panel" hidden={!model?.breakdown} aria-labelledby="summary-heading">
      <div id="operation-tiles" role="group" aria-label="Operations" style={operationTracks}>
        {model?.operations.map(operation => <Button type="button" key={operation.key}
          className="operation-tile" data-operation={operation.key} aria-pressed={operation.active}
          aria-description={operation.share + " of category time"} onClick={operation.select}>
          <span className="operation-name">{operation.name}</span>
          <span className="operation-metric">
            {operation.metric}
            <span className="selected-indicator" aria-hidden="true">✓</span>
          </span>
        </Button>)}
      </div>
      <p id="operation-empty" className="summary-note" hidden={!model?.emptyOperations}>No recorded operations in this time frame.</p>
      {model?.recovery && <Button type="button" className="operation-recovery"
        data-operation={model.recovery.key} onClick={model.clearOperation}>{model.recovery.name}</Button>}
    </section>
    </div>
  </Card>;
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
  return { center, amplitude };
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
  const relief = output.createImageData(width, height);
  for (const [channel, name] of ["soil", "canopy"].entries()) {
    for (let offset = 0; offset < map.data.length; offset += 4) {
      const tone = map.data[offset + channel] - 128;
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
    const plot = wrapper;
    const root = wrapper?.closest("main");
    const context = canvas?.getContext("2d");
    if (!canvas || !wrapper || !plot || !root || !context) return;

    const atlas = new Image();
    let map: ImageData | undefined;
    let sand: ImageData | undefined;
    let materials: CanvasRenderingContext2D[] = [];
    let leaves: CanvasRenderingContext2D | null = null;
    let paintedCanopy: CanvasRenderingContext2D | null = null;
    let painted = false;
    let soilEnd = 0;
    let cropsEnd = 0;
    function draw() {
      if (!context || !materials.length || !paintedCanopy || !canvas) return;
      const { width, height } = canvas;
      context.drawImage(materials[0].canvas, 0, 0);
      if (cropsEnd > soilEnd) {
        context.drawImage(paintedCanopy.canvas, soilEnd, 0, cropsEnd - soilEnd, height,
          soilEnd, 0, cropsEnd - soilEnd, height);
      }
      if (cropsEnd < width) {
        context.drawImage(materials[2].canvas, cropsEnd, 0, width - cropsEnd, height,
          cropsEnd, 0, width - cropsEnd, height);
      }
    }

    function recolor() {
      if (!canvas || !wrapper || !plot || !root || !map || !sand || !materials.length || !leaves || !paintedCanopy) return;
      const { width, height } = canvas;
      const soil = plot.querySelector(".summary-segment.workflow");
      const crops = plot.querySelector(".summary-segment.agent");
      const size = plot.getBoundingClientRect();
      if (!soil || !crops || !size.width || !size.height) return;
      soilEnd = Math.round((soil.getBoundingClientRect().right - size.left) / size.width * width);
      cropsEnd = Math.round((crops.getBoundingClientRect().right - size.left) / size.width * width);
      const trend = root.querySelector(".trend-plot svg");
      const trendWidth = trend?.getBoundingClientRect().width;
      if (trendWidth) {
        root.style.setProperty("--field-paint-width", `${size.width * 400 / trendWidth}px`);
        root.style.setProperty("--field-paint-height", `${size.height * 400 / trendWidth}px`);
      }
      if (!painted) {
        painted = true;
        const shades = fieldPalettes.map(safePalette);
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
        for (const [name, material] of [["soil", materials[0]], ["canopy", paintedCanopy], ["sand", materials[2]]] as const) {
          root.style.setProperty(`--field-paint-${name}`, `url("${material.canvas.toDataURL()}")`);
        }
      }
      wrapper.classList.add("field-ready");
      draw();
    }

    const resize = new ResizeObserver(recolor);
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
    const segments = new MutationObserver(recolor);
    segments.observe(plot, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    const trendPlot = root.querySelector(".trend-plot");
    if (trendPlot) resize.observe(trendPlot);
    return () => {
      atlas.onload = null;
      resize.disconnect();
      segments.disconnect();
    };
  }, [texture]);
  return <canvas ref={ref} className="field-canvas" aria-hidden="true" />;
}
