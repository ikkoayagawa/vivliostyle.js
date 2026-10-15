// Ogenkou fork addition: retained paper DOM and matching text correspondence.
import {
  clearSourceFragments,
  copySourceFragments,
  hitTestSource,
  resolveSourceText,
  type SourceTextPosition,
} from "./source-map";

/**
 * A caller-owned clone, independent of subsequent Viewer refreshes.
 * It leases memory Blob URLs, but does NOT install or isolate arbitrary CSS.
 * Display it in a document with the same, fixed stylesheet/font environment.
 */
export class SourceMappedPresentation {
  private papers: HTMLElement[];
  private released = false;
  private releaseResources: (() => void) | null;
  private acquireResources: (() => () => void) | null;

  constructor(
    readonly revision: number,
    readonly epage: number,
    source: readonly HTMLElement[],
    document: Document,
    acquireResources: () => () => void,
  ) {
    this.papers = source.map((container) => {
      const clone = document.importNode(container, true) as HTMLElement;
      copySourceFragments(container, clone);
      return clone;
    });
    this.releaseResources = acquireResources();
    this.acquireResources = acquireResources;
  }

  get containers(): readonly HTMLElement[] {
    this.assertLive();
    return this.papers;
  }

  resolveTextPosition(node: Node, offset: number): SourceTextPosition | null {
    this.assertLive();
    if (!this.papers.some((paper) => paper.contains(node))) return null;
    const position = resolveSourceText(node, offset);
    if (position && position.revision !== this.revision)
      throw new Error("Presentation/source-map revision mismatch");
    return position;
  }

  hitTestSource(clientX: number, clientY: number): SourceTextPosition | null {
    this.assertLive();
    for (const paper of this.papers) {
      const position = hitTestSource(paper, clientX, clientY);
      if (position && position.revision !== this.revision)
        throw new Error("Presentation/source-map revision mismatch");
      if (position) return position;
    }
    return null;
  }

  cloneInto(document: Document): SourceMappedPresentation {
    this.assertLive();
    return new SourceMappedPresentation(
      this.revision,
      this.epage,
      this.papers,
      document,
      this.acquireResources!,
    );
  }

  /** Idempotent. Detach only this handle's DOM; release its resource lease. */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const paper of this.papers) {
      paper.remove();
      clearSourceFragments(paper);
    }
    this.papers = [];
    this.releaseResources?.();
    this.releaseResources = null;
    this.acquireResources = null;
  }

  private assertLive(): void {
    if (this.released)
      throw new Error("SourceMappedPresentation has been released");
  }
}
