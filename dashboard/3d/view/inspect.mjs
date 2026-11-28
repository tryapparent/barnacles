import { groundScreen } from "./camera.mjs";
import { fogHeight } from "../scene/geometry.mjs";
import { createElement as h } from "react";
import { Button } from "../../web/controls.tsx";
import { timeLabel } from "./parcels.mjs";

const control = (props, ...children) =>
  h(Button, { type: "button", ...props }, ...children);
export function Inspector({ item, board, select }) {
  if (!item) return null;
  const parent = board.objects.get(item.parent);
  let facts;
  if (item.kind === "batch") {
    facts = [
      item.measured + " of 10 threads measured",
      ...[-1, 1].map((step) =>
        control(
          {
            key: step,
            disabled: !board.batches[item.index + step],
            onClick: () =>
              select(board.batches[item.index + step].key, "batch-step"),
          },
          step < 0 ? "Previous batch" : "Next batch",
        ),
      ),
    ];
  } else if (item.kind === "category" || item.kind === "operation") {
    const category = item.kind === "category" ? item : parent;
    facts = category.operations.length
      ? category.operations.map((op) =>
          control(
            {
              key: op.key,
              "data-fallback": op.key,
              "aria-pressed": item.key === op.key,
              onClick: () => select(op.key),
            },
            op.name + " · " + op.value,
          ),
        )
      : "No operations in this range.";
  } else {
    const thread = item.kind === "thread" ? item : parent;
    const entries = [...thread.parts, ...thread.failures].sort(
      (a, b) => a.start - b.start,
    );
    facts = h(
      "ul",
      { className: "evidence-list", "aria-label": "Recorded timeline" },
      entries.map((part) =>
        h(
          "li",
          { key: part.key },
          control(
            {
              "aria-pressed": part.key === item.key,
              onClick: () => select(part.key),
            },
            timeLabel(part.start) +
              (part.duration != null
                ? "–" + timeLabel(part.start + part.duration)
                : "") +
              " · " +
              (part.category && part.name !== part.category
                ? part.category + " · "
                : "") +
              part.name,
          ),
        ),
      ),
    );
    if (!entries.length) facts = "No elapsed interval recorded.";
  }
  return h(
    "section",
    { className: "farm-detail", "aria-label": "Selected field" },
    h("h2", null, item.name),
    h("span", { className: "readout" }, item.value),
    item.duration !== null &&
      h(
        "small",
        { className: "sr-only" },
        item.duration.toLocaleString("en") + " ms",
      ),
    h("div", { className: "facts" }, facts),
  );
}

export function GroundLabels({ board, selected }) {
  const marks = [];
  function mark(item, text, value, style, x, y) {
    marks.push(h("span", {
      key: item.key, "data-caption": item.key, className: style,
      "data-x": x, "data-y": y,
      "data-fog": item.material === "fog" || undefined,
      "data-selected": selected?.key === item.key || undefined,
    }, text, value && h("strong", null, value)));
  }
  for (const thread of board.threads)
    for (const event of thread.failures)
      mark(event, null, null, "failure-stake", event.anchor.x, event.anchor.y);
  if (!selected) {
    for (const d of board.categories) mark(d,d.name,d.value,"field-reading");
    for (const [i,tick] of board.ticks.entries())
      mark({key:"tick/"+i},tick.name,tick.value,"time-reading",Math.min(tick.x,board.axis.x+board.axis.w-31),board.axis.y-15);
  } else if (selected.kind === "batch") {
    for (const d of board.batches)
      mark(d, d.value, null, "batch-reading", d.point?.[0] ?? d.anchor.x, d.point?.[1] ?? d.anchor.y);
    for (const n of [0, 50, 100])
      mark({ key: "axis/" + n }, n + "%", null, "scale-reading", board.trend.x - 27, board.trend.y + board.trend.h * (1-n/100));
    for (const d of [board.batches[0], board.batches.at(-1)].filter((d,i,a)=>a.indexOf(d)===i))
      mark({key:"end/"+d.key}, d.name, null, "range-reading", d.point?.[0] ?? d.anchor.x, board.trend.y+board.trend.h+13);
  } else if (selected?.kind === "category" || selected?.kind === "operation") {
    for (const d of board.categories) {
      if (d.key === selected.key || d.key === selected.parent)
        for (const op of d.operations) mark(op, op.name, op.value, "operation-reading");
      else mark(d, d.name, d.value, "neighbor-reading");
    }
  } else if (selected) {
    const thread = selected.kind === "thread" ? selected : board.objects.get(selected.parent);
    for (const part of thread.parts) mark(part, part.name, part.value, "phase-reading");
  }
  return h("div", {className:"ground-labels", "aria-hidden":true}, marks);
}
export function projectLabels(root, pose) {
  const w=root.clientWidth, h=root.clientHeight;
  const project=(x,z,above=0)=>groundScreen(pose,w,h,x,z,above);
  let timeEnd=-Infinity;
  const footprints=[];
  const targets=new Map(Array.from(root.querySelectorAll(".category-tile,.parcel-button,.phase-target"), el=>[el.dataset.target,el]));
  const backups=new Map(Array.from(root.querySelectorAll("[data-fallback]"), el=>[el.dataset.fallback,el]));
  const priority=el=>el.dataset.selected ? 0 : el.classList.contains("neighbor-reading") ? 2 : 1;
  const captions=[...root.querySelectorAll("[data-caption]")].sort((a,b)=>priority(a)-priority(b));
  for (const el of captions) {
    const key=el.dataset.caption;
    let x,y;
    if (el.dataset.x !== undefined) {
      const wx=Number(el.dataset.x), wz=Number(el.dataset.y);
      [x,y]=project(wx,wz);
      el.hidden=x<0 || x>w || y<45 || y>h;
      if(el.className==="time-reading" && !el.hidden) {
        el.hidden=x<timeEnd+8;
        if(!el.hidden) timeEnd=x+el.offsetWidth;
      }
    } else {
      const target=targets.get(key);
      if (!target) { el.hidden=true; continue; }
      const {left,top:worldTop,width,height}=target.style;
      const x0=parseFloat(left),z0=parseFloat(worldTop);
      const x1=x0+parseFloat(width),z1=z0+parseFloat(height);
      const corners=[project(x0,z0),project(x1,z0),project(x1,z1),project(x0,z1)];
      const ys=corners.map(point=>point[1]);
      const top=Math.max(67,Math.min(...ys)), bottom=Math.min(h-12,Math.max(...ys));
      y=top+(bottom-top)*(el.className==="operation-reading"?.69:.5);
      const crossings=[];
      for(let i=0;i<4;i++){
        const a=corners[i], b=corners[(i+1)%4];
        if((a[1]<=y)!==(b[1]<=y)) crossings.push(a[0]+(b[0]-a[0])*(y-a[1])/(b[1]-a[1]));
      }
      const start=Math.max(6,Math.min(...crossings)), end=Math.min(w-6,Math.max(...crossings));
      x=(start+end)/2;
      const inFog=el.dataset.fog;
      if(inFog) {
        const topOfBank=fogHeight(x1-x0,z1-z0);
        [x,y]=project((x0+x1)/2,(z0+z1)/2,topOfBank*.38);
      }
      el.toggleAttribute("data-inline", bottom-top<(inFog ? 57 : 39));
      el.hidden=end-start<Math.min(180,Math.max(54,el.firstChild.textContent.length*7.5)) || bottom-top<18;
      if(el.className==="field-reading" && (!target.firstChild || end-start<el.offsetWidth)) el.hidden=true;
      if(inFog && (x<0 || x>w || y<48 || y>h-8)) el.hidden=true;
      if(!el.hidden) {
        const halfW=el.offsetWidth*.5+2,halfH=el.offsetHeight*.5+2;
        const bounds=[x-halfW,y-halfH,x+halfW,y+halfH];
        el.hidden=bounds[1]<45 || bounds[3]>h-2 || footprints.some(b=>
          bounds[0]<b[2] && bounds[2]>b[0] && bounds[1]<b[3] && bounds[3]>b[1]);
        if(!el.hidden) footprints.push(bounds);
      }
      if (target.classList.contains("parcel-button")) {
        target.tabIndex=el.hidden ? -1 : 0;
        const backup=backups.get(key);
        if(backup) backup.hidden=!el.hidden;
      }
    }
    el.style.left=x+"px";
    el.style.top=y+"px";
  }
}
