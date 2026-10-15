/** Structural index for page-boundary searches. CSS eligibility is never cached. */
export class PageStartIndex {
  private readonly elements: Element[] = [];
  private readonly offsets: number[] = [];
  private readonly parents: number[] = [];
  private readonly ends: number[] = [];
  private readonly observer: MutationObserver;
  private readonly elementIndices: Map<Element, number>;
  private invalid = false;
  private certified = 0;

  constructor(
    private readonly root: Element,
    rootOffset: number,
  ) {
    let offset = rootOffset + 1;
    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_ALL,
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        this.elements.push(node as Element);
        this.offsets.push(offset++);
      } else offset += node.textContent?.length ?? 0;
    }
    const indices = this.elementIndices = new Map(this.elements.map((element, i) => [element, i]));
    this.elements.forEach((element, i) => {
      const stored = element.getAttribute("data-adapt-eloff");
      if (stored !== null && Number(stored) !== this.offsets[i])
        this.invalid = true;
      this.parents.push(indices.get(element.parentElement) ?? -1);
      this.ends.push(i + 1);
    });
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const parent = this.parents[i];
      if (parent >= 0)
        this.ends[parent] = Math.max(this.ends[parent], this.ends[i]);
    }
    // XMLDoc's lazily installed offset attributes do not change source structure.
    this.observer = new MutationObserver((records) => this.invalidate(records));
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }

  private invalidate(records: MutationRecord[]): void {
    if (
      records.some(
        (record) =>
        record.type !== "attributes" ||
        record.attributeName !== "data-adapt-eloff" ||
        (this.elementIndices.has(record.target as Element) &&
          Number((record.target as Element).getAttribute("data-adapt-eloff")) !==
            this.offsets[this.elementIndices.get(record.target as Element)]),
      )
    ) {
      this.invalid = true;
      this.observer.disconnect();
    }
  }

  /** undefined requests the reference search; null means no candidate. */
  find(
    offset: number,
    // Only already-cascaded literal eligibility properties may be skipped.
    // undefined means not styled yet; false means context-dependent evaluation.
    canSkip: (element: Element, offset: number) => boolean | undefined,
    normal: (element: Element) => boolean,
    inline: (element: Element) => boolean,
  ): Element | null | undefined {
    this.invalidate(this.observer.takeRecords());
    if (this.invalid) return undefined;
    let low = 0,
      high = this.offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    while (this.certified < low) {
      const safe = canSkip(
        this.elements[this.certified],
        this.offsets[this.certified],
      );
      if (safe === undefined) return undefined;
      if (!safe) {
        this.invalid = true;
        this.observer.disconnect();
        return undefined;
      }
      this.certified++;
    }
    let result: Element | null = null;
    for (let i = low; i < this.elements.length;) {
      const ancestors: number[] = [];
      for (let p = this.parents[i]; p >= 0; p = this.parents[p])
        ancestors.push(p);
      let rejected = -1;
      for (let a = ancestors.length - 1; a >= 0; a--) {
        if (!normal(this.elements[ancestors[a]])) {
          rejected = ancestors[a];
          break;
        }
      }
      if (rejected >= 0) {
        i = this.ends[rejected];
        continue;
      }
      if (!normal(this.elements[i])) {
        i = this.ends[i];
        continue;
      }
      if (!inline(this.elements[i])) {
        result = this.elements[i];
        break;
      }
      i++;
    }
    this.invalidate(this.observer.takeRecords());
    return this.invalid ? undefined : result;
  }
}
