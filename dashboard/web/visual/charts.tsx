import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button } from "../controls";

type Category = {
  kind: number;
  name: string;
  style: string;
  duration: string;
  share: number;
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

export function Summary() {
  const model = useSyncExternalStore(subscribe, () => overview);
  return <section className="summary-panel" id="summary-panel" aria-labelledby="summary-heading">
    <div className="summary-top">
      <h2 id="summary-heading">Where time went</h2>
      <p id="summary-total">{model?.total}</p>
    </div>
    <p id="summary-note" className="summary-note">{model?.note}</p>
    <div id="tiles" className="treemap">
      {model?.categories.map(category => <Button type="button" key={category.kind}
        className={`category-tile ${category.style}`} data-kind={category.kind}
        aria-expanded={category.expanded} aria-controls="operation-panel" onClick={category.select}>
        <span className="category-name">{category.name}</span>
        <span className="category-metric">{category.duration}<span className="category-share">{`${category.share}%`}</span></span>
        <span className="category-icon" aria-hidden="true">{category.expanded ? "−" : "+"}</span>
      </Button>)}
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
