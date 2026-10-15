// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Base from "./base";

type Entry = {
  source: Node;
  revision: number;
  domRevision: number;
  candidates: Element[];
  negatives: Element[];
};

/** Internal opt-in counters: no source DOM or manuscript text is exposed. */
export type RepeatIndexProfile = {
  builds: number;
  hits: number;
  skipped: number;
  verified: number;
  invalidated: number;
  mismatch: number;
  disposed: boolean;
  observing: boolean;
};

/** A document-local negative index; never exported with a committed seed. */
export class RepeatIndex {
  private entries = new WeakMap<Element, Entry>();
  private observer: MutationObserver | null = null;
  private domRevision = 0;
  private disposed = false;
  private detachedRoots = new WeakSet<Element>();
  private readonly verify: boolean;
  private readonly profile?: RepeatIndexProfile;

  constructor() {
    const diagnostics = globalThis as unknown as {
      __ogenkouRepeatIndexProfile?: (profile: RepeatIndexProfile) => void;
      __ogenkouVerifyRepeatIndex?: boolean;
    };
    this.verify = diagnostics.__ogenkouVerifyRepeatIndex === true;
    if (typeof diagnostics.__ogenkouRepeatIndexProfile === "function") {
      this.profile = {
        builds: 0,
        hits: 0,
        skipped: 0,
        verified: 0,
        invalidated: 0,
        mismatch: 0,
        disposed: false,
        observing: false,
      };
      diagnostics.__ogenkouRepeatIndexProfile(this.profile);
    }
  }

  private mutations(records: MutationRecord[]): void {
    if (
      records.some(
        (record) =>
          record.type !== "attributes" ||
          record.attributeName !== Base.ELEMENT_OFFSET_ATTR ||
          record.oldValue !== null,
      )
    ) {
      this.domRevision++;
    }
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.entries = new WeakMap();
    this.detachedRoots = new WeakSet();
    this.disposed = true;
    if (this.profile) {
      this.profile.disposed = true;
      this.profile.observing = false;
    }
  }

  *scan<T>(
    parent: Element,
    source: Node,
    revision: () => number,
    evaluate: (element: Element) => { negative: boolean; value: T },
    enabled: () => boolean,
  ): Generator<T> {
    if (!parent.firstElementChild) {
      this.entries.delete(parent);
      return;
    }
    if (this.disposed || !enabled()) {
      this.dispose();
      for (
        let child = parent.firstElementChild;
        child;
        child = child.nextElementSibling
      )
        yield evaluate(child).value;
      return;
    }
    if (!this.observer) {
      this.observer = new MutationObserver((records) =>
        this.mutations(records),
      );
      this.observer.observe(parent.ownerDocument, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
      });
      if (this.profile) this.profile.observing = true;
    }
    // A detached source subtree is not observable through ownerDocument.
    if (!parent.isConnected && !this.detachedRoots.has(parent)) {
      this.observer.observe(parent, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
      });
      this.detachedRoots.add(parent);
    }
    this.mutations(this.observer.takeRecords());
    const entry = this.entries.get(parent);
    if (
      entry &&
      entry.source === source &&
      entry.revision === revision() &&
      entry.domRevision === this.domRevision
    ) {
      if (this.profile) {
        this.profile.hits++;
        this.profile.skipped += entry.negatives.length;
      }
      if (this.verify)
        for (const child of entry.negatives) {
          if (this.profile) this.profile.verified++;
          if (!evaluate(child).negative) {
            if (this.profile) this.profile.mismatch++;
            throw new Error(
              "Repeating-element index retained a stale negative",
            );
          }
        }
      for (const child of entry.candidates) yield evaluate(child).value;
      return;
    }
    if (this.profile) {
      this.profile.builds++;
      if (entry) this.profile.invalidated++;
    }
    const candidates: Element[] = [],
      negatives: Element[] = [];
    const domRevision = this.domRevision;
    let complete = false;
    try {
      for (
        let child = parent.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        const result = evaluate(child);
        (result.negative ? negatives : candidates).push(child);
        yield result.value;
      }
      complete = true;
    } finally {
      if (this.observer) this.mutations(this.observer.takeRecords());
      // Unknown/dynamic evaluations may have side effects. Certify only a
      // wholly negative traversal; mixed parents retain the original walker.
      if (
        complete &&
        !candidates.length &&
        !this.disposed &&
        enabled() &&
        domRevision === this.domRevision
      )
        this.entries.set(parent, {
          source,
          revision: revision(),
          domRevision,
          candidates,
          negatives,
        });
    }
  }
}
