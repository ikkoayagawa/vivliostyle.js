// Ogenkou fork addition: caller-owned, isolated completed-paper generation.
import {
  CompletedPaperDocument,
  completedFontKey,
  type CompletedPaperPacket,
} from "./completed-paper";
import type { SourceMappedPresentation } from "./source-presentation";

/** Host a generation in its own same-origin iframe. No Viewer or layout work.
 * The packet is trusted same-build output. Network/font availability remains
 * the caller's snapshot contract; supplied memory Blob URLs are remapped here.
 */
export class CompletedPaperHost {
  private frame: HTMLIFrameElement;
  private paper: CompletedPaperDocument;
  private references = 0;
  private released = false;
  private urls: string[] = [];
  private mounted: { root: HTMLElement; paper: HTMLElement }[] = [];
  readonly document: Document;
  private loadedFontKeys: Set<string>;

  constructor(
    packet: CompletedPaperPacket,
    parent: HTMLElement,
    compatibilityKey: string,
  ) {
    this.loadedFontKeys = new Set(packet.loadedFontKeys);
    const frame = parent.ownerDocument.createElement("iframe");
    frame.title = "Completed paper";
    frame.style.cssText = "border:0;width:100%;height:100%";
    parent.appendChild(frame);
    this.frame = frame;
    const document = frame.contentDocument!;
    this.document = document;
    try {
      for (const [name, value] of packet.rootAttributes)
        document.documentElement.setAttribute(name, value);
      for (const [name, value] of packet.bodyAttributes)
        document.body.setAttribute(name, value);
      const resources = new Map(
        packet.resources?.map((resource) => [resource.url, resource]) ?? [],
      );
      const replacements = new Map<string, string>(),
        resolving = new Set<string>();
      const rewrite = (text: string): string =>
        text.replace(/blob:[^\s"'<>\)]+/g, (url) => {
          const hash = url.indexOf("#");
          return hash < 0
            ? resolve(url)
            : resolve(url.slice(0, hash)) + url.slice(hash);
        });
      const resolve = (url: string): string => {
        if (replacements.has(url)) return replacements.get(url)!;
        const resource = resources.get(url);
        if (!resource)
          throw new Error("Blob resource missing from completed paper packet");
        if (resolving.has(url))
          throw new Error("Cyclic completed CSS resource");
        resolving.add(url);
        const bytes = Uint8Array.from(
          document.defaultView!.atob(resource.base64),
          (c) => c.charCodeAt(0),
        );
        const content = resource.mediaType.startsWith("text/css")
          ? rewrite(new TextDecoder().decode(bytes))
          : bytes;
        const next = document.defaultView!.URL.createObjectURL(
          new Blob([content], { type: resource.mediaType }),
        );
        this.urls.push(next);
        replacements.set(url, next);
        resolving.delete(url);
        return next;
      };
      resources.forEach((_resource, url) => resolve(url));
      for (const css of packet.stylesheets) {
        const style = document.createElement("style");
        style.textContent = rewrite(css);
        document.head.appendChild(style);
      }
      this.paper = new CompletedPaperDocument(
        packet,
        document,
        compatibilityKey,
        () => {
          this.references++;
          return () => {
            this.mounted = this.mounted.filter(({ root, paper }) => {
              if (paper.isConnected) return true;
              if (
                !this.mounted.some(
                  (item) => item.root === root && item.paper.isConnected,
                )
              )
                root.remove();
              return false;
            });
            if (!--this.references && this.released) this.dispose();
          };
        },
      );
      this.rewrite = rewrite;
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.ancestors = packet.pages.map((page) => page.ancestors);
  }
  private ancestors: CompletedPaperPacket["pages"][number]["ancestors"][];
  private rewrite: (text: string) => string;

  retainPages(indices: readonly number[]): SourceMappedPresentation {
    if (this.released) throw new Error("CompletedPaperHost has been released");
    const handle = this.paper.retainPages(indices, this.document);
    const parents = new Map<string, HTMLElement>();
    // Each paper gets its original viewport/spread ancestry, preserving dimensions.
    try {
      handle.containers.forEach((paper, index) => {
        let parent: HTMLElement = this.document.body;
        let root: HTMLElement = paper;
        const prefix: unknown[] = [];
        for (const saved of this.ancestors[indices[index]]) {
          prefix.push(saved);
          const key = JSON.stringify(prefix),
            existing = parents.get(key);
          if (existing) {
            parent = existing;
            if (parent.parentElement === this.document.body) root = parent;
            continue;
          }
          const element = this.document.createElement(saved.tag);
          for (const [name, value] of saved.attributes)
            element.setAttribute(name, value);
          parent.appendChild(element);
          parent = element;
          parents.set(key, element);
          if (parent.parentElement === this.document.body) root = element;
        }
        for (const element of [
          paper,
          ...Array.from(paper.querySelectorAll("*")),
        ])
          for (const attribute of Array.from(element.attributes))
            if (
              ["src", "href", "poster", "data", "style", "srcset"].includes(
                attribute.name,
              )
            )
              element.setAttribute(
                attribute.name,
                this.rewrite(attribute.value),
              );
        paper.style.display = "block";
        parent.appendChild(paper);
        this.mounted.push({ root, paper });
      });
      return handle;
    } catch (error) {
      handle.release();
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.ancestors = [];
    this.paper.release();
  }

  /** Wait after mounting and before publication. This performs no pagination. */
  async awaitReady(): Promise<void> {
    if (this.released) throw new Error("CompletedPaperHost has been released");
    this.document.body.getBoundingClientRect();
    await this.document.fonts.ready;
    const failedFont = Array.from(this.document.fonts).find(
      (font) =>
        font.status === "error" &&
        this.loadedFontKeys.has(completedFontKey(font)),
    );
    if (failedFont) throw new Error("Completed paper font failed to load");
    await Promise.all(
      Array.from(this.document.images).map((image) => image.decode()),
    );
    if (this.released)
      throw new Error(
        "CompletedPaperHost was released while loading resources",
      );
  }

  private dispose(): void {
    this.urls
      .splice(0)
      .forEach((url) => this.document.defaultView!.URL.revokeObjectURL(url));
    // Drop the closure retaining serialized asset bytes as well as DOM/font
    // storage, even if the caller keeps the released handle for bookkeeping.
    this.rewrite = () => { throw new Error("CompletedPaperHost has been disposed"); };
    this.loadedFontKeys.clear();
    this.mounted = [];
    this.document.head.replaceChildren();
    this.document.body.replaceChildren();
    this.document.fonts.clear();
    this.frame.remove();
  }
}
