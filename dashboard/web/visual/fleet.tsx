import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { countLabel, detailPage, stages, utcLabel, type Review } from "../api";
import { Button } from "../controls";
import { mountHarbor } from "./scene";

const shipsPerStage = 4;

export function Fleet({ fleet, onSelect, children }: { fleet: Review["fleet"];
  onSelect: (event: MouseEvent<HTMLAnchorElement>, number: number) => void; children: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const localClock = useRef<HTMLTimeElement>(null);
  const shipLinks = useRef(new Map<number, HTMLAnchorElement>());
  const paused = useRef(false);
  const [isPaused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const groups = stages.map(([stage, label]) => ({ stage, label, items: fleet.items.filter((item) => item.stage === stage) }));
  const contacts = groups.flatMap(({ items }, position) => items.slice(0, shipsPerStage)
    .map((item, index) => ({ item, column: .15 + position * .116 + Math.sin(index * 2.6 + position) * .025,
      depth: .22 + index * .19 + Math.sin(position * 2 + index) * .055, drift: .7 + index * .19 })));

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const review = canvas.current!.closest("main")!;
    review.toggleAttribute("data-motion-paused", paused.current);
    const painter = mountHarbor(canvas.current!, contacts.map(({ item, ...contact }) =>
      ({ ...contact, link: shipLinks.current.get(item.number) })));
    const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const tick = () => {
      const now = new Date();
      const hour = now.getHours() + now.getMinutes() / 60;
      const day = hour >= 6 && hour < 18;
      const crossing = (day ? hour - 6 : (hour + 6) % 12) / 12;
      localClock.current!.textContent = clockFormat.format(now);
      localClock.current!.dateTime = now.toISOString();
      painter.setLight(day, .12 + .76 * crossing, .16 - .08 * Math.sin(Math.PI * crossing));
    };
    const onPreference = () => setReduced(media.matches);
    media.addEventListener("change", onPreference);
    tick();
    const timer = window.setInterval(tick, 30_000);
    let frame: number;
    let elapsed = 0;
    let last = 0;
    const animate = (now: number) => {
      if (now - last >= 40) {
        if (last && !paused.current && !media.matches && !document.hidden) {
          elapsed = (elapsed + Math.min(now - last, 100)) % 28_000;
          const progress = elapsed / 28_000;
          painter.render(progress);
          review.style.setProperty("--swell", String((1 - Math.cos(progress * Math.PI * 2)) / 2));
        }
        last = now;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      media.removeEventListener("change", onPreference);
      painter.dispose();
      review.style.removeProperty("--swell");
      review.removeAttribute("data-motion-paused");
    };
  }, [fleet]);

  const toggle = () => {
    paused.current = !paused.current;
    canvas.current?.closest("main")?.toggleAttribute("data-motion-paused", paused.current);
    setPaused(paused.current);
  };

  return <section className="fleet" aria-labelledby="fleet-title">
    <div className="fleet-window">
      <header className="harbor-title"><h1>Barnacles</h1></header>
      <canvas className="fleet-water" aria-hidden="true" ref={canvas} />
      {contacts.map(({ item }) => <a key={item.number} className="fleet-ship" aria-label={`Open PR #${item.number} evidence`}
        title={`PR #${item.number}`} href={detailPage(item.number, fleet.to)} onClick={(event) => onSelect(event, item.number)} ref={(link) => {
          if (link) shipLinks.current.set(item.number, link);
          else shipLinks.current.delete(item.number);
        }} />)}
    </div>
    <header className="fleet-heading">
      <h2 id="fleet-title">Fleet <span>{countLabel(fleet.items.length)} observed</span></h2>
      <div className="fleet-tools">
        <time className="fleet-clock" title="Local time" ref={localClock} />
        {!reduced && <Button variant="outline" type="button" onClick={toggle}>{isPaused ? "Resume motion" : "Pause motion"}</Button>}
      </div>
    </header>
    {children}
    {fleet.items.length ? <details className="fleet-manifest">
      <summary>Fleet manifest <span className="fleet-limit">· Up to {shipsPerStage} ships shown per stage</span></summary>
      <p className="fine">Latest observations from {utcLabel(fleet.from)} to {utcLabel(fleet.to)}.</p>
      <ul className="fleet-groups">{groups.filter(({ items }) => items.length).map(({ stage, label, items }) =>
        <li key={stage}><span>{label} <small>· {countLabel(items.length)}</small></span>
          <ul className="fleet-prs">{items.map((item) => <li key={item.number}>
            <a href={detailPage(item.number, fleet.to)} onClick={(event) => onSelect(event, item.number)}>PR #{item.number}</a>
          </li>)}</ul>
        </li>)}</ul>
    </details> : <p className="fleet-empty fine">No milestones were observed in this fleet window.</p>}
  </section>;
}
