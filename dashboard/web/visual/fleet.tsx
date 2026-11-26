import { useEffect, useRef, useState } from "react";
import { countLabel, detailPage, stages, utcLabel, type Review } from "../api";
import { Button } from "../controls";
import { mountHarbor } from "./scene";

export function Fleet({ fleet }: { fleet: Review["fleet"] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sky = useRef<HTMLDivElement>(null);
  const localClock = useRef<HTMLTimeElement>(null);
  const paused = useRef(false);
  const [isPaused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const groups = stages.map(([stage, label]) => ({ stage, label, items: fleet.items.filter((item) => item.stage === stage) }));

  useEffect(() => {
    const visible = stages.flatMap(([stage], position) => fleet.items.filter((item) => item.stage === stage).slice(0, 4)
      .map((_, index) => ({ column: .15 + position * .116 + Math.sin(index * 2.6 + position) * .025,
        row: .44 + index * .137 + Math.sin(position * 2 + index) * .040, drift: .7 + index * .19 })));
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const painter = mountHarbor(canvas.current!, visible);
    const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const tick = () => {
      const now = new Date();
      const hour = now.getHours() + now.getMinutes() / 60;
      const day = hour >= 6 && hour < 18;
      const crossing = (day ? hour - 6 : (hour + 6) % 12) / 12;
      sky.current!.style.setProperty("--sky-x", `${12 + 76 * crossing}%`);
      sky.current!.style.setProperty("--sky-y", String((16 - 8 * Math.sin(Math.PI * crossing)) / 100));
      sky.current!.dataset.light = day ? "day" : "night";
      localClock.current!.textContent = clockFormat.format(now);
      localClock.current!.dateTime = now.toISOString();
      painter.setLight(day);
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
          painter.render(elapsed / 28_000);
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
    };
  }, [fleet]);

  const toggle = () => {
    paused.current = !paused.current;
    setPaused(paused.current);
  };

  return <section className="fleet" aria-labelledby="fleet-title">
    <header className="fleet-heading">
      <h2 id="fleet-title">Fleet <span>{countLabel(fleet.items.length)} observed</span></h2>
      <div className="fleet-tools">
        <time className="fleet-clock" title="Local time" ref={localClock} />
        {!reduced && <Button variant="outline" type="button" onClick={toggle}>{isPaused ? "Resume motion" : "Pause motion"}</Button>}
      </div>
    </header>
    <div className="fleet-window">
      <canvas className="fleet-water" aria-hidden="true" ref={canvas} />
      <div className="fleet-celestial" aria-hidden="true" ref={sky} />
    </div>
    {fleet.items.length ? <details className="fleet-manifest">
      <summary>Fleet manifest</summary>
      <p className="fine">Latest observations from {utcLabel(fleet.from)} to {utcLabel(fleet.to)}.</p>
      <ul className="fleet-groups">{groups.filter(({ items }) => items.length).map(({ stage, label, items }) =>
        <li key={stage}><span>{label} <small>· {countLabel(items.length)}</small></span>
          <ul className="fleet-prs">{items.map((item) => <li key={item.number}>
            <a href={detailPage(item.number, fleet.to)}>PR #{item.number}</a>
          </li>)}</ul>
        </li>)}</ul>
    </details> : <p className="fleet-empty fine">No milestones were observed in this fleet window.</p>}
  </section>;
}
