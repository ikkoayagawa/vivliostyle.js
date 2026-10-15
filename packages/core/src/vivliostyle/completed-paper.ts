// Ogenkou fork addition: completed paper transport, independent of restart state.
import type { PreviewSnapshotSeed } from "./adaptive-viewer";
import {
  nodesIn,
  nodeSignature,
  restorePortableSourceBoundaries,
} from "./portable-seed";
import {
  createSourcePathIndex,
  exportSourceFragments,
  exportSourceTexts,
  importSourceFragments,
  registerSourceTexts,
  type SerializedSourceFragment,
  type SourceTextEntry,
} from "./source-map";
import { SourceMappedPresentation } from "./source-presentation";

type Signatures = ReturnType<typeof nodeSignature>[];
export const completedFontKey = (font: FontFace): string =>
  JSON.stringify([
    font.family,
    font.style,
    font.weight,
    font.stretch,
    font.unicodeRange,
  ]);
export type CompletedPaperPacket = {
  readonly format: "vivliostyle-completed-paper-v1";
  readonly compatibilityKey: string;
  readonly revision: number;
  readonly stylesheets: readonly string[];
  readonly loadedFontKeys: readonly string[];
  readonly resources?: readonly {
    url: string;
    mediaType: string;
    base64: string;
  }[];
  readonly rootAttributes: readonly [string, string][];
  readonly bodyAttributes: readonly [string, string][];
  readonly sources: readonly {
    url: string;
    html: string;
    signatures: Signatures;
    texts: SourceTextEntry[];
  }[];
  readonly pages: readonly {
    source: number;
    html: string;
    signatures?: Signatures;
    sourceMap: SerializedSourceFragment[];
    spineIndex: number;
    offset: number;
    side: string;
    ancestors: readonly {
      tag: string;
      attributes: readonly [string, string][];
    }[];
  }[];
};

/** Same-build trusted output only. No restart positions, counter or flow state.
 * CSS/resource isolation is supplied by the destination host, independently.
 */
export function serializeCompletedPaper(
  seed: PreviewSnapshotSeed | null,
  compatibilityKey: string,
): CompletedPaperPacket {
  if (!seed || !compatibilityKey || !Number.isSafeInteger(seed.clientRevision))
    throw new Error("A completed revision and compatibility key are required");
  const sources: CompletedPaperPacket["sources"][number][] = [];
  const pages: CompletedPaperPacket["pages"][number][] = [];
  let stylesheets: string[] = [];
  let loadedFontKeys: string[] = [];
  let rootAttributes: [string, string][] = [],
    bodyAttributes: [string, string][] = [];
  for (const [url, snapshot] of seed.snapshots) {
    const root = snapshot.source.xmldoc.document.documentElement;
    const paths = createSourcePathIndex(root);
    const source = sources.length;
    sources.push({
      url,
      html: root.outerHTML,
      signatures: nodesIn(root).map(nodeSignature),
      texts: exportSourceTexts(root),
    });
    for (const page of snapshot.pages) {
      if (!pages.length) {
        const document = page.container.ownerDocument;
        loadedFontKeys = Array.from(document.fonts)
          .filter((font) => font.status === "loaded")
          .map(completedFontKey);
        rootAttributes = Array.from(document.documentElement.attributes).map(
          (a) => [a.name, a.value],
        );
        bodyAttributes = Array.from(document.body.attributes).map((a) => [
          a.name,
          a.value,
        ]);
        const readSheet = (sheet: CSSStyleSheet): string =>
          Array.from(sheet.cssRules)
            .map((rule) => {
              if (rule.type === 3) {
                const imported = rule as CSSImportRule;
                if (
                  (
                    imported as CSSImportRule & {
                      layerName?: string;
                      supportsText?: string;
                    }
                  ).layerName != null ||
                  (imported as CSSImportRule & { supportsText?: string })
                    .supportsText
                )
                  throw new Error(
                    "Layered/conditional CSS imports need an explicit stylesheet snapshot",
                  );
                if (!imported.styleSheet)
                  throw new Error("Stylesheet import is not loaded");
                const text = readSheet(imported.styleSheet);
                return imported.media.mediaText
                  ? `@media ${imported.media.mediaText}{${text}}`
                  : text;
              }
              return rule.cssText.replace(
                /url\(\s*(["']?)(.*?)\1\s*\)/g,
                (_match, _quote, url) =>
                  `url(${JSON.stringify(url.startsWith("#") ? url : new URL(url, sheet.href || document.baseURI).href)})`,
              );
            })
            .join("\n");
        // Inaccessible stylesheets fail explicitly: an incomplete CSS snapshot is unsafe.
        stylesheets = [
          ...Array.from(document.styleSheets),
          ...document.adoptedStyleSheets,
        ]
          .filter((sheet) => !sheet.disabled)
          .map((sheet) => {
            const text = readSheet(sheet);
            return sheet.media.mediaText
              ? `@media ${sheet.media.mediaText}{${text}}`
              : text;
          });
      }
      const ancestors: CompletedPaperPacket["pages"][number]["ancestors"][number][] =
        [];
      for (
        let element = page.container.parentElement;
        element && element !== element.ownerDocument.body;
        element = element.parentElement
      )
        ancestors.unshift({
          tag: element.localName,
          attributes: Array.from(element.attributes).map((a) => [
            a.name,
            a.value,
          ]),
        });
      const sourceMap = exportSourceFragments(page.container, root, paths);
      pages.push({
        source,
        html: page.container.outerHTML,
        sourceMap,
        ...(sourceMap.length
          ? { signatures: nodesIn(page.container).map(nodeSignature) }
          : {}),
        spineIndex: page.spineIndex,
        offset: page.offset,
        side: page.side,
        ancestors,
      });
    }
  }
  if (!pages.length) throw new Error("No completed paper");
  return {
    format: "vivliostyle-completed-paper-v1",
    compatibilityKey,
    revision: seed.clientRevision,
    stylesheets,
    loadedFontKeys,
    rootAttributes,
    bodyAttributes,
    sources,
    pages,
  };
}

/** Owns reconstructed paper and its source identities; performs no typesetting.
 * The caller must use an isolated, fixed CSS/font/resource environment.
 * Retained units survive release of this document; their resource lease does too.
 */
export class CompletedPaperDocument {
  private papers: HTMLElement[] = [];
  private released = false;
  private releaseResources: (() => void) | null = null;
  readonly revision: number;

  constructor(
    packet: CompletedPaperPacket,
    document: Document,
    compatibilityKey: string,
    private readonly acquireResources: () => () => void = () => () => {},
  ) {
    if (
      packet.format !== "vivliostyle-completed-paper-v1" ||
      packet.compatibilityKey !== compatibilityKey ||
      !compatibilityKey ||
      !Number.isSafeInteger(packet.revision) ||
      !packet.sources?.length ||
      !packet.pages?.length
    )
      throw new Error("Invalid or incompatible completed paper");
    this.revision = packet.revision;
    const parser = new document.defaultView!.DOMParser();
    const roots = packet.sources.map((source) => {
      const root = parser.parseFromString(
        source.html,
        "text/html",
      ).documentElement;
      restorePortableSourceBoundaries(root, source.signatures);
      registerSourceTexts(root.ownerDocument, source.texts, packet.revision);
      return root;
    });
    this.papers = packet.pages.map((page) => {
      const template = document.createElement("template");
      template.innerHTML = page.html;
      const paper = template.content.firstElementChild as HTMLElement;
      if (
        !paper ||
        template.content.childElementCount !== 1 ||
        !roots[page.source]
      )
        throw new Error("Invalid completed page/source");
      if (page.signatures)
        restorePortableSourceBoundaries(paper, page.signatures);
      importSourceFragments(paper, roots[page.source], page.sourceMap);
      return paper;
    });
    this.releaseResources = acquireResources();
  }

  get pageCount(): number {
    this.assertLive();
    return this.papers.length;
  }

  retainPages(
    indices: readonly number[],
    document: Document,
  ): SourceMappedPresentation {
    this.assertLive();
    if (
      !indices.length ||
      indices.some(
        (i) => !Number.isSafeInteger(i) || i < 0 || i >= this.papers.length,
      )
    )
      throw new Error("Invalid completed page indices");
    return new SourceMappedPresentation(
      this.revision,
      indices[0],
      indices.map((i) => this.papers[i]),
      document,
      this.acquireResources,
    );
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.papers = [];
    this.releaseResources?.();
    this.releaseResources = null;
  }

  private assertLive(): void {
    if (this.released)
      throw new Error("CompletedPaperDocument has been released");
  }
}
