/** Opt-in diagnostics only. Source offsets/counts are never manuscript text. */
type Region = "before" | "target" | "after" | "mixed";
type Phase = "initialize" | "analysis" | "restore" | "layout";
type Sample = { from: number; to: number; ms: number; elements: number; chars: number; phase: Phase };

export class CssWalkProfile {
  phase: Phase = "initialize";
  elements = 0;
  chars = 0;
  private samples: Sample[] = [];
  private dropped = 0;

  record(from: number, to: number, ms: number, elements: number, chars: number): void {
    if (this.samples.length >= 65536) { this.dropped++; return; }
    this.samples.push({ from, to, ms, elements, chars, phase: this.phase });
  }

  summarize(start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new Error("Invalid CSS walk target range");
    const empty = () => ({ totalMs: 0, analysisMs: 0, initializeMs: 0, restoreMs: 0, layoutMs: 0,
      elements: 0, chars: 0, calls: 0 });
    const regions: Record<Region, ReturnType<typeof empty>> = {
      before: empty(), target: empty(), after: empty(), mixed: empty(),
    };
    for (const sample of this.samples) {
      // Calls that cross a page boundary remain unallocated. Do not assume
      // their runtime is proportional to source length.
      const region: Region = sample.to <= start && sample.from < start ? "before"
        : sample.from >= end ? "after"
        : sample.from >= start && sample.to <= end ? "target" : "mixed";
      const result = regions[region];
      result.totalMs += sample.ms;
      result[`${sample.phase}Ms`] += sample.ms;
      result.elements += sample.elements;
      result.chars += sample.chars;
      result.calls++;
    }
    return { start, end, dropped: this.dropped, regions };
  }
}

export function createCssWalkProfile(): CssWalkProfile | undefined {
  return typeof (globalThis as unknown as { __ogenkouCssWalkProfile?: unknown }).__ogenkouCssWalkProfile === "function"
    ? new CssWalkProfile() : undefined;
}
