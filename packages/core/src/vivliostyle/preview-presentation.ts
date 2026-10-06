// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
/** Identifies which retained presentation owns a display unit. */
export type PreviewPresentationKind = "committed" | "working";

/**
 * A page or spread that can be selected as one atomic display unit.
 *
 * The value is deliberately opaque here. AdaptiveViewer will bind it to the
 * page/spread DOM and its source-map metadata when the presentation model is
 * connected to rendering.
 */
export interface PreviewDisplayUnit<T> {
  readonly owner: PreviewPresentationKind;
  readonly revision: number;
  readonly epages: readonly number[];
  readonly sealed: boolean;
  readonly value: T;
}

/**
 * Resolves display units without allowing any epage to return to an older
 * revision. It owns no DOM and is therefore not another page cache.
 */
export class PreviewDisplayResolver<T> {
  private readonly displayedRevisionByEpage = new Map<number, number>();

  resolve(
    epage: number,
    working: PreviewDisplayUnit<T> | null,
    committed: PreviewDisplayUnit<T> | null,
  ): PreviewDisplayUnit<T> | null {
    if (this.isEligible(working, epage, true)) return working;
    if (this.isEligible(committed, epage, false)) return committed;
    return null;
  }

  markDisplayed(unit: PreviewDisplayUnit<T>): void {
    if (!this.isMonotonic(unit)) {
      throw new Error("Preview display revision must be monotonic per epage");
    }
    for (const epage of unit.epages) {
      this.displayedRevisionByEpage.set(epage, unit.revision);
    }
  }

  revisionForEpage(epage: number): number | null {
    return this.displayedRevisionByEpage.get(epage) ?? null;
  }

  clear(): void {
    this.displayedRevisionByEpage.clear();
  }

  private isEligible(
    unit: PreviewDisplayUnit<T> | null,
    epage: number,
    requireSealed: boolean,
  ): unit is PreviewDisplayUnit<T> {
    return !!(
      unit &&
      unit.epages.includes(epage) &&
      (!requireSealed || unit.sealed) &&
      this.isMonotonic(unit)
    );
  }

  private isMonotonic(unit: PreviewDisplayUnit<T>): boolean {
    return unit.epages.every(
      (epage) => unit.revision >= (this.displayedRevisionByEpage.get(epage) ?? -1),
    );
  }
}
