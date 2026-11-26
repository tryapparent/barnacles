type Elapsed = { $: "Duration"; seconds: number; subtract_ms: number } | { $: "Unknown" };

export type SourcePolicy = {
  tool_label(name: string): string;
  interval_ms(startSecond: number, startMs: number, endSecond: number, endMs: number): boolean;
  async_end(startSecond: number, startMs: number, endSecond: number, endMs: number, unambiguous: boolean): boolean;
  origin(creator: string, creationSource: string): string;
  owns_pr(source: string): boolean;
  thread_status(status: string): string;
  link_source(source: string): string;
  link_state(state: string): string;
  merged_at(opened: number, merged: number, confirmed: boolean): number;
  linux_main_source(tag: string): string;
  linux_main_asset(state: string, name: string): boolean;
  may_probe(assetCount: number, published: number, publicRelease: boolean, tagMatches: boolean): boolean;
  same_revision(merge: string, release: string): boolean;
  proves_ancestry(base: string, mergeBase: string, expected: string, status: string): boolean;
  asset_access(status: number, bytes: number, rangeMatches: boolean): boolean;
  pr_milestone(start: number, observed: number): boolean;
  shipping(merged: number, published: number, checked: number, ancestry: boolean, access: boolean): boolean;
  pr_to_release(opened: number, published: number): Elapsed;
  thread_to_release(threadCount: number, startedSecond: number, startedMs: number,
    opened: number, published: number): Elapsed;
};

export function secondsFromElapsed(value: Elapsed): number | null {
  return value.$ === "Duration" ? (value.seconds * 1000 - value.subtract_ms) / 1000 : null;
}
