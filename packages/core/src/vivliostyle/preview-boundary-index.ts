/** Immutable offsets of consecutive, usable preview page starts (pages 1..N). */
export function createPreviewBoundaryIndex(
  length: number,
  offsetAt: (page: number) => number | null,
): readonly number[] | null {
  const offsets: number[] = [];
  for (let page = 1; page < length; page++) {
    const offset = offsetAt(page);
    if (offset === null) break;
    if (!Number.isFinite(offset) || (offsets.length && offset < offsets[offsets.length - 1])) return null;
    offsets.push(offset);
  }
  return Object.freeze(offsets);
}

/** Exact equivalent of the old forward scan, before its one-page lookbehind. */
export function findPreviewBoundary(index: readonly number[], changedOffset: number): number {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index[middle] < changedOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}
