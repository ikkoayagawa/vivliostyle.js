// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
/**
 * Copyright 2015 Daishinsha Inc.
 * Copyright 2018 Vivliostyle Foundation
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview CoreViewer - Vivliostyle CoreViewer class
 */
import * as AdaptiveViewer from "./adaptive-viewer";
import * as Base from "./base";
import * as CmykStore from "./cmyk-store";
import * as Constants from "./constants";
import * as Epub from "./epub";
import * as OPS from "./ops";
import * as Profile from "./profile";
import * as Toc from "./toc";
import { ErrorInfo } from "./logging";
import { MemoryDocumentSource, prepareMemoryDocument } from "./memory-document";
import { SourceMappedPresentation } from "./source-presentation";
import { serializeCompletedPaper, type CompletedPaperPacket } from "./completed-paper";
import { registerSourceTexts } from "./source-map";
import {
  PortableSeedError,
  serializePortableSeed,
  restorePortableSeed,
  restorePortableSourceBoundaries,
  validatePortableSeed,
  type PortablePreviewSeed,
  type PortableSeedImportRequest,
} from "./portable-seed";

export type PortableSeedImportOptions = {
  /** Exact Core build + CSS/font/resource identity shared by producer and receiver. */
  compatibilityKey: string;
  documentOptions?: Pick<
    DocumentOptions,
    "fragment" | "authorStyleSheet" | "userStyleSheet" | "cmykReserveMapUrl"
  >;
  /** Default true. false retains the old one-page initialization for comparisons. */
  skipInitialPage?: boolean;
  signal?: AbortSignal;
  /** Defaults to 120 seconds. Must be finite and positive. */
  timeoutMs?: number;
};

export type PreviewResourceOptions = {
  signal?: AbortSignal;
  /** Defaults to 30 seconds; failed resources count as settled. */
  timeoutMs?: number;
  /** Wait for all completed paper, rather than just the selected page/spread. */
  complete?: boolean;
};

export type PortableSeedImportResult = {
  seed: AdaptiveViewer.PreviewSnapshotSeed;
  prepareMs: number;
  hydrateMs: number;
  initialPagesTypeset: number;
};

export interface Payload {
  /** Present on previewdisplay, after the latest edited page is visible. */
  revision?: number;
  reusedPages?: number;
  reusedPrefixPages?: number;
  reusedSuffixPages?: number;
  elapsedMs?: number;
  loadMs?: number;
  cacheMs?: number;
  editOffset?: number | null;
  cacheResults?: {
    url: string;
    pages: number;
    reason?: string;
    blockers?: string[];
  }[];
  type: string;
  internal: boolean;
  href: string;
  content: ErrorInfo;
  cfi: string;
  first: boolean;
  last: boolean;
  epage: number;
  epageCount: number;
  metadata: unknown;
  docTitle: string;
  fraction: number;
  pages: number;
  /** Display-intent generation echoed by focused speculative pagination. */
  displayIntent?: number;
  /** 0-indexed page selected by focused speculative pagination. */
  targetEpage?: number;
  /** Number of papers in the atomically published display unit. */
  paperCount?: number;
  /** Whether Core resolved the requested focused fragment before pagination. */
  targetResolved?: boolean;
  /** Elapsed time when a focused task reached its terminal boundary. */
  terminalMs?: number;
}

export type PaginationMode = "complete" | "target-display-unit";

const PageProgression = Constants.PageProgression;

/**
 * Viewer settings that must be passed to Viewer's constructor.
 * - userAgentRootURL: URL of a directory from which viewer resource files
 *   (under resources/ directory in the source repository) are served.
 * - viewportElement: An element used as the viewport of the displayed contents.
 * - window: Window object. If omitted, current `window` is used.
 * - debug: Debug flag.
 */
export type CoreViewerSettings = {
  userAgentRootURL?: string;
  viewportElement: HTMLElement;
  window?: Window;
  debug?: boolean;
};

/**
 * Viewer options that can be set after the Viewer object is constructed.
 * - autoResize: Run layout again when the window is resized. default: true
 * - fontSize: Default font size (px). default: 16
 * - pageBorderWidth: Width of a border between two pages in a single
 *   spread (px). Effective only in spread view mode. default: 1
 * - renderAllPages: Render all pages at the document load time. default: true
 * - pageViewMode: Page view mode (singlePage / spread / autoSpread).
 *   default: singlePage
 * - zoom: Zoom factor with which pages are displayed. default: 1
 * - fitToScreen: Auto adjust zoom factor to fit the screen. default: false
 * - defaultPaperSize: Default paper size in px. Effective when `@page` size
 *   is set to auto. default: undefined (means the windows size is used as
 *   paper size).
 * - allowScripts: Allow JavaScript in documents. default: true
 * - pixelRatio: Set output pixel ratio. Enables very thin border width and
 *   improves layout precision, emulating high pixel ratio.
 *   default: 8. Set 0 to disable pixel ratio emulation.
 */
export type CoreViewerOptions = {
  autoResize?: boolean;
  fontSize?: number;
  pageBorderWidth?: number;
  renderAllPages?: boolean;
  /** Paint emphasis outside line boxes for interactive preview. Default: false. */
  fixedEmphasisLeading?: boolean;
  pageViewMode?: AdaptiveViewer.PageViewMode;
  zoom?: number;
  fitToScreen?: boolean;
  defaultPaperSize?: { width: number; height: number };
  allowScripts?: boolean;
  pixelRatio?: number;
  /** Explicit focused-pagination contract; does not change renderAllPages semantics. */
  paginationMode?: PaginationMode;
  /** Client-owned navigation/display generation for focused results. */
  displayIntent?: number;
};

function getDefaultViewerOptions(): CoreViewerOptions {
  return {
    autoResize: true,
    fontSize: 16,
    pageBorderWidth: 1,
    renderAllPages: true,
    fixedEmphasisLeading: false,
    pageViewMode: AdaptiveViewer.PageViewMode.AUTO_SPREAD,
    zoom: 1,
    fitToScreen: false,
    defaultPaperSize: undefined,
    allowScripts: true,
    pixelRatio: 8,
    paginationMode: "complete",
    displayIntent: 0,
  };
}

function convertViewerOptions(options: CoreViewerOptions): object {
  const converted = {};
  Object.keys(options).forEach((key) => {
    const v = options[key];
    switch (key) {
      case "autoResize":
        converted["autoresize"] = v;
        break;
      case "pageBorderWidth":
        converted["pageBorder"] = v;
        break;
      default:
        converted[key] = v;
    }
  });
  return converted;
}

/**
 * Options for the displayed document.
 * - documentObject: Document object for the document. If provided, it is used
 *   directly without parsing the source again.
 * - fragment: Fragmentation identifier (EPUB CFI) of the location in the
 *   document which is to be displayed.
 * - authorStyleSheet: An array of author style sheets to be injected after all
 *   author style sheets referenced from the document. A single stylesheet may
 *   be a URL of the style sheet or a text content of the style sheet.
 * - userStyleSheet: An array of user style sheets to be injected.
 *   A single stylesheet may be a URL of the style sheet or a text content of
 *   the style sheet.
 */
export type DocumentOptions = {
  documentObject?: Document;
  /** Client-owned generation echoed on asynchronous viewer events. */
  clientRevision?: number;
  fragment?: string;
  authorStyleSheet?: { url?: string; text?: string }[];
  userStyleSheet?: { url?: string; text?: string }[];
  cmykReserveMapUrl?: string;
  /** Internal preview-cache baseline supplied by another isolated CoreViewer. */
  previewSnapshotSeed?: AdaptiveViewer.PreviewSnapshotSeed;
  /** Allow incremental page reuse from previewSnapshotSeed on an initial load. */
  reusePages?: boolean;
  /** Focused paper selection, independent of pageViewMode and layout preferences.
   * Effective only with paginationMode: "target-display-unit". */
  focusedDisplayMode?: "singlePage" | "spread";
};

/**
 * Options for a single source document.
 * - url: URL of the document.
 * - startPage: If specified, the `page` page-based counter is set to the
 *   specified value on the first page of the document. It is equivalent to
 *   specifying `counter-reset: page [specified value - 1]` on that page.
 * - skipPagesBefore: If specified, the `page` page-based counter is
 *   incremented by the specified value *before* updating page-based counters
 *   on the first page of the document.
 *   This option is ignored if `startPageNumber` option is also specified.
 */
export type SingleDocumentOptions =
  | string
  | {
      url: string;
      startPage?: number;
      skipPagesBefore?: number;
    };

/**
 * Vivliostyle Viewer class.
 */
export class CoreViewer {
  private lastLoadCommand: Base.JSON | null = null;
  private memoryObjectURLs: string[] = [];
  private readonly memoryResourceLeases = new Map<string, number>();
  private readonly deferredResourceReleases = new Set<string>();
  private cancelPortableImport: ((error: Error) => void) | null = null;
  private previewResourceEpoch = 0;
  private importedPortableSeed: AdaptiveViewer.PreviewSnapshotSeed | null =
    null;

  private assertMutablePortableViewer(): void {
    if (this.cancelPortableImport || this.importedPortableSeed)
      throw new PortableSeedError(
        "ownership",
        "A portable seed donor cannot be reloaded or reconfigured; use a separate viewer",
      );
  }

  /** Export a detached, structured-cloneable, fully committed body-flow seed. */
  exportCommittedSeed(compatibilityKey: string): PortablePreviewSeed {
    const seed = this.importedPortableSeed || this.getCommittedPreviewSnapshotSeed();
    this.assertSnapshotResourcesReady(seed);
    return serializePortableSeed(
      seed,
      compatibilityKey,
    );
  }

  /** Check a packet against this donor without modifying its source or pages. */
  validateCommittedSeed(
    payload: PortablePreviewSeed,
    compatibilityKey: string,
  ): void {
    restorePortableSeed(
      this.adaptViewer_.opfView,
      this.settings.window || window,
      payload,
      compatibilityKey,
      false,
    );
  }

  /** Import into a new, dedicated donor viewer. Source/CSS/fonts are initialized,
   * but the default path does not typeset any pages. Keep this viewer and its
   * resources alive until all consumers of the returned seed are finished.
   * Transport and choosing when to import remain the caller's responsibility.
   */
  importCommittedSeed(
    payload: PortablePreviewSeed,
    options: PortableSeedImportOptions,
  ): Promise<PortableSeedImportResult> {
    return new Promise((resolve, reject) => {
      validatePortableSeed(payload, options?.compatibilityKey);
      if (this.initialized || this.cancelPortableImport)
        throw new PortableSeedError(
          "ownership",
          "Portable import requires a new dedicated viewer",
        );
      const timeoutMs = options.timeoutMs ?? 120000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new PortableSeedError(
          "options",
          "Invalid portable import timeout",
        );
      if (options.signal?.aborted)
        throw new DOMException("Portable import aborted", "AbortError");
      const win = this.settings.window || window;
      let restored: Omit<
        PortableSeedImportResult,
        "initialPagesTypeset"
      > | null = null;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("focusedterminal", onDone);
        options.signal?.removeEventListener("abort", onAbort);
        this.cancelPortableImport = null;
        // Do not retain a completed packet/callback in a reusable load command.
        if (this.lastLoadCommand)
          this.lastLoadCommand["portableSeedImport"] = undefined;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.adaptViewer_.supersedePreviewUpdate();
        reject(error);
      };
      const onAbort = () =>
        fail(new DOMException("Portable import aborted", "AbortError"));
      const onDone = (event: Payload) => {
        if (event.revision !== payload.clientRevision || settled) return;
        if (!restored || !this.getCurrentPreviewDisplayUnit()) {
          fail(
            new PortableSeedError(
              "display",
              "Imported display unit did not become ready",
            ),
          );
          return;
        }
        settled = true;
        this.importedPortableSeed = restored.seed;
        const result = {
          ...restored,
          initialPagesTypeset: this.adaptViewer_.opfView.typesetPageCount,
        };
        cleanup();
        resolve(result);
      };
      this.cancelPortableImport = fail;
      this.addListener("focusedterminal", onDone);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () =>
          fail(new PortableSeedError("timeout", "Portable import timed out")),
        timeoutMs,
      );
      try {
        const saved = payload.snapshots[0];
        const source = prepareMemoryDocument(
          {
            url: saved.url,
            html: saved.sourceHtml,
            revision: payload.clientRevision,
            resources: [],
          },
          win,
        );
        if (saved.hasSplitTextNodes)
          restorePortableSourceBoundaries(
            source.document.documentElement,
            saved.nodeSignatures,
          );
        if (saved.sourceTexts)
          registerSourceTexts(
            source.document,
            saved.sourceTexts,
            payload.clientRevision,
          );
        this.memoryObjectURLs.push(...source.objectURLs);
        this.loadDocumentOrPublication(
          saved.url,
          null,
          {
            ...options.documentOptions,
            documentObject: source.document,
            clientRevision: payload.clientRevision,
          },
          {
            autoResize: false,
            allowScripts: false,
            renderAllPages: false,
            paginationMode: "target-display-unit",
            pageViewMode: AdaptiveViewer.PageViewMode.SINGLE_PAGE,
          },
          {
            payload,
            compatibilityKey: options.compatibilityKey,
            skipInitialPage: options.skipInitialPage !== false,
            onRestored: (seed, prepareMs, hydrateMs) => {
              restored = { seed, prepareMs, hydrateMs };
            },
            onFailed: fail,
          },
        );
      } catch (error) {
        fail(error as Error);
      }
    });
  }

  /** Supersede an editing update without waiting for background pagination. */
  cancelPreviewUpdate(): void {
    if (this.cancelPortableImport) {
      this.cancelPortableImport(
        new DOMException("Portable import canceled", "AbortError"),
      );
      return;
    }
    this.adaptViewer_.supersedePreviewUpdate();
  }

  /** Reload the current source, retaining the viewer and prioritizing its location.
   * reusePages is only valid for manuscript-only updates with unchanged resources.
   */
  refreshDocument(
    options: {
      reusePages?: boolean;
      changedUrls?: string[];
      clientRevision?: number;
      fragment?: string | null;
    } = {},
  ): void {
    this.assertMutablePortableViewer();
    if (!this.lastLoadCommand) return;
    const revision = this.adaptViewer_.supersedePreviewUpdate();
    this.adaptViewer_.sendCommand({
      ...this.lastLoadCommand,
      ...convertViewerOptions(this.options),
      fragment: options.fragment ?? null,
      previewRevision: revision,
      previewClientRevision: options.clientRevision,
      reusePages: !!options.reusePages,
      previewChangedUrls: options.changedUrls || [],
    });
  }
  private initialized: boolean = false;
  private adaptViewer_: AdaptiveViewer.AdaptiveViewer;
  private options: CoreViewerOptions;
  private eventTarget: Base.SimpleEventTarget;
  // installed via Object.defineProperty in the constructor
  declare readyState: Constants.ReadyState;

  constructor(
    private readonly settings: CoreViewerSettings,
    opt_options?: CoreViewerOptions,
  ) {
    Constants.setDebug(!!settings.debug);
    this.adaptViewer_ = new AdaptiveViewer.AdaptiveViewer(
      settings["window"] || window,
      settings["viewportElement"],
      "main",
      this.dispatcher.bind(this),
    );
    this.options = getDefaultViewerOptions();
    if (opt_options) {
      this.setOptions(opt_options);
    }
    this.eventTarget = new Base.SimpleEventTarget();
    Object.defineProperty(this, "readyState", {
      get() {
        return this.adaptViewer_.readyState;
      },
    });
  }

  /**
   * Set ViewerOptions to the viewer.
   */
  setOptions(options: CoreViewerOptions) {
    this.assertMutablePortableViewer();
    const command = Object.assign(
      { a: "configure" },
      convertViewerOptions(options),
    );
    this.adaptViewer_.sendCommand(command);
    Object.assign(this.options, options);
  }

  private dispatcher(msg: Base.JSON) {
    /** @dict */
    const event = { type: msg["t"] };
    const o = msg as object;
    Object.keys(o).forEach((key) => {
      if (key !== "t") {
        event[key] = o[key];
      }
    });
    this.eventTarget.dispatchEvent(event);
  }

  /**
   * Add a listener function, which is invoked when the specified type of event
   * is dispatched.
   * @param type Event type.
   * @param listener Listener function.
   */
  addListener(type: string, listener: (payload: Payload) => void) {
    if (type === "paginationprogress") {
      this.adaptViewer_.ensurePaginationProgressListener();
    }
    this.eventTarget.addEventListener(
      type,
      listener as Base.EventListener,
      false,
    );
  }

  /**
   * Remove an event listener.
   * @param type Event type.
   * @param listener Listener function.
   */
  removeListener(type: string, listener: (payload: Payload) => void) {
    this.eventTarget.removeEventListener(
      type,
      listener as Base.EventListener,
      false,
    );
    if (
      type === "paginationprogress" &&
      !this.eventTarget.listeners[type]?.length
    ) {
      this.adaptViewer_.removePaginationProgressListener();
    }
  }

  /**
   * Load an HTML or XML document(s).
   */
  loadDocument(
    singleDocumentOptions: SingleDocumentOptions | SingleDocumentOptions[],
    opt_documentOptions?: DocumentOptions,
    opt_viewerOptions?: CoreViewerOptions,
  ) {
    if (
      !singleDocumentOptions ||
      (Array.isArray(singleDocumentOptions)
        ? !singleDocumentOptions[0] ||
          (typeof singleDocumentOptions[0] !== "string" &&
            !singleDocumentOptions[0].url)
        : typeof singleDocumentOptions !== "string" &&
          !singleDocumentOptions.url)
    ) {
      this.eventTarget.dispatchEvent({
        type: "error",
        content: { error: new Error("No URL specified") },
      });
      return;
    }
    this.loadDocumentOrPublication(
      singleDocumentOptions,
      null,
      opt_documentOptions,
      opt_viewerOptions,
    );
  }

  /** Load HTML and its declared resources without fetching the HTML itself. */
  loadMemoryDocument(
    source: MemoryDocumentSource,
    opt_documentOptions?: Omit<DocumentOptions, "documentObject">,
    opt_viewerOptions?: CoreViewerOptions,
  ): void {
    this.assertMutablePortableViewer();
    const prepared = prepareMemoryDocument(
      source,
      this.settings.window || window,
    );
    this.memoryObjectURLs.push(...prepared.objectURLs);
    this.loadDocument(
      source.url,
      {
        ...opt_documentOptions,
        documentObject: prepared.document,
        clientRevision: source.revision,
      },
      opt_viewerOptions,
    );
  }

  /** Replace the current in-memory HTML and run the normal preview refresh. */
  refreshMemoryDocument(
    source: MemoryDocumentSource,
    options: {
      reusePages?: boolean;
      changedUrls?: string[];
      fragment?: string | null;
    } = {},
  ): void {
    this.assertMutablePortableViewer();
    if (!this.lastLoadCommand) {
      this.loadMemoryDocument(source);
      return;
    }
    const prepared = prepareMemoryDocument(
      source,
      this.settings.window || window,
    );
    this.memoryObjectURLs.push(...prepared.objectURLs);
    this.lastLoadCommand = {
      ...this.lastLoadCommand,
      url: convertSingleDocumentOptions(source.url),
      document: prepared.document,
      previewClientRevision: source.revision,
      // A fork seed is consumed only by the first isolated load. Subsequent
      // refreshes must reuse this viewer's own last successfully terminated
      // focused result rather than repeatedly going back to the old commit.
      previewSnapshotSeed: undefined,
    };
    this.refreshDocument({ ...options, clientRevision: source.revision });
  }

  /** Revoke blob URLs retained by in-memory resources when the viewer is done. */
  disposeMemoryResources(): void {
    this.adaptViewer_.disposeRepeatingElementIndexes();
    this.previewResourceEpoch++;
    this.cancelPortableImport?.(
      new DOMException("Portable import disposed", "AbortError"),
    );
    const resourceURL = (
      (this.settings.window || window) as unknown as { URL: typeof URL }
    ).URL;
    for (const url of this.memoryObjectURLs.splice(0))
      if (this.memoryResourceLeases.has(url))
        this.deferredResourceReleases.add(url);
      else resourceURL.revokeObjectURL(url);
  }

  /**
   * Load an EPUB/WebPub publication.
   */
  loadPublication(
    pubUrl: string,
    opt_documentOptions?: DocumentOptions,
    opt_viewerOptions?: CoreViewerOptions,
  ) {
    if (!pubUrl) {
      this.eventTarget.dispatchEvent({
        type: "error",
        content: { error: new Error("No URL specified") },
      });
      return;
    }
    this.loadDocumentOrPublication(
      null,
      pubUrl,
      opt_documentOptions,
      opt_viewerOptions,
    );
  }

  /**
   * Load an HTML or XML document, or an EPUB/WebPub publication.
   */
  private loadDocumentOrPublication(
    singleDocumentOptions:
      SingleDocumentOptions | SingleDocumentOptions[] | null,
    pubUrl: string | null,
    opt_documentOptions?: DocumentOptions,
    opt_viewerOptions?: CoreViewerOptions,
    portableSeedImport?: PortableSeedImportRequest,
  ) {
    if (!portableSeedImport) this.assertMutablePortableViewer();
    const documentOptions = opt_documentOptions || {};

    function convertStyleSheetArray(
      arr?: { url?: string; text?: string }[],
    ): OPS.StyleSheetParam[] | undefined {
      if (arr) {
        return arr.flatMap((s): OPS.StyleSheetParam[] => {
          const url = s.url || null;
          const text = s.text || null;
          // An entry with neither url nor text names no style sheet to read.
          return text !== null
            ? [{ url, text }]
            : url !== null
              ? [{ url }]
              : [];
        });
      } else {
        return undefined;
      }
    }
    const authorStyleSheet = convertStyleSheetArray(
      documentOptions["authorStyleSheet"],
    );
    const userStyleSheet = convertStyleSheetArray(
      documentOptions["userStyleSheet"],
    );
    if (opt_viewerOptions) {
      Object.assign(this.options, opt_viewerOptions);
    }
    const command = Object.assign(
      {
        a: singleDocumentOptions ? "loadXML" : "loadPublication",
        userAgentRootURL: this.settings["userAgentRootURL"],
        url: convertSingleDocumentOptions(singleDocumentOptions) || pubUrl,
        document: documentOptions["documentObject"],
        fragment: documentOptions["fragment"],
        authorStyleSheet: authorStyleSheet,
        userStyleSheet: userStyleSheet,
        cmykReserveMapUrl: documentOptions["cmykReserveMapUrl"],
        previewSnapshotSeed: documentOptions["previewSnapshotSeed"],
        reusePages: !!documentOptions["reusePages"],
        focusedDisplayMode: documentOptions["focusedDisplayMode"],
        portableSeedImport,
      },
      convertViewerOptions(this.options),
    );
    if (typeof documentOptions.clientRevision === "number") {
      command["previewRevision"] = this.adaptViewer_.supersedePreviewUpdate();
      command["previewClientRevision"] = documentOptions.clientRevision;
    }
    this.lastLoadCommand = command;
    if (this.initialized) {
      this.adaptViewer_.sendCommand(command);
    } else {
      this.initialized = true;
      this.adaptViewer_.initEmbed(command);
    }
  }

  /**
   * Returns the current page progression of the viewer. If no document is
   * loaded, returns null.
   */
  getCurrentPageProgression(): Constants.PageProgression | null {
    return this.adaptViewer_.getCurrentPageProgression();
  }

  private resolveNavigation(nav: Navigation): Navigation {
    switch (nav) {
      case Navigation.LEFT:
        return this.getCurrentPageProgression() === PageProgression.LTR
          ? Navigation.PREVIOUS
          : Navigation.NEXT;
      case Navigation.RIGHT:
        return this.getCurrentPageProgression() === PageProgression.LTR
          ? Navigation.NEXT
          : Navigation.PREVIOUS;
      default:
        return nav;
    }
  }

  /**
   * Navigate to the specified page.
   */
  navigateToPage(nav: Navigation, opt_epage?: number) {
    if (nav === Navigation.EPAGE) {
      this.adaptViewer_.sendCommand({
        a: "moveTo",
        epage: opt_epage,
      });
    } else {
      this.adaptViewer_.sendCommand({
        a: "moveTo",
        where: this.resolveNavigation(nav),
      });
    }
  }

  /**
   * Navigate to the specified internal URL.
   */
  navigateToInternalUrl(url: string) {
    this.adaptViewer_.sendCommand({ a: "moveTo", url: url });
  }

  /**
   * Navigate to the specified position.
   */
  navigateToPosition(position: {
    spineIndex: number;
    pageIndex?: number;
    offsetInItem?: number;
  }) {
    this.adaptViewer_.sendCommand({
      a: "moveTo",
      position: {
        spineIndex: position.spineIndex,
        pageIndex: position.pageIndex ?? -1,
        offsetInItem: position.offsetInItem ?? -1,
      },
    });
  }

  /**
   * @returns True if TOC is visible, false if hidden, null if TOC is unavailable
   */
  isTOCVisible(): boolean | null {
    if (
      this.adaptViewer_.opfView &&
      this.adaptViewer_.opfView.opf &&
      this.adaptViewer_.opfView.opf.toc
    ) {
      return !!this.adaptViewer_.opfView.isTOCVisible();
    } else {
      return null;
    }
  }

  /**
   * Show or hide TOC box
   * @param opt_autohide If true, automatically hide when click TOC item
   * @param opt_show If true show TOC, false hide TOC. If null or undefined toggle TOC.
   */
  showTOC(opt_show?: boolean | null, opt_autohide?: boolean) {
    const visibility = opt_show == null ? "toggle" : opt_show ? "show" : "hide";
    this.adaptViewer_.sendCommand({
      a: "toc",
      v: visibility,
      autohide: opt_autohide,
    });
  }

  /**
   * Returns zoom factor corresponding to the specified zoom type.
   */
  queryZoomFactor(type: AdaptiveViewer.ZoomType): number {
    return this.adaptViewer_.queryZoomFactor(type);
  }

  getPageSizes(): { width: number; height: number }[] {
    return this.adaptViewer_.pageSizes;
  }

  /**
   * Returns the current structure of the TOC once it has
   * been shown, or the empty array if there is no TOC.
   */
  getTOC(): Toc.TOCItem[] {
    return this.adaptViewer_.opfView?.tocView?.getTOC() ?? [];
  }

  /**
   * Returns metadata for the publication. Metadata is
   * organized as an object of fully-qualified IRI properties
   * containing arrays of metadata entries. The first element
   * in the array is primary and should be used by default. Other
   * entries may overload or refine that metadata.
   */
  getMetadata(): Epub.Meta {
    return this.adaptViewer_.opf.getMetadata();
  }

  /**
   * Returns the cover for an EPUB publication, if specified.
   */
  getCover(): Epub.OPFItem | null {
    return this.adaptViewer_.opf.cover;
  }

  /**
   * Get the CMYK mapping for device-cmyk() colors used in the document.
   */
  getCmykMap(): Record<string, CmykStore.CMYKValueJSON> {
    const opfView = this.adaptViewer_?.opfView;
    if (!opfView?.cmykStore) {
      return {};
    }
    return opfView.cmykStore.toJSON();
  }

  /**
   * Returns the DOM container element for the page at the given epage
   * (0-indexed). Searches currently laid-out pages first, then suffix
   * convergence candidates, then the snapshot of the previous revision.
   * Returns null when no container is available (e.g. before the first render).
   *
   * Intended for preview clients that need to display a live or historical
   * page container while a re-render is in progress.
   */
  getPageContainerForEpage(epage: number): HTMLElement | null {
    return this.adaptViewer_.getPageContainerForEpage(epage);
  }

  /** Return a page from the last fully committed client revision. */
  getLatestCommittedPageContainerForEpage(epage: number): HTMLElement | null {
    return this.adaptViewer_.getLatestCommittedPageContainerForEpage(epage);
  }

  /** Return a cache seed that another isolated preview viewer can safely fork. */
  getCommittedPreviewSnapshotSeed(): AdaptiveViewer.PreviewSnapshotSeed | null {
    return this.adaptViewer_.getCommittedPreviewSnapshotSeed();
  }

  /** Export completed paper even when restart-seed features are unsupported.
   * The receiver supplies the immutable stylesheet/resource environment.
   */
  exportCompletedPaper(compatibilityKey: string): CompletedPaperPacket {
    const seed = this.getCommittedPreviewSnapshotSeed();
    this.assertSnapshotResourcesReady(seed);
    return serializeCompletedPaper(seed, compatibilityKey);
  }

  /** Snapshot memory assets while leasing their donor URLs. External network
   * assets must already be supplied as MemoryDocument resources by the caller.
   */
  async exportCompletedPaperWithResources(compatibilityKey: string): Promise<CompletedPaperPacket> {
    const epoch = this.previewResourceEpoch;
    const seed = this.getCommittedPreviewSnapshotSeed();
    await this.waitForPreviewResources({ complete: true });
    if (this.previewResourceEpoch !== epoch || this.getCommittedPreviewSnapshotSeed()?.snapshots !== seed?.snapshots)
      throw new DOMException("Completed paper changed", "AbortError");
    const paper = this.exportCompletedPaper(compatibilityKey);
    const lease = this.retainPreviewDisplayUnit();
    if (!lease) throw new Error("No completed display unit to lease");
    const urls = [...this.memoryObjectURLs];
    const targetWindow = this.settings.window || window;
    try {
      const resources = await Promise.all(urls.map(async url => {
        const response = await targetWindow.fetch(url);
        if (!response.ok) throw new Error("Completed paper resource is unavailable");
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let start=0; start<bytes.length; start+=16384)
          binary += String.fromCharCode(...bytes.subarray(start,start+16384));
        return {url, mediaType:blob.type, base64:targetWindow.btoa(binary)};
      }));
      return {...paper,resources};
    } finally { lease.release(); }
  }

  /** Clone a complete committed cache into this viewer's document. */
  preparePreviewSnapshotSeed(
    seed: AdaptiveViewer.PreviewSnapshotSeed,
  ): AdaptiveViewer.PreviewSnapshotSeed {
    this.assertSnapshotResourcesReady(seed);
    return this.adaptViewer_.preparePreviewSnapshotSeed(seed);
  }

  private assertSnapshotResourcesReady(seed: AdaptiveViewer.PreviewSnapshotSeed | null): void {
    if (seed && [...seed.snapshots.values()].some((snapshot) => snapshot.pages.some((page) =>
        page.fetchers.some((fetcher) => !fetcher.hasArrived()))))
      throw new Error("Preview resources are pending; call waitForPreviewResources({ complete: true }) before copying paper");
  }

  /** Display a working or committed page/spread while preview layout runs. */
  showPreviewPageForEpage(
    epage: number,
    options: { zoom?: number; pageViewMode?: AdaptiveViewer.PageViewMode } = {},
  ) {
    return this.adaptViewer_.showPreviewPageForEpage(epage, options);
  }

  /** Return the page/spread selected by a completed focused layout. */
  getCurrentPreviewDisplayUnit() {
    return this.adaptViewer_.getCurrentPreviewDisplayUnit();
  }

  /** Retain the completed current unit and its matching source correspondence.
   * CSS isolation in the destination document is the caller's responsibility.
   */
  retainPreviewDisplayUnit(
    document = (this.settings.window || window).document,
  ): SourceMappedPresentation | null {
    const unit = this.getCurrentPreviewDisplayUnit();
    if (!unit) return null;
    if (!unit.resourcesReady)
      throw new Error("Preview resources are pending; use retainPreviewDisplayUnitAsync");
    const urls = [...this.memoryObjectURLs];
    const resourceURL = (
      (this.settings.window || window) as unknown as { URL: typeof URL }
    ).URL;
    const acquire = () => {
      urls.forEach((url) =>
        this.memoryResourceLeases.set(
          url,
          (this.memoryResourceLeases.get(url) ?? 0) + 1,
        ),
      );
      return () =>
        urls.forEach((url) => {
          const remaining = (this.memoryResourceLeases.get(url) ?? 1) - 1;
          if (remaining) this.memoryResourceLeases.set(url, remaining);
          else {
            this.memoryResourceLeases.delete(url);
            if (this.deferredResourceReleases.delete(url))
              resourceURL.revokeObjectURL(url);
          }
        });
    };
    return new SourceMappedPresentation(
      unit.revision,
      unit.epage,
      unit.containers,
      document,
      acquire,
    );
  }

  /** Wait without freezing an image before Core assigns its source URL.
   * Cancellation, supersession and a bounded timeout release the wait. Resource
   * load failures settle normally, preserving the browser's failed-image state.
   */
  async waitForPreviewResources(options: PreviewResourceOptions = {}): Promise<void> {
    const resourceEpoch = this.previewResourceEpoch;
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("Invalid preview resource timeout");
    const initial = this.getCurrentPreviewDisplayUnit();
    if (!initial) throw new Error("No current preview display unit");
    const seed = options.complete ? this.getCommittedPreviewSnapshotSeed() : null;
    if (options.complete && !seed) throw new Error("No completed paper");
    const deadline = performance.now() + timeoutMs;
    while (true) {
      if (options.signal?.aborted) throw new DOMException("Preview resource wait aborted", "AbortError");
      const current = this.getCurrentPreviewDisplayUnit();
      if (this.previewResourceEpoch !== resourceEpoch || !current || current.generation !== initial.generation ||
          (options.complete && this.getCommittedPreviewSnapshotSeed()?.snapshots !== seed.snapshots) ||
          (!options.complete && (current.containers.length !== initial.containers.length ||
            current.containers.some((container, i) => container !== initial.containers[i]))))
        throw new DOMException("Preview display unit changed", "AbortError");
      const ready = options.complete
        ? [...seed.snapshots.values()].every((snapshot) => snapshot.pages.every((page) =>
            page.fetchers.every((fetcher) => fetcher.hasArrived())))
        : current.resourcesReady;
      if (ready) return;
      if (performance.now() >= deadline) throw new Error("Preview resource wait timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Safe asynchronous alternative to the synchronous ready-only clone API. */
  async retainPreviewDisplayUnitAsync(
    document = (this.settings.window || window).document,
    options: Omit<PreviewResourceOptions, "complete"> = {},
  ): Promise<SourceMappedPresentation | null> {
    const resourceEpoch = this.previewResourceEpoch;
    const initial = this.getCurrentPreviewDisplayUnit();
    if (!initial) return null;
    await this.waitForPreviewResources(options);
    const current = this.getCurrentPreviewDisplayUnit();
    if (this.previewResourceEpoch !== resourceEpoch || !current || current.generation !== initial.generation ||
        current.containers.length !== initial.containers.length ||
        current.containers.some((container, i) => container !== initial.containers[i]))
      throw new DOMException("Preview display unit changed", "AbortError");
    return this.retainPreviewDisplayUnit(document);
  }

  /** Return a page only when the caller's committed revision still matches. */
  getCommittedPageContainerForEpage(
    epage: number,
    clientRevision: number,
  ): HTMLElement | null {
    return this.adaptViewer_.getCommittedPageContainerForEpage(
      epage,
      clientRevision,
    );
  }

  /**
   * Returns the 0-indexed epage of the page that contains the given source
   * offset within the spine item identified by url. The offset is the
   * character position within the spine item's source document (as set on
   * Vtree.Page.offset during layout).
   *
   * The search is performed over currently laid-out pages in spineItems. If
   * the target offset has not yet been laid out (e.g. during an incremental
   * update that has not reached the target page), returns null.
   *
   * Intended for preview clients that need to navigate to the page containing
   * a specific source location (e.g. the editor cursor position) without
   * inserting anchor elements into the HTML.
   */
  getEpageForSourceOffset(url: string, offset: number): number | null {
    return this.adaptViewer_.getEpageForSourceOffset(url, offset);
  }
}

function convertSingleDocumentOptions(
  singleDocumentOptions: SingleDocumentOptions | SingleDocumentOptions[] | null,
): AdaptiveViewer.SingleDocumentParam[] | null {
  function toNumberOrNull(num: any): number | null {
    return typeof num === "number" ? num : null;
  }

  function convert(opt) {
    if (typeof opt === "string") {
      return {
        url: opt,
        startPage: null,
        skipPagesBefore: null,
      } as AdaptiveViewer.SingleDocumentParam;
    } else {
      return {
        url: opt["url"],
        startPage: toNumberOrNull(opt["startPage"]),
        skipPagesBefore: toNumberOrNull(opt["skipPagesBefore"]),
      } as AdaptiveViewer.SingleDocumentParam;
    }
  }
  if (Array.isArray(singleDocumentOptions)) {
    return singleDocumentOptions.map(convert);
  } else if (singleDocumentOptions) {
    return [convert(singleDocumentOptions)];
  } else {
    return null;
  }
}

/**
 * @enum {string}
 */
export enum Navigation {
  PREVIOUS = "previous",
  NEXT = "next",
  LEFT = "left",
  RIGHT = "right",
  FIRST = "first",
  LAST = "last",
  EPAGE = "epage",
}

export type ZoomType = AdaptiveViewer.ZoomType;
export const ZoomType = AdaptiveViewer.ZoomType; // eslint-disable-line no-redeclare

export type PageViewMode = AdaptiveViewer.PageViewMode;
export const PageViewMode = AdaptiveViewer.PageViewMode; // eslint-disable-line no-redeclare

Profile.profiler.forceRegisterEndTiming("load_vivliostyle");
