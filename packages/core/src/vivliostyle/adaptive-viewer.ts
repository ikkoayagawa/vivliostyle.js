// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
/**
 * Copyright 2013 Google, Inc.
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
 * @fileoverview AdaptiveViewer - Viewer implementation.
 */
import * as Asserts from "./asserts";
import * as Base from "./base";
import * as CmykStore from "./cmyk-store";
import * as Constants from "./constants";
import * as Epub from "./epub";
import * as Exprs from "./exprs";
import * as Font from "./font";
import * as Logging from "./logging";
import * as OPS from "./ops";
import * as Plugin from "./plugin";
import {
  PreviewSnapshot,
  clonePreviewSnapshotEagerlyForDocument,
  clonePreviewSnapshotForDocument,
  editedTextOffset,
} from "./preview-cache";
import * as Profile from "./profile";
import * as Scripts from "./scripts";
import * as Task from "./task";
import * as TaskUtil from "./task-util";
import * as Vgen from "./vgen";
import * as Vtree from "./vtree";
import * as XmlDoc from "./xml-doc";
import {
  VivliostylePolyfillCss,
  VivliostyleViewportCss,
  VivliostyleViewportScreenCss,
} from "./assets";

export type Action = (p1: Base.JSON) => Task.Result<boolean>;

export type ViewportSize = {
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  width: number;
  height: number;
};

export const VIEWPORT_STATUS_ATTRIBUTE = "data-vivliostyle-viewer-status";

export const VIEWPORT_SPREAD_VIEW_ATTRIBUTE = "data-vivliostyle-spread-view";

/**
 * @enum {string}
 */
export enum PageViewMode {
  SINGLE_PAGE = "singlePage",
  SPREAD = "spread",
  AUTO_SPREAD = "autoSpread",
}

export type SingleDocumentParam = {
  url: string;
  startPage: number | null;
  skipPagesBefore: number | null;
};

/** State whose lifetime is limited to one incremental preview update. */
class PreviewSession {
  readonly revision: number;
  readonly clientRevision: number;
  readonly reusePages: boolean;
  readonly changedUrls: string[];
  readonly started: number;
  readonly paginationMode: "complete" | "target-display-unit";
  readonly displayIntent: number;
  readonly snapshots = new Map<string, PreviewSnapshot>();
  readonly sources = new Map<string, XmlDoc.XMLDocHolder>();
  styles: { [key: string]: OPS.Style } = {};
  loadMs = 0;
  editOffset: number | null = null;
  commandTask: Task.Task | null = null;
  pendingPosition: Epub.Position | null = null;
  pendingNavigationRevision = 0;
  targetResolved = false;
  canceled = false;

  constructor(command: Base.JSON, started: number) {
    this.revision = command["previewRevision"] as number;
    this.clientRevision =
      typeof command["previewClientRevision"] === "number"
        ? (command["previewClientRevision"] as number)
        : this.revision;
    this.reusePages = !!command["reusePages"] && !command["renderAllPages"];
    this.changedUrls = (command["previewChangedUrls"] as string[]) || [];
    this.started = started;
    this.paginationMode =
      command["paginationMode"] === "target-display-unit"
        ? "target-display-unit"
        : "complete";
    this.displayIntent =
      typeof command["displayIntent"] === "number"
        ? (command["displayIntent"] as number)
        : 0;
  }

  isCurrent(revision: number): boolean {
    return !this.canceled && this.revision === revision;
  }

  cancel(error: Error): void {
    this.canceled = true;
    this.pendingPosition = null;
    this.pendingNavigationRevision++;
    this.commandTask?.interrupt(error);
    this.commandTask = null;
  }

  cancelPendingNavigation(): void {
    this.pendingPosition = null;
    this.pendingNavigationRevision++;
  }
}

export type PreviewSnapshotSeed = {
  readonly clientRevision: number;
  readonly snapshots: ReadonlyMap<string, PreviewSnapshot>;
};

export class AdaptiveViewer {
  private previewRevision = 0;
  private previewSession: PreviewSession | null = null;
  private committedPreview:
    | {
        readonly clientRevision: number;
        readonly pagesByEpage: Map<number, Vtree.Page>;
        readonly snapshots: ReadonlyMap<string, PreviewSnapshot>;
        root: HTMLElement;
        viewport: Vgen.Viewport;
      }
    | null = null;
  private viewportRoot: HTMLElement;
  private displayedPreviewUnitsByEpage = new Map<
    number,
    {
      readonly presentation: "working" | "committed";
      readonly revision: number;
      readonly containers: readonly HTMLElement[];
    }
  >();

  private isPreviewUpdate(): boolean {
    return !!(
      this.previewSession?.isCurrent(this.previewRevision) &&
      this.previewSession.reusePages
    );
  }

  private isFocusedPreviewUpdate(): boolean {
    return !!(
      this.previewSession?.isCurrent(this.previewRevision) &&
      this.previewSession.paginationMode === "target-display-unit"
    );
  }

  private isCurrentCommand(): boolean {
    return (
      !this.previewSession ||
      this.previewSession.isCurrent(this.previewRevision)
    );
  }

  /** Whether navigation may synchronously paginate up to its destination. */
  private shouldLayoutSynchronously(): boolean {
    return !this.renderAllPages && !this.isPreviewUpdate();
  }

  private createPresentationRoot(visible: boolean): HTMLElement {
    const root = this.viewportElement.ownerDocument.createElement("div");
    root.setAttribute("data-vivliostyle-viewer-viewport", "true");
    root.setAttribute("role", "presentation");
    for (const attribute of [
      VIEWPORT_SPREAD_VIEW_ATTRIBUTE,
      "data-vivliostyle-page-progression",
      "data-vivliostyle-debug",
    ]) {
      const value = this.viewportElement.getAttribute(attribute);
      if (value !== null) root.setAttribute(attribute, value);
    }
    Object.assign(root.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      opacity: visible ? "1" : "0",
      pointerEvents: visible ? "auto" : "none",
      zIndex: visible ? "1" : "0",
      // The Core viewport stylesheet gives every viewer viewport a gray
      // background. Presentation roots are layers inside the real viewport,
      // so they must remain transparent or they change the host's backdrop.
      background: "transparent",
    });
    if (!visible) root.setAttribute("aria-hidden", "true");
    return root;
  }

  private showPresentationRoot(
    root: HTMLElement,
    presentation: "working" | "committed" = "committed",
  ): void {
    for (const candidateRoot of this.viewportElement.querySelectorAll<HTMLElement>(
      ":scope > [data-vivliostyle-preview-presentation]",
    )) {
      const visible = candidateRoot === root;
      candidateRoot.style.opacity = visible ? "1" : "0";
      candidateRoot.style.pointerEvents = visible ? "auto" : "none";
      candidateRoot.style.zIndex = visible ? "1" : "0";
      if (visible) candidateRoot.removeAttribute("aria-hidden");
      else candidateRoot.setAttribute("aria-hidden", "true");
    }
    root.setAttribute("data-vivliostyle-preview-presentation", presentation);
    root.style.opacity = "1";
    root.style.pointerEvents = "auto";
    root.style.zIndex = "1";
    root.removeAttribute("aria-hidden");
  }

  /**
   * Keep the last committed viewport tree connected while a new revision uses
   * a separate root. Page containers alone are insufficient: their computed
   * layout depends on the spread/zoom ancestors retained here.
   */
  private prepareWorkingPresentationRoot(): void {
    const committed = this.committedPreview;
    if (!committed) return;

    if (this.viewportRoot === this.viewportElement) {
      const retainedRoot = this.createPresentationRoot(true);
      retainedRoot.setAttribute(
        "data-vivliostyle-preview-presentation",
        "committed",
      );
      const children = Array.from(this.viewportElement.childNodes);
      for (const child of children) retainedRoot.appendChild(child);
      this.viewportElement.appendChild(retainedRoot);
      this.viewportElement.removeAttribute(
        "data-vivliostyle-preview-presentation",
      );
      committed.root = retainedRoot;
      if (this.viewport) this.viewport.root = retainedRoot;
    } else if (this.viewportRoot !== committed.root) {
      // A superseded working tree is never a display fallback.
      this.viewportRoot.remove();
    }

    this.showPresentationRoot(committed.root);
    const workingRoot = this.createPresentationRoot(false);
    workingRoot.setAttribute("data-vivliostyle-preview-presentation", "working");
    this.viewportElement.appendChild(workingRoot);
    this.viewportRoot = workingRoot;
    this.viewport = null;
  }

  supersedePreviewUpdate(): number {
    this.previewRevision++;
    this.cancelRenderingTask();
    if (this.previewSession && this.opfView) {
      this.previewSession.snapshots.clear();
      for (const item of this.opfView.spineItems) {
        if (!item) continue;
        this.previewSession.snapshots.set(item.item.src, {
          source: item,
          pages: item.pages.slice(),
          positions: item.layoutPositions.slice(),
        });
      }
    }
    this.previewSession?.cancel(new RenderingCanceledError());
    this.prepareWorkingPresentationRoot();
    this.needResize = false;
    return this.previewRevision;
  }

  private beginPreviewUpdate(command: Base.JSON): void {
    this.cancelRenderingTask();
    this.previewSession =
      typeof command["previewRevision"] === "number"
        ? new PreviewSession(command, this.window.performance.now())
        : null;
    const session = this.previewSession;
    if (!session) this.committedPreview = null;
    if (session?.reusePages && this.opf) {
      for (const item of this.opf.spine) {
        const source = this.opf.store.resources[item.src];
        if (source) session.sources.set(item.src, source);
      }
    }
    // The caller explicitly promises unchanged resources for manuscript-only
    // updates. Inline stylesheet text is already part of the store's cache key.
    if (session?.reusePages && this.opf) {
      session.styles = { ...this.opf.store.styleByKey };
    }
    if (session?.reusePages && this.opfView) {
      for (const item of this.opfView.spineItems) {
        if (item) {
          // documentObject-backed memory documents are not stored in
          // EPUBDocStore.resources. The rendered view item still owns the
          // XMLDocHolder needed to locate the edited text in the next revision.
          if (!session.sources.has(item.item.src))
            session.sources.set(item.item.src, item.xmldoc);
          session.snapshots.set(item.item.src, {
            source: item,
            pages: item.pages.slice(),
            positions: item.layoutPositions.slice(),
          });
        }
      }
    }
    // An explicitly supplied committed seed wins over any unfinished local
    // presentation left in this viewer. This is how an isolated focused lane
    // starts from the stable lane without moving stable-owned page DOM.
    const seed = command["previewSnapshotSeed"] as
      | PreviewSnapshotSeed
      | undefined;
    if (session?.reusePages && seed?.snapshots) {
      session.snapshots.clear();
      for (const [url, snapshot] of seed.snapshots) {
        session.snapshots.set(
          url,
          clonePreviewSnapshotForDocument(snapshot, this.window.document),
        );
      }
    }
    if (session?.reusePages && this.pagePosition) {
      this.pagePosition = { ...this.pagePosition, pageIndex: -1 };
    }
  }

  private commitPreviewPages(): void {
    const session = this.previewSession;
    if (
      !session?.isCurrent(this.previewRevision) ||
      !this.opfView ||
      !this.viewport
    )
      return;
    const pagesByEpage = new Map<number, Vtree.Page>();
    const snapshots = new Map<string, PreviewSnapshot>();
    for (const item of this.opfView.spineItems) {
      if (!item) continue;
      snapshots.set(item.item.src, {
        source: item,
        pages: item.pages.slice(),
        positions: item.layoutPositions.slice(),
      });
      item.pages.forEach((page, index) => {
        if (page.container) {
          // Reused prefix/suffix pages remain attached to the committed
          // presentation during layout. Adopt them only at the commit point.
          this.viewport.contentContainer.appendChild(page.container);
          pagesByEpage.set(item.item.epage + index, page);
        }
      });
    }
    const previousRoot = this.committedPreview?.root;
    this.showPresentationRoot(this.viewportRoot);
    this.committedPreview = {
      clientRevision: session.clientRevision,
      pagesByEpage,
      snapshots,
      root: this.viewportRoot,
      viewport: this.viewport,
    };
    if (previousRoot && previousRoot !== this.viewportRoot) previousRoot.remove();
  }

  fontMapper: Font.Mapper;
  kick: () => void;
  sendCommand: (p1: Base.JSON | string) => void;
  resizeListener: () => void;
  hyperlinkListener: Base.EventListener;
  pageRuleStyleElement: HTMLElement;
  pageSheetSizeAlreadySet: boolean = false;
  renderTask: Task.Task | null = null;
  actions: { [key: string]: Action };
  readyState: Constants.ReadyState = Constants.ReadyState.LOADING;
  packageURL: string[] = [];
  opf: Epub.OPFDoc | null = null;
  needResize: boolean = false;
  resized: boolean = false;
  needRefresh: boolean = false;
  viewportSize: ViewportSize | null = null;
  currentPage: Vtree.Page | null = null;
  currentSpread: Vtree.Spread | null = null;
  pagePosition: Epub.Position | null = null;
  fontSize: number = 16;
  zoom: number = 1;
  fitToScreen: boolean = false;
  pageViewMode: PageViewMode = PageViewMode.SINGLE_PAGE;
  waitForLoading: boolean = false;
  renderAllPages: boolean = true;
  pref: Exprs.Preferences = Exprs.defaultPreferences();
  pageSizes: { width: number; height: number }[] = [];

  // Pixel ratio emulation on PDF output (PR #1079) does not work with
  // non-Chromium browsers.
  pixelRatioLimit: number =
    Base.browserType === "chromium" &&
    // Check non-legacy CSS zoom support (Chromium>=128)
    "currentCSSZoom" in Element.prototype
      ? 16 // max pixelRatio value on Chromium browsers
      : 0; // disable pixelRatio emulation on non-Chromium browsers
  pixelRatio: number = Math.min(8, this.pixelRatioLimit);

  // force relayout
  viewport: Vgen.Viewport | null = null;
  opfView: Epub.OPFView | null = null;
  cmykReserveMap: CmykStore.CmykReserveMapEntry[] | undefined;
  cmykReserveMapUrl: string | undefined;
  private paginationProgressHook: Plugin.PaginationProgressHook | null = null;

  constructor(
    public readonly window: Window,
    public readonly viewportElement: HTMLElement,
    public readonly instanceId: string,
    public readonly callbackFn: (p1: Base.JSON) => void,
  ) {
    const document = viewportElement.ownerDocument;
    this.viewportRoot = viewportElement;
    const findOrCreateStyleElement = (
      id: string,
      cssText?: string,
    ): HTMLElement => {
      let styleElement = document.getElementById(id);
      if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.id = id;
        if (cssText) {
          styleElement.textContent = cssText;
        }
        document.head.appendChild(styleElement);
      }
      return styleElement;
    };
    findOrCreateStyleElement(
      "vivliostyle-viewport-screen-css",
      VivliostyleViewportScreenCss,
    );
    findOrCreateStyleElement(
      "vivliostyle-viewport-css",
      VivliostyleViewportCss,
    );
    findOrCreateStyleElement(
      "vivliostyle-polyfill-css",
      VivliostylePolyfillCss,
    );

    viewportElement.setAttribute("data-vivliostyle-viewer-viewport", true);
    if (Constants.isDebug) {
      viewportElement.setAttribute("data-vivliostyle-debug", true);
    }
    viewportElement.setAttribute(VIEWPORT_STATUS_ATTRIBUTE, "loading");
    this.fontMapper = new Font.Mapper(document.head, viewportElement);
    this.kick = () => {};
    this.sendCommand = () => {};
    this.resizeListener = () => {
      this.needResize = true;
      this.resized = true;
      this.kick();
    };
    this.pageReplacedListener = this.pageReplacedListener.bind(this);
    this.hyperlinkListener = (evt) => {};
    this.pageRuleStyleElement = findOrCreateStyleElement(
      "vivliostyle-page-rules",
    );
    this.actions = {
      loadPublication: this.loadPublication,
      loadXML: this.loadXML,
      configure: this.configure,
      moveTo: this.moveTo,
      toc: this.showTOC,
    };
    this.addLogListeners();
  }

  addLogListeners() {
    const logLevel = Logging.LogLevel;
    Logging.logger.addListener(logLevel.DEBUG, (info) => {
      this.callback({ t: "debug", content: info });
    });
    Logging.logger.addListener(logLevel.INFO, (info) => {
      this.callback({ t: "info", content: info });
    });
    Logging.logger.addListener(logLevel.WARN, (info) => {
      this.callback({ t: "warn", content: info });
    });
    Logging.logger.addListener(logLevel.ERROR, (info) => {
      this.callback({ t: "error", content: info });
    });
  }

  /**
   * Register the PAGINATION_PROGRESS plugin hook lazily, so that viewers
   * without a progress listener do not pay the cost of the progress
   * calculation.
   */
  ensurePaginationProgressListener() {
    if (this.paginationProgressHook) {
      return;
    }
    const hook: Plugin.PaginationProgressHook = (payload) => {
      this.callback({ t: "paginationprogress", ...payload });
    };
    this.paginationProgressHook = hook;
    Plugin.registerHook(Plugin.HOOKS.PAGINATION_PROGRESS, hook);
  }

  removePaginationProgressListener() {
    if (this.paginationProgressHook) {
      Plugin.removeHook(
        Plugin.HOOKS.PAGINATION_PROGRESS,
        this.paginationProgressHook,
      );
      this.paginationProgressHook = null;
    }
  }

  private callback(message: Base.JSON): void {
    if (!this.isCurrentCommand()) return;
    if (this.previewSession) {
      message["revision"] = this.previewSession.clientRevision;
    }
    message["i"] = this.instanceId;
    this.callbackFn(message);
  }

  /**
   * Set readyState and notify to listeners
   */
  setReadyState(readyState: Constants.ReadyState) {
    if (this.readyState !== readyState) {
      this.readyState = readyState;
      this.viewportElement.setAttribute(VIEWPORT_STATUS_ATTRIBUTE, readyState);
      // Set page-progression attribute (Issue #1681)
      const pageProgression = this.getCurrentPageProgression();
      if (pageProgression) {
        this.viewportElement.setAttribute(
          "data-vivliostyle-page-progression",
          pageProgression,
        );
        this.viewportRoot.setAttribute(
          "data-vivliostyle-page-progression",
          pageProgression,
        );
      }
      this.callback({ t: "readystatechange" });
    }
  }

  loadPublication(command: Base.JSON): Task.Result<boolean> {
    this.beginPreviewUpdate(command);
    Profile.profiler.registerStartTiming("beforeRender");
    this.setReadyState(Constants.ReadyState.LOADING);
    const url = command["url"] as string;
    const fragment = command["fragment"] as string | null;
    const authorStyleSheet = command[
      "authorStyleSheet"
    ] as OPS.StyleSheetParam[];
    const userStyleSheet = command["userStyleSheet"] as OPS.StyleSheetParam[];
    this.cmykReserveMapUrl = command["cmykReserveMapUrl"] as string | undefined;
    this.viewport = null;
    const frame: Task.Frame<boolean> = Task.newFrame("loadPublication");
    this.configure(command).then(() => {
      Epub.EPUBDocStore.create(authorStyleSheet, userStyleSheet).then(
        (store) => {
          Object.assign(store.styleByKey, this.previewSession?.styles || {});
          const pubURL = Base.resolveURL(
            Base.convertSpecialURL(url),
            this.window.location.href,
          );
          this.packageURL = [pubURL];
          store.loadPubDoc(pubURL).then((opf) => {
            if (opf) {
              this.opf = opf;
              this.loadCmykReserveMap(store).then(() => {
                this.render(fragment).then(() => {
                  frame.finish(true);
                });
              });
            } else {
              frame.finish(false);
            }
          });
        },
      );
    });
    return frame.result();
  }

  loadXML(command: Base.JSON): Task.Result<boolean> {
    this.beginPreviewUpdate(command);
    const trace = (stage: string) => {
      if (this.window["vivliostylePreviewTrace"] && this.previewSession) this.callback({ t: "previewtrace", stage,
        elapsedMs: this.window.performance.now() - this.previewSession.started });
    };
    trace("loadXML-enter");
    Profile.profiler.registerStartTiming("beforeRender");
    this.setReadyState(Constants.ReadyState.LOADING);
    const params: SingleDocumentParam[] = command["url"];
    const doc = command["document"] as Document;
    const fragment = command["fragment"] as string | null;
    const authorStyleSheet = command[
      "authorStyleSheet"
    ] as OPS.StyleSheetParam[];
    const userStyleSheet = command["userStyleSheet"] as OPS.StyleSheetParam[];
    this.cmykReserveMapUrl = command["cmykReserveMapUrl"] as string | undefined;

    // force relayout
    this.viewport = null;
    const frame: Task.Frame<boolean> = Task.newFrame("loadXML");
    this.configure(command).then(() => {
      trace("configured");
      Epub.EPUBDocStore.create(authorStyleSheet, userStyleSheet).then(
        (store) => {
          trace("store-created");
          Object.assign(store.styleByKey, this.previewSession?.styles || {});
          const resolvedParams: Epub.OPFItemParam[] = params.map(
            (p, index) => ({
              url: Base.resolveURL(
                Base.convertSpecialURL(p.url),
                this.window.location.href,
              ),
              index,
              startPage: p.startPage,
              skipPagesBefore: p.skipPagesBefore,
            }),
          );
          this.packageURL = resolvedParams.map((p) => p.url);
          Epub.OPFDoc.fromChapters(store, "", resolvedParams, doc).then(
            (opf) => {
              trace("document-added");
              this.opf = opf;
              this.loadCmykReserveMap(store).then(() => {
                trace("render-enter");
                this.render(fragment).then(() => {
                  frame.finish(true);
                });
              });
            },
          );
        },
      );
    });
    return frame.result();
  }

  private render(fragment?: string | null): Task.Result<boolean> {
    if (!this.isCurrentCommand()) {
      return Task.newResult(false);
    }
    this.cancelRenderingTask();
    let cont: Task.Result<boolean>;
    if (fragment) {
      cont = this.opf.resolveFragment(fragment).thenAsync((position) => {
        if (this.previewSession) this.previewSession.targetResolved = !!position;
        this.pagePosition = position;
        return Task.newResult(true);
      });
    } else {
      const changedItem = [...(this.previewSession?.changedUrls || [])]
        .reverse()
        .map((url) => this.opf.spine.find((item) => item.src === url))
        .find(Boolean);
      const item =
        changedItem || this.opf.spine[this.pagePosition?.spineIndex ?? 0];
      if (
        changedItem &&
        changedItem.spineIndex !== this.pagePosition?.spineIndex
      ) {
        this.pagePosition = {
          spineIndex: changedItem.spineIndex,
          pageIndex: 0,
          offsetInItem: 0,
        };
      }
      const previous = item && this.previewSession?.sources.get(item.src);
      if (previous) {
        cont = this.opf.store.load(item.src).thenAsync((doc) => {
          const edited = editedTextOffset(previous.body, doc.body);
          if (edited) {
            const editOffset = doc.getNodeOffset(
              edited.node,
              edited.offset,
              false,
            );
            this.previewSession.editOffset = editOffset;
            this.pagePosition = {
              spineIndex: item.spineIndex,
              pageIndex: -1,
              offsetInItem: editOffset,
            };
          }
          return Task.newResult(true);
        });
      } else cont = Task.newResult(true);
    }
    return cont.thenAsync(() => {
      if (!this.isCurrentCommand()) return Task.newResult(false);
      if (this.previewSession) {
        this.previewSession.loadMs =
          this.window.performance.now() - this.previewSession.started;
      }
      Profile.profiler.registerEndTiming("beforeRender");
      return this.resize();
    });
  }

  private resolveLength(specified: string): number {
    const value = parseFloat(specified);
    const unitPattern = /[a-z]+$/;
    let matched: RegExpMatchArray | null;
    if (
      typeof specified === "string" &&
      (matched = specified.match(unitPattern))
    ) {
      const unit = matched[0];
      if (unit === "em" || unit === "rem") {
        return value * this.fontSize;
      }
      const unitSize = Exprs.defaultUnitSizes[unit];
      if (unitSize) {
        return value * unitSize;
      }
    }
    return value;
  }

  configure(command: Base.JSON): Task.Result<boolean> {
    if (typeof command["autoresize"] == "boolean") {
      if (command["autoresize"]) {
        this.viewportSize = null;
        this.window.addEventListener("resize", this.resizeListener, false);
        this.needResize = true;
      } else {
        this.window.removeEventListener("resize", this.resizeListener, false);
      }
    }
    if (typeof command["fontSize"] == "number") {
      const fontSize = command["fontSize"] as number;
      if (fontSize >= 5 && fontSize <= 72 && this.fontSize != fontSize) {
        this.fontSize = fontSize;
        this.needResize = true;
      }
    }
    if (typeof command["viewport"] == "object" && command["viewport"]) {
      const vp = command["viewport"];
      const viewportSize = {
        marginLeft: this.resolveLength(vp["margin-left"]) || 0,
        marginRight: this.resolveLength(vp["margin-right"]) || 0,
        marginTop: this.resolveLength(vp["margin-top"]) || 0,
        marginBottom: this.resolveLength(vp["margin-bottom"]) || 0,
        width: this.resolveLength(vp["width"]) || 0,
        height: this.resolveLength(vp["height"]) || 0,
      };
      if (viewportSize.width >= 200 || viewportSize.height >= 200) {
        this.window.removeEventListener("resize", this.resizeListener, false);
        this.viewportSize = viewportSize;
        this.needResize = true;
      }
    }
    if (typeof command["hyphenate"] == "boolean") {
      this.pref.hyphenate = command["hyphenate"];
      this.needResize = true;
    }
    if (typeof command["horizontal"] == "boolean") {
      this.pref.horizontal = command["horizontal"];
      this.needResize = true;
    }
    if (typeof command["nightMode"] == "boolean") {
      this.pref.nightMode = command["nightMode"];
      this.needResize = true;
    }
    if (typeof command["lineHeight"] == "number") {
      this.pref.lineHeight = command["lineHeight"];
      this.needResize = true;
    }
    if (typeof command["columnWidth"] == "number") {
      this.pref.columnWidth = command["columnWidth"];
      this.needResize = true;
    }
    if (typeof command["fontFamily"] == "string") {
      this.pref.fontFamily = command["fontFamily"];
      this.needResize = true;
    }
    if (typeof command["load"] == "boolean") {
      this.waitForLoading = command["load"]; // Load images (and other resources) on the page.
    }
    if (typeof command["renderAllPages"] == "boolean") {
      this.renderAllPages = command["renderAllPages"];
    }
    // for backward compatibility
    if (typeof command["userAgentRootURL"] == "string") {
      Base.setBaseURL(command["userAgentRootURL"].replace(/resources\/?$/, ""));
      Base.setResourceBaseURL(command["userAgentRootURL"]);
    }
    if (typeof command["rootURL"] == "string") {
      Base.setBaseURL(command["rootURL"]);
      Base.setResourceBaseURL(`${Base.baseURL}resources/`);
    }
    if (
      typeof command["pageViewMode"] == "string" &&
      command["pageViewMode"] !== this.pageViewMode
    ) {
      this.pageViewMode = command["pageViewMode"] as PageViewMode;
      this.needResize = true;
    }
    if (
      typeof command["pageBorder"] == "number" &&
      command["pageBorder"] !== this.pref.pageBorder
    ) {
      // Force relayout
      this.viewport = null;
      this.pref.pageBorder = command["pageBorder"];
      this.needResize = true;
    }
    if (typeof command["zoom"] == "number" && command["zoom"] !== this.zoom) {
      this.zoom = command["zoom"];
      this.needRefresh = true;
    }
    if (
      typeof command["fitToScreen"] == "boolean" &&
      command["fitToScreen"] !== this.fitToScreen
    ) {
      this.fitToScreen = command["fitToScreen"];
      this.needRefresh = true;
    }
    if (
      typeof command["defaultPaperSize"] == "object" &&
      typeof command["defaultPaperSize"].width == "number" &&
      typeof command["defaultPaperSize"].height == "number"
    ) {
      this.viewport = null;
      this.pref.defaultPaperSize = command["defaultPaperSize"];
      this.needResize = true;
    }
    // JavaScript in HTML documents support
    if (
      typeof command["allowScripts"] == "boolean" &&
      command["allowScripts"] !== Scripts.allowScripts
    ) {
      Scripts.setAllowScripts(command["allowScripts"]);
      this.needResize = true;
    }
    // output pixel ratio emulation
    if (typeof command["pixelRatio"] == "number") {
      const pixelRatio = Math.min(command["pixelRatio"], this.pixelRatioLimit);
      if (pixelRatio !== this.pixelRatio) {
        this.pixelRatio = pixelRatio;
        this.needResize = true;
      }
    }
    this.configurePlugins(command);
    return Task.newResult(true);
  }

  configurePlugins(command: Base.JSON) {
    const hooks: Plugin.ConfigurationHook[] = Plugin.getHooksForName(
      Plugin.HOOKS.CONFIGURATION,
    );
    hooks.forEach((hook) => {
      const result = hook(command);
      this.needResize = result.needResize || this.needResize;
      this.needRefresh = result.needRefresh || this.needRefresh;
    });
  }

  /**
   * Refresh view when a currently displayed page is replaced (by re-layout
   * caused by cross reference resolutions)
   */
  pageReplacedListener(evt: Base.Event) {
    const currentPage = this.currentPage;
    const spread = this.currentSpread;
    const target = evt.target;
    if (spread) {
      if (spread.left === target || spread.right === target) {
        this.showCurrent(evt.newPage);
      }
    } else if (currentPage === evt.target) {
      this.showCurrent(evt.newPage);
    }
  }

  /**
   * Iterate through currently displayed pages and do something
   */
  private forCurrentPages(fn: (p1: Vtree.Page) => any) {
    const pages: Vtree.Page[] = [];
    if (this.currentPage) {
      pages.push(this.currentPage);
    }
    if (this.currentSpread) {
      if (this.currentSpread.left) {
        pages.push(this.currentSpread.left);
      }
      if (this.currentSpread.right) {
        pages.push(this.currentSpread.right);
      }
    }
    pages.forEach((page) => {
      if (page) {
        fn(page);
      }
    });
  }

  private removePageListeners() {
    this.forCurrentPages((page) => {
      page.removeEventListener("hyperlink", this.hyperlinkListener, false);
      page.removeEventListener("replaced", this.pageReplacedListener, false);
    });
  }

  /**
   * Hide current pages (this.currentPage, this.currentSpread)
   */
  private hidePages() {
    this.removePageListeners();
    this.forCurrentPages((page) => {
      Base.setCSSProperty(page.container, "display", "none");
    });
    this.currentPage = null;
    this.currentSpread = null;
  }

  private showSinglePage(page: Vtree.Page) {
    page.addEventListener("hyperlink", this.hyperlinkListener, false);
    page.addEventListener("replaced", this.pageReplacedListener, false);
    Base.setCSSProperty(page.container, "visibility", "visible");
    Base.setCSSProperty(page.container, "display", "block");
  }

  private showPage(page: Vtree.Page): void {
    this.hidePages();
    this.currentPage = page;
    page.container.style.marginLeft = "";
    page.container.style.marginRight = "";
    this.showSinglePage(page);
  }

  private showPendingPreviewPage(
    position: Epub.Position,
  ): Task.Result<boolean> {
    const session = this.previewSession;
    const sourcePage = this.currentPage;
    if (!session?.isCurrent(this.previewRevision) || !sourcePage)
      return Task.newResult(true);
    const container = sourcePage.container.cloneNode(false) as HTMLElement;
    container.removeAttribute("data-vivliostyle-page-container");
    container.setAttribute("data-vivliostyle-pending-page", "true");
    const bleedBox = this.viewport.document.createElement("div");
    container.appendChild(bleedBox);
    this.viewport.contentContainer.appendChild(container);
    const page = new Vtree.Page(container, bleedBox);
    page.dimensions = { ...sourcePage.dimensions };
    page.spineIndex = position.spineIndex;
    page.offset = -1;
    page.side =
      sourcePage.side === Constants.PageSide.LEFT
        ? Constants.PageSide.RIGHT
        : Constants.PageSide.LEFT;
    this.pagePosition = { ...position };
    session.pendingPosition = { ...position };
    const revision = ++session.pendingNavigationRevision;
    this.showPage(page);
    this.setPageZoom(page);

    const updateWhenReady = (): void => {
      if (
        !session.isCurrent(this.previewRevision) ||
        revision !== session.pendingNavigationRevision ||
        !session.pendingPosition ||
        !this.opfView
      )
        return;
      const pending = session.pendingPosition;
      const viewItem = this.opfView.spineItems[pending.spineIndex];
      let pageIndex = pending.pageIndex;
      let renderedPage = viewItem?.pages[pageIndex];
      if (!renderedPage && viewItem?.complete && viewItem.pages.length) {
        pageIndex = Math.min(pageIndex, viewItem.pages.length - 1);
        renderedPage = viewItem.pages[pageIndex];
      }
      if (!renderedPage) {
        this.window.setTimeout(updateWhenReady, 16);
        return;
      }
      session.pendingPosition = null;
      this.pagePosition = {
        spineIndex: pending.spineIndex,
        pageIndex,
        offsetInItem: renderedPage.offset,
      };
      Task.start(() =>
        this.showCurrent(renderedPage, true).thenAsync(() =>
          this.reportPosition(),
        ),
      );
    };
    this.window.setTimeout(updateWhenReady, 0);
    return Task.newResult(true);
  }

  private tryPendingPreviewNavigation(
    command: Base.JSON,
  ): Task.Result<boolean> | null {
    if (!this.isPreviewUpdate() || !this.opfView || !this.pagePosition)
      return null;
    const requestedPosition = command["position"] as Epub.Position | undefined;
    const isRelative =
      command["where"] === "next" || command["where"] === "previous";
    if (!isRelative && typeof requestedPosition?.pageIndex !== "number")
      return null;
    const spineIndex = isRelative
      ? this.pagePosition.spineIndex
      : requestedPosition.spineIndex;
    if (spineIndex !== this.pagePosition.spineIndex) return null;
    const pageIndex = isRelative
      ? this.pagePosition.pageIndex + (command["where"] === "next" ? 1 : -1)
      : requestedPosition.pageIndex;
    if (pageIndex < 0) return null;
    const viewItem = this.opfView.spineItems[spineIndex];
    if (!viewItem || viewItem.pages[pageIndex] || viewItem.complete)
      return null;
    return this.showPendingPreviewPage({
      spineIndex,
      pageIndex,
      offsetInItem: -1,
    });
  }

  private showSpread(spread: Vtree.Spread) {
    this.hidePages();
    this.currentSpread = spread;
    if (spread.left && spread.right) {
      // Adjust spread horizontal alignment when left/right page widths differ
      let leftWidth = parseFloat(spread.left.container.style.width);
      let rightWidth = parseFloat(spread.right.container.style.width);
      if (leftWidth && rightWidth && leftWidth !== rightWidth) {
        if (leftWidth < rightWidth) {
          spread.left.container.style.marginLeft = `${
            rightWidth - leftWidth
          }px`;
        } else {
          spread.right.container.style.marginRight = `${
            leftWidth - rightWidth
          }px`;
        }
      }
    }
    if (spread.left) {
      this.showSinglePage(spread.left);
      if (!spread.right) {
        spread.left.container.setAttribute(
          "data-vivliostyle-unpaired-page",
          true,
        );
      } else {
        spread.left.container.removeAttribute("data-vivliostyle-unpaired-page");
      }
    }
    if (spread.right) {
      this.showSinglePage(spread.right);
      if (!spread.left) {
        spread.right.container.setAttribute(
          "data-vivliostyle-unpaired-page",
          true,
        );
      } else {
        spread.right.container.removeAttribute(
          "data-vivliostyle-unpaired-page",
        );
      }
    }
  }

  private reportPosition(): Task.Result<boolean> {
    const frame: Task.Frame<boolean> = Task.newFrame("reportPosition");
    Asserts.assert(this.pagePosition);
    const page = this.currentPage;
    if (!page) {
      frame.finish(false);
      return frame.result();
    }
    this.opf
      .getCFI(this.pagePosition.spineIndex, this.pagePosition.offsetInItem)
      .then((cfi) => {
        const r =
          this.waitForLoading && page.fetchers.length > 0
            ? TaskUtil.waitForFetchers(page.fetchers)
            : Task.newResult(true);
        r.then(() => {
          this.sendLocationNotification(page, cfi).thenFinish(frame);
        });
      });
    return frame.result();
  }

  private createViewport(): Vgen.Viewport {
    const viewportElement = this.viewportRoot;
    if (this.viewportSize) {
      const vs = this.viewportSize;
      viewportElement.style.marginLeft = `${vs.marginLeft}px`;
      viewportElement.style.marginRight = `${vs.marginRight}px`;
      viewportElement.style.marginTop = `${vs.marginTop}px`;
      viewportElement.style.marginBottom = `${vs.marginBottom}px`;
      return new Vgen.Viewport(
        this.window,
        this.fontSize,
        this.pixelRatio,
        viewportElement,
        vs.width,
        vs.height,
      );
    } else {
      return new Vgen.Viewport(
        this.window,
        this.fontSize,
        this.pixelRatio,
        viewportElement,
      );
    }
  }

  private resolveSpreadView(
    viewport: Vgen.Viewport | null,
    pageSize: { width: number; height: number } | null,
  ): boolean {
    switch (this.pageViewMode) {
      case PageViewMode.SINGLE_PAGE:
        return false;
      case PageViewMode.SPREAD:
        return true;
      case PageViewMode.AUTO_SPREAD:
      default:
        return (
          viewport != null &&
          (viewport.width - this.pref.pageBorder) / viewport.height >=
            (pageSize ? (pageSize.width * 2) / pageSize.height : 1.45) &&
          (!!pageSize || viewport.width > 800)
        );
    }
  }

  private updateSpreadView(spreadView: boolean) {
    this.pref.spreadView = spreadView;
    this.viewportElement.setAttribute(
      VIEWPORT_SPREAD_VIEW_ATTRIBUTE,
      spreadView.toString(),
    );
    this.viewportRoot.setAttribute(
      VIEWPORT_SPREAD_VIEW_ATTRIBUTE,
      spreadView.toString(),
    );
  }

  private sizeIsGood(): boolean {
    const viewport = this.createViewport();
    const hasNoAutoSizedPages =
      this.opfView?.hasPages() && !this.opfView.hasAutoSizedPages();
    const spreadView = this.resolveSpreadView(
      viewport,
      this.resized && hasNoAutoSizedPages ? this.pageSizes[0] : null,
    );
    this.resized = false;
    const spreadViewChanged = this.pref.spreadView !== spreadView;
    this.updateSpreadView(spreadView);

    // check if window.devicePixelRatio is changed
    const scaleRatioChanged =
      this.pixelRatio &&
      this.opfView &&
      this.pixelRatio / this.window.devicePixelRatio !==
        this.opfView.clientLayout.scaleRatio;

    if (
      scaleRatioChanged ||
      this.viewportSize ||
      !this.viewport ||
      this.viewport.fontSize != this.fontSize
    ) {
      return false;
    }
    if (
      !spreadViewChanged &&
      viewport.width == this.viewport.width &&
      viewport.height == this.viewport.height
    ) {
      return true;
    }

    if (
      !spreadViewChanged &&
      viewport.width == this.viewport.width &&
      viewport.height != this.viewport.height &&
      /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    ) {
      // On mobile browsers, the viewport height may change unexpectedly
      // when soft keyboard appears or tab/address bar auto-hide occurs,
      // so ignore resizing in this condition.
      return true;
    }

    if (hasNoAutoSizedPages) {
      this.viewport.width = viewport.width;
      this.viewport.height = viewport.height;
      this.needRefresh = true;
      return true;
    }
    return false;
  }

  private setPageSize(
    pageSize: { width: number; height: number },
    pageSheetSize: { [key: string]: { width: number; height: number } },
    spineIndex: number,
    pageIndex: number,
  ) {
    this.pageSizes[pageIndex] = pageSize;
    this.setPageSizePageRules(pageIndex);
    if (
      pageIndex === 0 &&
      this.pageViewMode === PageViewMode.AUTO_SPREAD &&
      !this.opfView.hasAutoSizedPages()
    ) {
      this.updateSpreadView(this.resolveSpreadView(this.viewport, pageSize));
    }
  }

  private truncatePageSizes(pageCount: number) {
    if (this.pageSizes.length > pageCount) {
      this.pageSizes.splice(pageCount);
    }
    this.removePageSizePageRules();
    let lastPageSizeIndex = this.pageSizes.length - 1;
    while (
      lastPageSizeIndex >= 0 &&
      this.pageSizes[lastPageSizeIndex] == null
    ) {
      lastPageSizeIndex--;
    }
    if (lastPageSizeIndex >= 0) {
      this.setPageSizePageRules(lastPageSizeIndex);
    }
  }

  private setPageSizePageRules(pageIndex: number) {
    // In this implementation, it generates one page rule with the largest
    // page size both in width and height in the multiple page sizes.
    // (Resolve issue #751)
    const currentPageSize = this.pageSizes[pageIndex];
    if (
      this.pageRuleStyleElement &&
      currentPageSize &&
      (!this.pageSheetSizeAlreadySet ||
        currentPageSize.width !== this.pageSizes[pageIndex - 1]?.width ||
        currentPageSize.height !== this.pageSizes[pageIndex - 1]?.height)
    ) {
      const definedPageSizes = this.pageSizes.filter(
        (pageSize) => pageSize != null,
      );
      const widthMax = Math.max(...definedPageSizes.map((p) => p.width));
      const heightMax = Math.max(...definedPageSizes.map((p) => p.height));

      function convertSize(px: number): number {
        const pt = px * 0.75;
        // Workaround for Chromium's rounded page size problem.
        // (Fix for issue #934 and #936)
        return Math.ceil(pt);
      }
      const widthPt = convertSize(widthMax);
      const heightPt = convertSize(heightMax);

      // Negative margin setting is necessary to prevent unexpected page breaking.
      // Note that the high pixel ratio emulation, the pixelRatio setting, uses the CSS zoom property
      // that enlarge the page content size, and Chromium splits such large pages unless this
      // negative margin is specified.
      const rightPt = widthPt * ((this.pixelRatio || 1) - 1) + 2;
      const bottomPt = heightPt * ((this.pixelRatio || 1) - 1) + 2; // "+ 2" is for issue #947
      const styleText = `@page {size: ${widthPt}pt ${heightPt}pt; margin: 0 ${-rightPt}pt ${-bottomPt}pt 0;}`;
      this.pageRuleStyleElement.textContent = styleText;
      this.pageSheetSizeAlreadySet = true;
    }
  }

  removePageSizePageRules() {
    if (this.pageRuleStyleElement) {
      this.pageRuleStyleElement.textContent = "";
      this.pageSheetSizeAlreadySet = false;
    }
  }

  private loadCmykReserveMap(store: Epub.EPUBDocStore): Task.Result<boolean> {
    if (!this.cmykReserveMapUrl) {
      this.cmykReserveMap = undefined;
      return Task.newResult(true);
    }
    const resolvedUrl = Base.resolveURL(
      Base.convertSpecialURL(this.cmykReserveMapUrl),
      Base.baseURL,
    );
    const frame: Task.Frame<boolean> = Task.newFrame("loadCmykReserveMap");
    store.loadAsJSON(resolvedUrl).then((data) => {
      if (CmykStore.isValidCmykReserveMap(data)) {
        this.cmykReserveMap = data;
      } else {
        Logging.logger.warn("Invalid cmykReserveMap data, ignoring");
        this.cmykReserveMap = undefined;
      }
      frame.finish(true);
    });
    return frame.result();
  }

  private reset(): void {
    let tocVisible = false;
    let tocAutohide = false;
    if (this.opfView) {
      tocVisible = this.opfView.tocVisible;
      tocAutohide = this.opfView.tocAutohide;
      if (this.opfView.viewport.root !== this.committedPreview?.root) {
        this.opfView.removeRenderedPages();
      }
    }
    this.currentPage = null;
    this.currentSpread = null;
    this.pageSizes = [];
    this.removePageSizePageRules();
    this.viewport = this.createViewport();
    this.viewport.resetZoom();
    this.opfView = new Epub.OPFView(
      this.opf,
      this.viewport,
      this.fontMapper,
      this.pref,
      this.setPageSize.bind(this),
      this.cmykReserveMap,
      this.truncatePageSizes.bind(this),
    );
    const session = this.previewSession;
    if (session?.reusePages)
      this.opfView.previewSnapshots = new Map(session.snapshots);
    session?.snapshots.clear();
    session?.sources.clear();
    if (tocVisible) {
      this.sendCommand({ a: "toc", v: "show", autohide: tocAutohide });
    }
  }

  /**
   * Show current page or spread depending on the setting
   * (this.pref.spreadView).
   * @param sync If true, get the necessary page synchronously (not waiting
   *     another rendering task)
   */
  private showCurrent(page: Vtree.Page, sync?: boolean): Task.Result<null> {
    if (!this.isCurrentCommand()) return Task.newResult(null);
    this.needRefresh = false;
    this.removePageListeners();

    const spreadView = this.resolveSpreadView(this.viewport, page.dimensions);
    if (spreadView !== this.pref.spreadView) {
      this.updateSpreadView(spreadView);
    }

    if (spreadView) {
      return this.opfView
        .getSpread(this.pagePosition, !!sync)
        .thenAsync((spread) => {
          if (!spread.left && !spread.right) {
            return Task.newResult(null);
          }
          if (
            spread.left &&
            spread.right &&
            (!this.resolveSpreadView(this.viewport, spread.left.dimensions) ||
              !this.resolveSpreadView(this.viewport, spread.right.dimensions))
          ) {
            // Turn off spread view mode if either left or right page is not
            // suitable for spread view.
            this.updateSpreadView(false);
            this.showPage(page);
            this.setPageZoom(page);
            this.currentPage = page;
            return Task.newResult(null);
          }
          this.showSpread(spread);
          this.setSpreadZoom(spread);
          this.currentPage =
            page.side === Constants.PageSide.LEFT ? spread.left : spread.right;
          return Task.newResult(null);
        });
    } else {
      this.showPage(page);
      this.setPageZoom(page);
      this.currentPage = page;
      return Task.newResult(null);
    }
  }

  setPageZoom(page: Vtree.Page) {
    const zoom = this.getAdjustedZoomFactor(page.dimensions);
    this.viewport?.zoom(page.dimensions.width, page.dimensions.height, zoom);
  }

  setSpreadZoom(spread: Vtree.Spread) {
    const dim = this.getSpreadDimensions(spread);
    this.viewport?.zoom(dim.width, dim.height, this.getAdjustedZoomFactor(dim));
  }

  /**
   * @returns adjusted zoom factor
   */
  getAdjustedZoomFactor(pageDimension: {
    width: number;
    height: number;
  }): number {
    return this.fitToScreen
      ? this.calculateZoomFactorToFitInsideViewPort(pageDimension)
      : this.zoom;
  }

  /**
   * Returns width and height of the spread, including the margin between pages.
   */
  getSpreadDimensions(spread: Vtree.Spread): { width: number; height: number } {
    let width = 0;
    let height = 0;
    if (spread.left) {
      width += spread.left.dimensions.width;
      height = spread.left.dimensions.height;
    }
    if (spread.right) {
      width += spread.right.dimensions.width;
      height = Math.max(height, spread.right.dimensions.height);
    }
    if (spread.left && spread.right) {
      width += this.pref.pageBorder * 2;
      // Adjust spread horizontal alignment when left/right page widths differ
      width += Math.abs(
        spread.left.dimensions.width - spread.right.dimensions.width,
      );
    }
    return { width, height };
  }

  /**
   * Returns zoom factor corresponding to the specified zoom type.
   */
  queryZoomFactor(type: ZoomType): number {
    if (!this.currentPage) {
      throw new Error("no page exists.");
    }
    switch (type) {
      case ZoomType.FIT_INSIDE_VIEWPORT: {
        let pageDim: { width: number; height: number };
        if (this.pref.spreadView) {
          Asserts.assert(this.currentSpread);
          pageDim = this.getSpreadDimensions(this.currentSpread);
        } else {
          pageDim = this.currentPage.dimensions;
        }
        return this.calculateZoomFactorToFitInsideViewPort(pageDim);
      }
      default:
        throw new Error(`unknown zoom type: ${type}`);
    }
  }

  /**
   * @returns zoom factor to fit inside viewport
   */
  calculateZoomFactorToFitInsideViewPort(pageDimension: {
    width: number;
    height: number;
  }): number {
    if (!this.viewport) {
      return this.zoom;
    }
    const widthZoom = this.viewport.width / pageDimension.width;
    const heightZoom = this.viewport.height / pageDimension.height;
    return Math.min(widthZoom, heightZoom);
  }

  private cancelRenderingTask() {
    if (this.renderTask) {
      this.renderTask.interrupt(new RenderingCanceledError());
    }
    this.renderTask = null;
  }

  resize(): Task.Result<boolean> {
    const previewSession =
      this.isPreviewUpdate() || this.isFocusedPreviewUpdate()
        ? this.previewSession
        : null;
    const trace = (stage: string) => {
      if (this.window["vivliostylePreviewTrace"] && previewSession) this.callback({
        t: "previewtrace", stage, elapsedMs: this.window.performance.now() - previewSession.started,
      });
    };
    this.needResize = false;
    this.needRefresh = false;
    if (this.sizeIsGood()) {
      return Task.newResult(true);
    }
    this.setReadyState(Constants.ReadyState.LOADING);
    this.cancelRenderingTask();
    const resizeTask = Task.currentTask()
      .getScheduler()
      .run(() =>
        Task.handle(
          "resize",
          (frame) => {
            if (!this.opf) {
              frame.finish(false);
              return;
            }
            this.renderTask = resizeTask;
            Profile.profiler.registerStartTiming("render (resize)");
            this.reset();
            if (this.pagePosition) {
              // When resizing, do not use the current page index, for a page
              // index corresponding to the current position in the document
              // (offsetInItem) can change due to different layout caused by
              // different viewport size.

              // Update(2019-03): to avoid unexpected page move (first page to next),
              // keep pageIndex == 0 when offsetInItem == 0
              if (!(
                this.pagePosition.pageIndex == 0 &&
                this.pagePosition.offsetInItem == 0
              )) {
                this.pagePosition.pageIndex = -1;
              }
            }

            // epageCount counting depends renderAllPages mode
            this.opf.setEPageCountMode(this.renderAllPages);

            // With renderAllPages option specified, the rendering is
            // performed after the initial page display, otherwise users are
            // forced to wait the rendering finish in front of a blank page.
            this.opfView
              .renderPagesUpto(
                this.pagePosition,
                !this.renderAllPages && !previewSession,
              )
              .then((result) => {
                if (!result) {
                  frame.finish(false);
                  return;
                }
                this.pagePosition = result.position;
                this.showCurrent(result.page, true).then(() => {
                  this.setReadyState(Constants.ReadyState.INTERACTIVE);
                  if (
                    previewSession?.paginationMode === "target-display-unit"
                  ) {
                    const unit = this.getCurrentPreviewDisplayUnit();
                    if (this.renderTask === resizeTask) this.renderTask = null;
                    Profile.profiler.registerEndTiming("render (resize)");
                    if (!unit || unit.revision !== previewSession.clientRevision) {
                      frame.finish(false);
                      return;
                    }
                    const elapsedMs =
                      this.window.performance.now() - previewSession.started;
                    this.callback({
                      t: "targetdisplayready",
                      revision: previewSession.clientRevision,
                      displayIntent: previewSession.displayIntent,
                      targetEpage: unit.epage,
                      paperCount: unit.containers.length,
                      targetResolved: previewSession.targetResolved,
                      reusedPages: this.opfView.previewReusedPages,
                      reusedPrefixPages: this.opfView.previewReusedPrefixPages,
                      elapsedMs,
                    });
                    // This is the focused task's normal terminal boundary. It
                    // intentionally skips countEPages(), renderAllPages(),
                    // commitPreviewPages(), nav and ordinary loaded events.
                    this.callback({
                      t: "focusedterminal",
                      revision: previewSession.clientRevision,
                      displayIntent: previewSession.displayIntent,
                      targetEpage: unit.epage,
                      paperCount: unit.containers.length,
                      targetResolved: previewSession.targetResolved,
                      terminalMs: elapsedMs,
                    });
                    frame.finish(true);
                    return;
                  }
                  const reportedPage = this.currentPage;
                  const reportedPosition = this.pagePosition;
                  if (!reportedPage || !reportedPosition) {
                    frame.finish(false);
                    return;
                  }
                  this.reportPosition().then((p) => {
                    if (previewSession) {
                      const displayedItem = this.opfView.spineItems[reportedPage.spineIndex];
                      const displayedPageIndex = displayedItem?.pages.indexOf(reportedPage) ?? -1;
                      this.callback({
                        t: "previewdisplay",
                        revision: previewSession.clientRevision,
                        reusedPages: this.opfView.previewReusedPages,
                        reusedPrefixPages: this.opfView.previewReusedPrefixPages,
                        reusedSuffixPages: this.opfView.previewReusedSuffixPages,
                        elapsedMs:
                          this.window.performance.now() - previewSession.started,
                        loadMs: previewSession.loadMs,
                        cacheMs: this.opfView.previewCacheMs,
                        editOffset: previewSession.editOffset,
                        epage:
                          displayedItem && displayedPageIndex >= 0
                            ? displayedItem.item.epage + displayedPageIndex
                            : undefined,
                        cacheResults: this.opfView.previewCacheResults.map((result) => ({
                          ...result,
                          blockers: result.blockers ? [...result.blockers] : undefined,
                        })),
                      });
                    }
                    this.opf
                      .countEPages((epageCount) => {
                        const notification = {
                          t: "nav",
                          epageCount: epageCount,
                          first: reportedPage.isFirstPage,
                          last: this.isLastPageForNotification(reportedPage),
                          metadata: this.opf.metadata,
                          docTitle:
                            this.opf.spine[reportedPosition.spineIndex].title,
                        };
                        // Always include epage so viewers can maintain the current
                        // page number. During previewSession (incremental update)
                        // resolve from the viewItem's page list, mirroring
                        // sendLocationNotification. Outside previewSession, use the
                        // existing spine.epage for the first-page case.
                        if (previewSession) {
                          const viewItem = this.opfView?.spineItems[reportedPosition.spineIndex];
                          if (viewItem) {
                            const pageIndexInView = viewItem.pages.indexOf(reportedPage);
                            const resolvedEpage = pageIndexInView >= 0
                              ? viewItem.item.epage + pageIndexInView
                              : undefined;
                            if (resolvedEpage !== undefined) {
                              notification["epage"] = resolvedEpage;
                            }
                          }
                        } else if (
                          reportedPage.isFirstPage ||
                          (reportedPosition.pageIndex == 0 &&
                            this.opf.spine[reportedPosition.spineIndex].epage)
                        ) {
                          notification["epage"] =
                            this.opf.spine[reportedPosition.spineIndex].epage;
                        }
                        this.callback(notification);
                      })
                      .then(() => {
                        trace("count-complete");
                        trace("remaining-pages-enter");
                        const r =
                          this.renderAllPages || previewSession
                            ? this.opfView.renderAllPages()
                            : Task.newResult(null);
                        r.thenAsync(() => {
                          trace("remaining-pages-complete:suffix-" + this.opfView.previewReusedSuffixPages);
                          if (previewSession?.isCurrent(this.previewRevision)) {
                            this.opf.setEPageCountMode(true);
                            let count = 0;
                            this.opf.spine.forEach((item, index) => {
                              item.epage = count;
                              item.epageCount =
                                this.opfView.spineItems[index]?.pages.length ||
                                0;
                              count += item.epageCount;
                            });
                            this.opf.epageCount = count;
                            return this.reportPosition();
                          }
                          return Task.newResult(true);
                        }).then(() => {
                          if (this.renderTask === resizeTask) {
                            this.renderTask = null;
                          }
                          Profile.profiler.registerEndTiming("render (resize)");
                          // JavaScript in HTML documents support
                          if (
                            Scripts.allowScripts &&
                            Scripts.hasScripts(this.window)
                          ) {
                            Scripts.loadScriptsAtEnd(this.window).then(() => {
                              if (this.renderAllPages) {
                                this.setReadyState(
                                  Constants.ReadyState.COMPLETE,
                                );
                              }
                              this.commitPreviewPages();
                              this.callback({ t: "loaded" });
                              frame.finish(p);
                            });
                          } else {
                            if (this.renderAllPages) {
                              this.setReadyState(Constants.ReadyState.COMPLETE);
                            }
                            this.commitPreviewPages();
                            trace("core-commit-complete");
                            this.callback({ t: "loaded" });
                            frame.finish(p);
                          }
                        });
                      });
                    });
                });
              });
          },
          (frame, err) => {
            if (err instanceof RenderingCanceledError) {
              Profile.profiler.registerEndTiming("render (resize)");
              Logging.logger.debug(err.message);
            } else {
              throw err;
            }
          },
        ),
      );
    return Task.newResult(true);
  }

  private sendLocationNotification(
    page: Vtree.Page,
    cfi: string | null,
  ): Task.Result<boolean> {
    const frame: Task.Frame<boolean> = Task.newFrame(
      "sendLocationNotification",
    );
    if (!this.opfView || !this.pagePosition) {
      frame.finish(false);
      return frame.result();
    }
    const viewItem = this.opfView.spineItems[this.pagePosition.spineIndex];
    if (!viewItem || !viewItem.complete) {
      frame.finish(false);
      return frame.result();
    }
    const notification = {
      t: "nav",
      first: page.isFirstPage,
      last: this.isLastPageForNotification(page),
      metadata: this.opf.metadata,
      docTitle: this.opf.spine[page.spineIndex].title,
    };
    const pageIndexInView = viewItem.pages.indexOf(page);
    const resolvedEpage = pageIndexInView >= 0 ? viewItem.item.epage + pageIndexInView : undefined;
    this.opf.getEPageFromPosition(this.pagePosition).then((epage) => {
      notification["epage"] = resolvedEpage ?? epage;
      notification["epageCount"] = this.opf.epageCount;
      if (cfi) {
        notification["cfi"] = cfi;
      }
      this.callback(notification);
      frame.finish(true);
    });
    return frame.result();
  }

  private isLastPageForNotification(page: Vtree.Page): boolean {
    if (!this.opfView || !this.pagePosition) {
      return page.isLastPage;
    }
    const viewItem = this.opfView.spineItems[this.pagePosition.spineIndex];
    if (!viewItem || !viewItem.complete) {
      return false;
    }
    const isLastSpine = viewItem.item.spineIndex === this.opf.spine.length - 1;
    const isLastPage =
      this.pagePosition.pageIndex === viewItem.pages.length - 1;
    return isLastSpine && isLastPage;
  }

  getCurrentPageProgression(): Constants.PageProgression | null {
    return this.opfView
      ? this.opfView.getCurrentPageProgression(this.pagePosition)
      : null;
  }

  moveTo(command: Base.JSON): Task.Result<boolean> {
    let method: () => Task.Result<Epub.PageAndPosition>;
    if (
      this.readyState !== Constants.ReadyState.COMPLETE &&
      command["where"] !== "next"
    ) {
      this.setReadyState(Constants.ReadyState.LOADING);
    }
    if (typeof command["where"] == "string") {
      let m: (
        position: Epub.Position,
        sync: boolean,
      ) => Task.Result<Epub.PageAndPosition>;
      switch (command["where"]) {
        case "next":
          m = this.pref.spreadView
            ? this.opfView.nextSpread
            : this.opfView.nextPage;
          break;
        case "previous":
          m = this.pref.spreadView
            ? this.opfView.previousSpread
            : this.opfView.previousPage;
          break;
        case "last":
          m = this.opfView.lastPage;
          break;
        case "first":
          m = this.opfView.firstPage;
          break;
        default:
          return Task.newResult(true);
      }
      method = () =>
        m.call(
          this.opfView,
          this.pagePosition,
          this.shouldLayoutSynchronously(),
        );
    } else if (typeof command["epage"] == "number") {
      const epage = command["epage"] as number;
      method = () =>
        this.opfView.navigateToEPage(
          epage,
          this.pagePosition,
          this.shouldLayoutSynchronously(),
        );
    } else if (typeof command["url"] == "string") {
      const url = command["url"] as string;
      method = () =>
        this.opfView.navigateTo(
          url,
          this.pagePosition,
          this.shouldLayoutSynchronously(),
        );
    } else if (typeof command["position"]?.spineIndex == "number") {
      const position = command["position"] as Epub.Position;
      method = () =>
        this.opfView.findPage(position, this.shouldLayoutSynchronously());
    } else {
      return Task.newResult(true);
    }
    if (!this.opfView) {
      return Task.newResult(true);
    }
    const pendingNavigation = this.tryPendingPreviewNavigation(command);
    if (pendingNavigation) return pendingNavigation;
    this.previewSession?.cancelPendingNavigation();
    const frame: Task.Frame<boolean> = Task.newFrame("moveTo");
    method.call(this.opfView).then((result) => {
      let cont: Task.Result<boolean>;
      if (result) {
        this.pagePosition = result.position;
        const innerFrame: Task.Frame<boolean> =
          Task.newFrame("moveTo.showCurrent");
        cont = innerFrame.result();
        this.showCurrent(result.page, this.shouldLayoutSynchronously()).then(
          () => {
            this.reportPosition().thenFinish(innerFrame);
          },
        );
      } else {
        cont = Task.newResult(true);
      }
      cont.then((res) => {
        if (this.readyState === Constants.ReadyState.LOADING) {
          this.setReadyState(Constants.ReadyState.INTERACTIVE);
        }
        frame.finish(res);
      });
    });
    return frame.result();
  }

  showTOC(command: Base.JSON): Task.Result<boolean> {
    const autohide = !!command["autohide"];
    const visibility = command["v"];
    const currentVisibility = this.opfView.isTOCVisible();
    const changeAutohide =
      autohide != this.opfView.tocAutohide && visibility != "hide";
    if (currentVisibility) {
      if (visibility == "show" && !changeAutohide) {
        return Task.newResult(true);
      }
    } else {
      if (visibility == "hide") {
        return Task.newResult(true);
      }
    }
    if (currentVisibility && visibility != "show") {
      this.opfView.hideTOC();
      return Task.newResult(true);
    } else {
      const frame: Task.Frame<boolean> = Task.newFrame("showTOC");
      this.opfView.showTOC(autohide).then((page) => {
        if (page) {
          if (changeAutohide) {
            page.listeners = {};
          }
          if (autohide) {
            const hideTOC = () => {
              this.opfView.hideTOC();
            };
            page.addEventListener("hyperlink", hideTOC, false);
            // page.container.addEventListener("click", hideTOC, false);
          }
          page.addEventListener("hyperlink", this.hyperlinkListener, false);
        }
        frame.finish(true);
      });
      return frame.result();
    }
  }

  runCommand(command: Base.JSON): Task.Result<boolean> {
    const actionName = command["a"] || "";
    return Task.handle(
      "runCommand",
      (frame) => {
        const action = this.actions[actionName];
        if (action) {
          action.call(this, command).then(() => {
            this.callback({ t: "done", a: actionName });
            frame.finish(true);
          });
        } else {
          Logging.logger.error("No such action:", actionName);
          frame.finish(true);
        }
      },
      (frame, err) => {
        if (err instanceof RenderingCanceledError) {
          // interrupt() resumes this frame on its own scheduler. Its handler
          // can run outside a task (e.g. a save notification), so do not finish
          // the frame synchronously here.
          return;
        }
        Logging.logger.error(err, "Error during action:", actionName);
        frame.finish(true);
      },
    );
  }

  initEmbed(cmd: Base.JSON | string): void {
    let command = maybeParse(cmd);
    let continuation: Task.Continuation<boolean> | null = null;
    const viewer = this;
    Task.start(() => {
      const frame: Task.Frame<boolean> = Task.newFrame("commandLoop");
      const scheduler = Task.currentTask().getScheduler();
      viewer.hyperlinkListener = (evt) => {
        const hrefEvent = evt as Vtree.PageHyperlinkEvent;
        const internal =
          hrefEvent.href.startsWith("#") ||
          viewer.packageURL.some((url) => hrefEvent.href.startsWith(url));
        if (internal) {
          evt.preventDefault();
          const msg = {
            t: "hyperlink",
            href: hrefEvent.href,
            internal: internal,
          };
          scheduler.run(() => {
            viewer.callback(msg);
            return Task.newResult(true);
          });
        }
      };
      frame
        .loopWithFrame((loopFrame) => {
          if (viewer.needResize) {
            viewer.resize().then(() => {
              loopFrame.continueLoop();
            });
          } else if (viewer.needRefresh) {
            if (viewer.currentPage) {
              viewer
                .showCurrent(viewer.currentPage, !this.renderAllPages)
                .then(() => {
                  loopFrame.continueLoop();
                });
            }
          } else if (command) {
            const cmd = command;
            command = null;
            if (
              viewer.isPreviewUpdate() ||
              cmd["a"] === "moveTo" ||
              typeof cmd["previewRevision"] === "number"
            ) {
              const revision = viewer.previewRevision;
              let commandSession: PreviewSession | null = null;
              const task = scheduler.run(() => {
                if (revision !== viewer.previewRevision)
                  return Task.newResult(false);
                const currentTask = Task.currentTask();
                const result = viewer.runCommand(cmd);
                commandSession = viewer.previewSession;
                if (commandSession?.isCurrent(revision)) {
                  commandSession.commandTask = currentTask;
                }
                return result;
              });
              task.join().then(() => {
                if (commandSession?.commandTask === task)
                  commandSession.commandTask = null;
                loopFrame.continueLoop();
              });
            } else {
              viewer.runCommand(cmd).then(() => loopFrame.continueLoop());
            }
          } else {
            const frameInternal: Task.Frame<boolean> =
              Task.newFrame("waitForCommand");
            continuation = frameInternal.suspend(this);
            frameInternal.result().then(() => {
              loopFrame.continueLoop();
            });
          }
        })
        .thenFinish(frame);
      return frame.result();
    });
    viewer.kick = () => {
      const cont = continuation;
      if (cont) {
        continuation = null;
        cont.schedule(true);
      }
    };
    viewer.sendCommand = (cmd) => {
      const incoming = maybeParse(cmd);
      if (typeof incoming["previewRevision"] === "number") {
        command = incoming;
        viewer.kick();
        return true;
      }
      if (
        viewer.isPreviewUpdate() &&
        viewer.opfView?.spineItems.some((item) => !item.complete) &&
        incoming["a"] === "moveTo" &&
        (incoming["where"] === "next" ||
          incoming["where"] === "previous" ||
          typeof incoming["position"]?.pageIndex === "number")
      ) {
        // Navigation must remain responsive while the load command continues
        // background pagination. The supported paths below either select an
        // existing page or display a placeholder; they never start a competing
        // layout task.
        Task.start(() => viewer.runCommand(incoming));
        return true;
      }
      if (command) {
        return false;
      }
      command = maybeParse(cmd);
      viewer.kick();
      return true;
    };
    this.window["adapt_command"] = viewer.sendCommand;
  }

  /**
   * Returns the DOM container for the page at the given epage (0-indexed).
   *
   * Searches in priority order:
   *   1. spineItems[n].pages[k].container — currently laid-out pages
   *   2. spineItems[n].previewSuffix.pages[k].container — suffix convergence
   *      candidates held for the current re-render
   *   3. previewSession.snapshots[src].pages[k].container — all pages from the
   *      previous revision, saved before spineItems were retired
   *
   * Returns null when no matching container is found (e.g. the very first
   * render before any page has been laid out).
   */
  getPageContainerForEpage(epage: number): HTMLElement | null {
    const spineItems = this.opfView?.spineItems;

    // 1. Currently laid-out pages in spineItems
    if (spineItems) {
      for (const item of spineItems) {
        if (!item) continue;
        const localIndex = epage - item.item.epage;
        if (localIndex >= 0 && localIndex < item.pages.length) {
          const container = item.pages[localIndex]?.container;
          if (container) return container;
        }
        // 2. previewSuffix holds convergence candidates for the suffix range
        if (item.previewSuffix) {
          const suffix = item.previewSuffix;
          const suffixLocalIndex = localIndex - suffix.firstPageIndex;
          if (
            suffixLocalIndex >= 0 &&
            suffixLocalIndex < suffix.pages.length
          ) {
            const container = suffix.pages[suffixLocalIndex]?.container;
            if (container?.ownerDocument === this.window.document)
              return container;
          }
        }
      }
    }

    // 3. Snapshots saved before spineItems were retired (covers the entire
    //    previous revision including pages that have been nulled out above)
    const snapshots = this.previewSession?.snapshots;
    if (snapshots && spineItems) {
      for (const item of spineItems) {
        if (!item) continue;
        const snapshot = snapshots.get(item.item.src);
        if (!snapshot) continue;
        const localIndex = epage - item.item.epage;
        if (localIndex >= 0 && localIndex < snapshot.pages.length) {
          const container = snapshot.pages[localIndex]?.container;
          if (container?.ownerDocument === this.window.document)
            return container;
        }
      }
    }

    // 4. When spineItems are all null (full re-render), fall back to snapshots
    //    keyed by src using the epage offset recorded in the snapshot source item
    if (snapshots) {
      for (const snapshot of snapshots.values()) {
        const spineEpage = snapshot.source.item.epage;
        const localIndex = epage - spineEpage;
        if (localIndex >= 0 && localIndex < snapshot.pages.length) {
          const container = snapshot.pages[localIndex]?.container;
          if (container?.ownerDocument === this.window.document)
            return container;
        }
      }
    }

    return null;
  }

  /** Return a page from the last fully committed client revision. */
  getLatestCommittedPageContainerForEpage(epage: number): HTMLElement | null {
    return this.committedPreview?.pagesByEpage.get(epage)?.container || null;
  }

  /**
   * Export the immutable inputs needed to fork the committed preview cache.
   * Importers clone page DOM before reuse, so the committed presentation stays
   * connected to this viewer.
   */
  getCommittedPreviewSnapshotSeed(): PreviewSnapshotSeed | null {
    const committed = this.committedPreview;
    return committed
      ? {
          clientRevision: committed.clientRevision,
          snapshots: committed.snapshots,
        }
      : null;
  }

  /** Prepare one complete detached committed cache for an isolated lane. */
  preparePreviewSnapshotSeed(seed: PreviewSnapshotSeed): PreviewSnapshotSeed {
    return {
      clientRevision: seed.clientRevision,
      snapshots: new Map(
        Array.from(seed.snapshots, ([url, snapshot]) => [
          url,
          clonePreviewSnapshotEagerlyForDocument(
            snapshot,
            this.window.document,
          ),
        ]),
      ),
    };
  }

  /** Return a page only when the caller's committed revision still matches. */
  getCommittedPageContainerForEpage(
    epage: number,
    clientRevision: number,
  ): HTMLElement | null {
    if (this.committedPreview?.clientRevision !== clientRevision) return null;
    return this.committedPreview.pagesByEpage.get(epage)?.container || null;
  }

  private getWorkingPageForEpage(epage: number): Vtree.Page | null {
    for (const item of this.opfView?.spineItems || []) {
      if (!item) continue;
      const localIndex = epage - item.item.epage;
      if (localIndex >= 0 && localIndex < item.pages.length) {
        return item.pages[localIndex] || null;
      }
    }
    return null;
  }

  private resolvePreviewDisplayUnit(
    epage: number,
    pageAt: (epage: number) => Vtree.Page | null,
    requireKnownPartner: boolean,
  ): { readonly epage: number; readonly page: Vtree.Page }[] | null {
    const page = pageAt(epage);
    if (!page) return null;
    if (!this.resolveSpreadView(null, page.dimensions)) return [{ epage, page }];

    const progression =
      this.viewportElement.getAttribute("data-vivliostyle-page-progression") ===
      Constants.PageProgression.RTL
        ? Constants.PageProgression.RTL
        : Constants.PageProgression.LTR;
    const partnerDelta =
      (progression === Constants.PageProgression.LTR &&
        page.side === Constants.PageSide.RIGHT) ||
      (progression === Constants.PageProgression.RTL &&
        page.side === Constants.PageSide.LEFT)
        ? -1
        : 1;
    const partnerEpage = epage + partnerDelta;
    const partner = pageAt(partnerEpage);
    if (!partner) {
      // During progressive preview, a missing partner means that the spread
      // is not ready yet. Do not infer a legitimate one-sided spread merely
      // from the absence of a page: the partner may still be under layout.
      // Keep the complete committed spread visible until both working pages
      // exist. Intentional one-sided spreads become visible at final commit.
      if (requireKnownPartner) return null;
      return [{ epage, page }];
    }
    if (partner.side === page.side) return [{ epage, page }];
    return page.side === Constants.PageSide.LEFT
      ? [
          { epage, page },
          { epage: partnerEpage, page: partner },
        ]
      : [
          { epage: partnerEpage, page: partner },
          { epage, page },
        ];
  }

  private displayPreviewUnit(
    root: HTMLElement,
    viewport: Vgen.Viewport,
    unit: { readonly epage: number; readonly page: Vtree.Page }[],
    presentation: "working" | "committed",
  ): void {
    const pages = unit.map(({ page }) => page);
    // Only completed presentation pages belong to display selection. Never
    // touch page containers inside layoutBox: those are live measurement DOM
    // used by the background pagination task, and hiding them can corrupt
    // geometry, page counts, and reference resolution.
    Array.from(viewport.contentContainer.children).forEach((child) => {
      if (
        child instanceof HTMLElement &&
        child.hasAttribute("data-vivliostyle-page-container")
      ) {
        Base.setCSSProperty(child, "display", "none");
      }
    });
    const spreadView = this.resolveSpreadView(null, pages[0].dimensions);
    // Direct preview selection is a real display transition, not merely a DOM
    // visibility change. Keep currentPage/currentSpread and their listeners in
    // sync so a later replacement or commit cannot combine this page with a
    // stale member of the previously displayed spread.
    if (spreadView) {
      this.showSpread({
        left:
          pages.find((page) => page.side === Constants.PageSide.LEFT) || null,
        right:
          pages.find((page) => page.side === Constants.PageSide.RIGHT) || null,
      });
    } else {
      this.showPage(pages[0]);
    }
    root.setAttribute(VIEWPORT_SPREAD_VIEW_ATTRIBUTE, spreadView.toString());
    this.viewportElement.setAttribute(
      VIEWPORT_SPREAD_VIEW_ATTRIBUTE,
      spreadView.toString(),
    );
    const dimensions = spreadView
      ? this.getSpreadDimensions({
          left:
            pages.find((page) => page.side === Constants.PageSide.LEFT) || null,
          right:
            pages.find((page) => page.side === Constants.PageSide.RIGHT) || null,
        })
      : pages[0].dimensions;
    viewport.zoom(
      dimensions.width,
      dimensions.height,
      this.getAdjustedZoomFactor(dimensions),
    );
    this.showPresentationRoot(root, presentation);
  }

  /**
   * Display an epage during an incremental update without moving or cloning
   * page DOM. A complete working page/spread wins; otherwise the last
   * committed presentation remains interactive. The chosen revision never
   * decreases for an epage.
   */
  showPreviewPageForEpage(
    epage: number,
    options: { zoom?: number; pageViewMode?: PageViewMode } = {},
  ):
    | {
        readonly presentation: "working" | "committed";
        readonly revision: number;
        readonly containers: readonly HTMLElement[];
      }
    | null {
    if (typeof options.zoom === "number") {
      this.zoom = options.zoom;
      this.fitToScreen = false;
    }
    if (options.pageViewMode) this.pageViewMode = options.pageViewMode;

    const workingRevision = this.previewSession?.clientRevision;
    const displayedUnit = this.displayedPreviewUnitsByEpage.get(epage);
    const alreadyDisplayed = displayedUnit?.revision ?? -1;
    if (
      this.previewSession?.isCurrent(this.previewRevision) &&
      workingRevision !== undefined &&
      workingRevision >= alreadyDisplayed &&
      this.viewport
    ) {
      const working = this.resolvePreviewDisplayUnit(
        epage,
        (candidate) => this.getWorkingPageForEpage(candidate),
        true,
      );
      // Reused prefix/suffix page objects are part of the working page array
      // but intentionally stay attached to committed DOM until commit.
      if (
        working &&
        working.every(
          ({ page }) =>
            page.container.closest(
              "[data-vivliostyle-preview-presentation]",
            ) === this.viewportRoot,
        )
      ) {
        this.displayPreviewUnit(
          this.viewportRoot,
          this.viewport,
          working,
          "working",
        );
        const result = {
          presentation: "working",
          revision: workingRevision,
          containers: working.map(({ page }) => page.container),
        } as const;
        for (const member of working) {
          this.displayedPreviewUnitsByEpage.set(member.epage, result);
        }
        return result;
      }
    }

    const committed = this.committedPreview;
    if (!committed || committed.clientRevision < alreadyDisplayed) {
      return displayedUnit?.containers.every((container) => container.isConnected)
        ? displayedUnit
        : null;
    }
    const pages = this.resolvePreviewDisplayUnit(
      epage,
      (candidate) => committed.pagesByEpage.get(candidate) || null,
      false,
    );
    if (!pages) {
      return displayedUnit?.containers.every((container) => container.isConnected)
        ? displayedUnit
        : null;
    }
    this.displayPreviewUnit(
      committed.root,
      committed.viewport,
      pages,
      "committed",
    );
    const result = {
      presentation: "committed",
      revision: committed.clientRevision,
      containers: pages.map(({ page }) => page.container),
    } as const;
    for (const member of pages) {
      this.displayedPreviewUnitsByEpage.set(member.epage, result);
    }
    return result;
  }

  /**
   * Return the currently selected working page/spread without navigating by
   * an epage from another revision. Used by terminal focused pagination.
   */
  getCurrentPreviewDisplayUnit():
    | {
        readonly revision: number;
        readonly epage: number;
        readonly containers: readonly HTMLElement[];
      }
    | null {
    const session = this.previewSession;
    const page = this.currentPage;
    if (
      !session?.isCurrent(this.previewRevision) ||
      !page ||
      !this.opfView
    ) return null;
    const pages = this.pref.spreadView && this.currentSpread
      ? [this.currentSpread.left, this.currentSpread.right].filter(
          (candidate): candidate is Vtree.Page => !!candidate,
        )
      : [page];
    if (!pages.length || pages.some((candidate) => !candidate.container.isConnected)) {
      return null;
    }
    const item = this.opfView.spineItems[page.spineIndex];
    const pageIndex = item?.pages.indexOf(page) ?? -1;
    if (!item || pageIndex < 0) return null;
    return {
      revision: session.clientRevision,
      epage: item.item.epage + pageIndex,
      containers: pages.map((candidate) => candidate.container),
    };
  }

  /**
   * Returns the 0-indexed epage of the page that contains the given source
   * offset within the spine item identified by url.
   *
   * The offset is the character position within the spine item's source
   * document, as recorded in Vtree.Page.offset during layout.
   *
   * The search is performed over currently laid-out pages in spineItems only.
   * If the target offset has not yet been laid out (e.g. during an incremental
   * update that has not reached the target page yet), returns null.
   *
   * For each matching spine item (by src URL), binary-searches the pages array
   * to find the page whose offset range [pages[k].offset, pages[k+1].offset)
   * contains the given offset. The last page in the spine item is assumed to
   * extend to +Infinity.
   */
  getEpageForSourceOffset(url: string, offset: number): number | null {
    const spineItems = this.opfView?.spineItems;
    if (!spineItems) return null;

    for (const item of spineItems) {
      if (!item) continue;
      if (item.item.src !== url) continue;

      const pages = item.pages;
      if (!pages || pages.length === 0) continue;

      // Binary search for the page whose offset range contains `offset`.
      // pages[k].offset is the source offset of the first character on that
      // page. We want the largest k such that pages[k].offset <= offset.
      let lo = 0;
      let hi = pages.length - 1;

      // If the offset is before the first page in this spine item, skip.
      if (pages[0].offset > offset) continue;

      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pages[mid].offset <= offset) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }

      // lo is the page index within this spine item.
      return item.item.epage + lo;
    }

    return null;
  }
}

/**
 * @enum {string}
 */
export enum ZoomType {
  FIT_INSIDE_VIEWPORT = "fit inside viewport",
}

/**
 * Error representing that the rendering has been canceled.
 */
class RenderingCanceledError extends Error {
  name: string = "RenderingCanceledError";
  message: string = "Page rendering has been canceled";
  stack: string;

  constructor() {
    super();
    // Set the prototype explicitly.
    // https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, RenderingCanceledError.prototype);
    this.stack = new Error().stack ?? "";
  }
}

export function maybeParse(cmd: any): Base.JSON {
  if (typeof cmd == "string") {
    return Base.stringToJSON(cmd);
  }
  return cmd;
}
