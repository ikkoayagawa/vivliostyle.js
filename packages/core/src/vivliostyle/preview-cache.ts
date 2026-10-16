// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
/** Conservative manuscript-update cache. Never used by normal loads or PDF. */
import * as Base from "./base";
import * as CssStyler from "./css-styler";
import * as Vtree from "./vtree";
import { copySourceFragments, prepareSourceFragmentRemap } from "./source-map";
import type { OPFViewItem } from "./epub";
import { isStaticSelfContainedSvg, isStaticSvgStyle } from "./preview-svg";
import { createPreviewBoundaryIndex, findPreviewBoundary } from "./preview-boundary-index";
import {
  comparePreviewDocuments,
  editedTextOffset,
  prepareSourceMetadataSync,
  SOURCE_MAP_ATTRIBUTES,
  type SourceMetadataPatches,
} from "./preview-diff";

export { comparePreviewDocuments, editedTextOffset } from "./preview-diff";

export type PreviewSnapshot = {
  source: OPFViewItem;
  pages: Vtree.Page[];
  positions: (Vtree.LayoutPosition | null)[];
  /** Destination realm for a forked snapshot; pages are cloned on adoption. */
  cloneDocument?: Document;
  /** Shared only by clones of a fully committed, immutable source snapshot. */
  committedAnalysis?: {
    result?: PreviewReuseAnalysis;
    styleSignatures?: WeakMap<Element, string>;
    /** Shared offsets only; no destination DOM or unfinished generation state. */
    boundaryOffsets?: readonly number[] | null;
  };
  reason?: string;
  layoutChanges?: string[];
  blockers?: PreviewReuseBlocker[];
};

/**
 * Copy a committed preview snapshot into another same-origin viewer realm.
 *
 * Layout positions intentionally keep referring to the source document: the
 * ordinary preview diff remaps those nodes to the incoming document before a
 * checkpoint is adopted. Page DOM, on the other hand, must be cloned. Moving
 * it would detach the paper that the committed viewer is still displaying.
 */
export function clonePreviewSnapshotForDocument(
  snapshot: PreviewSnapshot,
  document: Document,
): PreviewSnapshot {
  return {
    source: snapshot.source,
    pages: snapshot.pages,
    positions: snapshot.positions.slice(),
    cloneDocument: document,
    committedAnalysis: snapshot.committedAnalysis,
  };
}

/** Build a complete, detached committed cache in another viewer document. */
export function clonePreviewSnapshotEagerlyForDocument(
  snapshot: PreviewSnapshot,
  document: Document,
): PreviewSnapshot {
  return {
    source: snapshot.source,
    pages: snapshot.pages.map((page) =>
      clonePreviewPageForDocument(page, document),
    ),
    positions: snapshot.positions.slice(),
    committedAnalysis: snapshot.committedAnalysis,
  };
}

function clonePreviewPageForDocument(
  sourcePage: Vtree.Page,
  document: Document,
): Vtree.Page {
  const container = document.importNode(
    sourcePage.container,
    true,
  ) as HTMLElement;
  copySourceFragments(sourcePage.container, container);
  const bleedBox =
    (container.hasAttribute("data-vivliostyle-bleed-box")
      ? container
      : container.querySelector<HTMLElement>("[data-vivliostyle-bleed-box]")) ||
    container;
  const page = new Vtree.Page(container, bleedBox);
  page.pageAreaElement = container.querySelector<HTMLElement>(
    "[data-vivliostyle-page-area]",
  );
  page.dimensions = { ...sourcePage.dimensions };
  page.isFirstPage = sourcePage.isFirstPage;
  page.isLastPage = sourcePage.isLastPage;
  page.isBlankPage = sourcePage.isBlankPage;
  page.isAutoPageWidth = sourcePage.isAutoPageWidth;
  page.isAutoPageHeight = sourcePage.isAutoPageHeight;
  page.spineIndex = sourcePage.spineIndex;
  page.position = sourcePage.position;
  page.offset = sourcePage.offset;
  page.side = sourcePage.side;
  page.pageType = sourcePage.pageType;
  for (const element of Array.from(
    container.querySelectorAll<HTMLElement>("[id]"),
  )) {
    page.registerElementWithId(element, element.id);
  }
  if (container.id) page.registerElementWithId(container, container.id);
  return page;
}

function snapshotPage(snapshot: PreviewSnapshot, index: number): Vtree.Page {
  const page = snapshot.pages[index];
  // A finished Page still owns its page-float tree, whose columns retain the
  // entire old OPFView. Reuse paper DOM, never that live layout context. This
  // also applies to blank/generated pages without source-map fragments.
  return clonePreviewPageForDocument(
    page,
    snapshot.cloneDocument ?? page.container.ownerDocument,
  );
}

export type PreviewReuseBlocker =
  | "conditional-style"
  | "dependent-generated-content"
  | "embedded-content"
  | "named-flow-or-float"
  | "nested-columns"
  | "positioned-content"
  | "root-column-width"
  | "unsupported-formatting-context";

export type PreviewReuseAnalysis = {
  reusable: boolean;
  blockers: PreviewReuseBlocker[];
};

type PreviewCheckpoint = {
  pageIndex: number;
  signature: string;
};

export type PreviewSuffix = {
  firstPageIndex: number;
  pages: Vtree.Page[];
  positions: (Vtree.LayoutPosition | null)[];
  pageCounterStarts: OPFViewItem["pageCounterStarts"];
  checkpoints: PreviewCheckpoint[];
  sourceMetadata: SourceMetadataPatches;
  sourceNodes: ReadonlyMap<Node, Node>;
  complete: boolean;
  cloneDocument?: Document;
};

function createSourceMetadataPatches(
  old: OPFViewItem,
  item: OPFViewItem,
  nodes: Map<Node, Node>,
): SourceMetadataPatches {
  const patches = new Map<
    string,
    {
      elementOffset: string;
      attributes: ReadonlyMap<string, string | null>;
    }
  >();
  for (const [before, after] of nodes) {
    if (before.nodeType !== 1 || after.nodeType !== 1) continue;
    const oldOffset = String(old.xmldoc.getElementOffset(before as Element));
    const newElement = after as Element;
    patches.set(oldOffset, {
      elementOffset: String(item.xmldoc.getElementOffset(newElement)),
      attributes: new Map(
        SOURCE_MAP_ATTRIBUTES.map((attribute) => [
          attribute,
          newElement.getAttribute(attribute),
        ]),
      ),
    });
  }
  return patches;
}

function previewElementSignature(item: OPFViewItem, element: Element): string {
  const signature = styleSignature(
    CssStyler.readStyle(item.instance.styler,element, false),
  );
  const store = item.instance.counterStore;
  if (!store.hasPlainNamedStrings) return signature;
  const assignments = store.plainNamedStrings.get(
    item.xmldoc.getNodeOffset(element, 0, false),
  );
  // string-set is removed from the cascaded style. Preserve its evaluated value
  // in the existing portable style signature, including ancestor content().
  return assignments
    ? signature +
      "\npreview-string-set:" +
      JSON.stringify([...assignments].sort(([a], [b]) => a.localeCompare(b)))
    : signature;
}

function cleanHead(head: Element): string {
  const copy = head.cloneNode(true) as Element;
  [copy, ...Array.from(copy.querySelectorAll("*"))].forEach((element) =>
    element.removeAttribute(Base.ELEMENT_OFFSET_ATTR),
  );
  return copy.outerHTML;
}

function styleSignature(style: object): string {
  return Object.keys(style)
    .filter((name) => {
      const value = style[name];
      // Layout lazily installs empty bookkeeping arrays on a cascaded style.
      return (
        value != null &&
        !(typeof value === "object" && Object.keys(value).length === 0)
      );
    })
    .sort()
    .map((name) => {
      const value = style[name];
      if (value == null) return `${name}:null`;
      if (typeof value === "object" && "value" in value)
        return `${name}:${String(value.value)}`;
      if (typeof value === "object")
        return `${name}:{${styleSignature(value)}}`;
      return `${name}:${String(value)}`;
    })
    .join(";");
}

function styleValue(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === "object" && "value" in value) return String(value.value);
  return String(value);
}

function isHiddenZeroSizedAbsolute(style: object): boolean {
  return (
    styleValue(style["position"], "static") === "absolute" &&
    styleValue(style["width"], "auto") === "0" &&
    styleValue(style["height"], "auto") === "0" &&
    styleValue(style["overflow"], "visible") === "hidden"
  );
}

export function clonePreviewPosition(
  position: Vtree.LayoutPosition,
  nodes: Map<Node, Node>,
  portable = false,
): Vtree.LayoutPosition | null {
  const copy = position.clone();
  if (
    Object.keys(copy.flows).some((name) => name !== "body") ||
    Object.keys(copy.flowPositions).some((name) => name !== "body")
  )
    return null;
  copy.flows = { ...copy.flows };
  for (const [name, flow] of Object.entries(copy.flows)) {
    if (
      flow.formattingContext &&
      flow.formattingContext.formattingContextType !== "Block"
    )
      return null;
    const newFlow = new Vtree.Flow(
      flow.flowName,
      flow.parentFlowName,
      portable ? null : flow.formattingContext,
    );
    newFlow.forcedBreakOffsets = [...flow.forcedBreakOffsets];
    copy.flows[name] = newFlow;
  }
  for (const flow of Object.values(copy.flowPositions)) {
    for (const chunk of flow.positions) {
      if (chunk.chunkPosition.floats?.length) return null;
      const primary = chunk.chunkPosition.primary;
      const steps = [];
      for (const step of primary.steps) {
        const node = nodes.get(step.node);
        if (
          !node ||
          step.shadowContext ||
          step.nodeShadow ||
          step.shadowSibling ||
          (step.formattingContext &&
            step.formattingContext.formattingContextType !== "Block")
        )
          return null;
        steps.push({
          ...step,
          node,
          formattingContext: portable ? null : step.formattingContext,
        });
      }
      chunk.chunkPosition.primary = {
        ...primary,
        steps: steps as Vtree.NodePosition["steps"],
      };
      const element = nodes.get(chunk.flowChunk.element) as Element;
      if (!element) return null;
      const old = chunk.flowChunk;
      const replacement = new Vtree.FlowChunk(
        old.flowName,
        element,
        old.startOffset,
        old.priority,
        old.linger,
        old.exclusive,
        old.repeated,
        old.last,
        old.breakBefore,
      );
      replacement.startPage = old.startPage;
      // FlowChunkPosition.clone retains its readonly flowChunk; replace the entry.
      const index = flow.positions.indexOf(chunk);
      flow.positions[index] = new Vtree.FlowChunkPosition(
        chunk.chunkPosition,
        replacement,
      );
    }
  }
  if (copy.highestSeenNode) {
    copy.highestSeenNode = nodes.get(copy.highestSeenNode) || null;
  }
  return copy;
}

/**
 * Describe layout state that the current preview checkpoint cannot restore.
 *
 * This deliberately reports capabilities rather than trying to identify a
 * document genre. Callers can keep the conservative fallback while individual
 * blockers are replaced with restorable per-page state.
 */
export function analyzePreviewReuse(item: OPFViewItem): PreviewReuseAnalysis {
  const blockers = new Set<PreviewReuseBlocker>();
  if (item.instance.counterStore.hasDependentPreviewContent)
    blockers.add("dependent-generated-content");
  if (item.instance.counterStore.hasNamedPreviewContent)
    blockers.add("named-flow-or-float");
  if (
    item.xmldoc.body.querySelector(
      "math,table,script,style,link,iframe,object,video,audio,aside",
    )
  )
    blockers.add("embedded-content");
  for (const svg of Array.from(item.xmldoc.body.querySelectorAll("svg"))) {
    if (!isStaticSelfContainedSvg(svg)) blockers.add("embedded-content");
  }
  // Portable image paper must not retain a process-owned Blob URL or depend
  // on bytes that can change outside the caller's compatibility key.
  for (const image of item.xmldoc.body.querySelectorAll("img")) {
    if (!image.getAttribute("src")?.startsWith("data:") || image.hasAttribute("srcset")) blockers.add("embedded-content");
  }
  // Body target-counter(page) has portable reference state. Other dependent
  // content and references in page furniture retain the conservative gate.
  const forbidden = /target-(?:counters|text)\b|counter\(\s*pages\b|\brunning\s*\(/i;
  if (/target-(?:counter|counters|text)\b/i.test(styleSignature(item.instance.style.pageProps)) || forbidden.test(styleSignature(item.instance.style.pageProps)))
    blockers.add("dependent-generated-content");
  // Root column count is not a capability boundary. Reuse depends on the
  // actual page-boundary LayoutPosition being cloneable; unsupported column
  // formatting contexts therefore fall back at the checkpoint itself. Width-
  // driven columns remain blocked until their subpixel geometry is stable
  // between incremental and fresh layout.
  if (
    styleValue(item.instance.styler.rootStyle["column-width"], "auto") !==
    "auto"
  )
    blockers.add("root-column-width");
  for (const element of [
    item.xmldoc.body,
    ...Array.from(item.xmldoc.body.querySelectorAll("*")),
  ]) {
    const style = CssStyler.readStyle(item.instance.styler,element, false);
    const conditional = style["_viewConditionalStyles"];
    if (Array.isArray(conditional) && conditional.length)
      blockers.add("conditional-style");
    const signature = styleSignature(style);
    if (element.namespaceURI === "http://www.w3.org/2000/svg" && !isStaticSvgStyle(signature))
      blockers.add("embedded-content");
    if (forbidden.test(signature))
      blockers.add("dependent-generated-content");
    for (const [name, value] of Object.entries(style)) {
      if (!value || name.startsWith("_")) continue;
      const text = String(value["value"] ?? value);
      if (forbidden.test(text)) blockers.add("dependent-generated-content");
      if (
        ["float", "flow-into"].includes(name) &&
        text !== "none"
      )
        blockers.add("named-flow-or-float");
      if (
        name === "position" &&
        !["static", "relative"].includes(text) &&
        !isHiddenZeroSizedAbsolute(style)
      )
        blockers.add("positioned-content");
      if (name === "column-count" && !["auto", "1"].includes(text))
        blockers.add("nested-columns");
      if (name === "display" && /table|flex|grid/.test(text))
        blockers.add("unsupported-formatting-context");
    }
  }
  // The deep style walk above can discover and consume new dependencies.
  if (item.instance.counterStore.hasDependentPreviewContent)
    blockers.add("dependent-generated-content");
  if (item.instance.counterStore.hasNamedPreviewContent)
    blockers.add("named-flow-or-float");
  return { reusable: blockers.size === 0, blockers: [...blockers].sort() };
}

/** Unfinished snapshots deliberately have no cache and are always rechecked. */
export function analyzePreviewSnapshot(
  snapshot: PreviewSnapshot,
): PreviewReuseAnalysis {
  const cache = snapshot.committedAnalysis;
  if (cache?.result) return cache.result;
  const result = analyzePreviewReuse(snapshot.source);
  if (cache) {
    // Finish styling the source before recording signatures: a deep scan may
    // install bookkeeping on a style that was read earlier in that scan.
    const signatures = new WeakMap<Element, string>();
    if (result.reusable) {
      const item = snapshot.source;
      for (const element of [
        item.xmldoc.body,
        ...Array.from(item.xmldoc.body.querySelectorAll("*")),
      ]) {
        signatures.set(element, previewElementSignature(item, element));
      }
    }
    cache.result = result;
    cache.styleSignatures = signatures;
  }
  return result;
}

export function restorePreviewPrefix(
  snapshot: PreviewSnapshot,
  item: OPFViewItem,
): number {
  // Opt-in benchmark hook. No manuscript, attributes or resource URLs leave
  // Core; production callers install no hook and do not pay timing overhead.
  const report = (globalThis as unknown as {
    __ogenkouReuseProfile?: (sample: object) => void;
  }).__ogenkouReuseProfile;
  let phaseStart = report ? performance.now() : 0;
  const phases: Record<string, number> = {};
  let boundaryDiagnostic: object | undefined;
  const analysisCacheState = !snapshot.committedAnalysis
    ? "disabled"
    : snapshot.committedAnalysis.result
      ? "hit"
      : "miss";
  const mark = (name: string) => {
    if (!report) return;
    const now = performance.now();
    phases[name] = (phases[name] ?? 0) + now - phaseStart;
    phaseStart = now;
  };
  try {
    const old = snapshot.source;
    if (!old.previewLayoutKey || old.previewLayoutKey !== item.previewLayoutKey) {
      snapshot.reason = "layout-settings-changed";
      const before = old.previewLayoutKey ? JSON.parse(old.previewLayoutKey) : null;
      const after = item.previewLayoutKey ? JSON.parse(item.previewLayoutKey) : null;
      const names = ["preferences", "viewport.width", "viewport.height", "viewport.fontSize", "viewport.pixelRatio"];
      snapshot.layoutChanges = names.filter((_, index) =>
        !before || !after || JSON.stringify(before[index]) !== JSON.stringify(after[index]));
      if (before && after && snapshot.layoutChanges.includes("preferences")) {
        for (const name of ["spreadView", "pageBorder", "defaultPaperSize", "fontFamily", "lineHeight", "columnWidth", "horizontal", "hyphenate", "nightMode"]) {
          if (JSON.stringify(before[0]?.[name]) !== JSON.stringify(after[0]?.[name]))
            snapshot.layoutChanges.push("preferences." + name);
        }
      }
      return 0;
    }
    if (cleanHead(old.xmldoc.head) !== cleanHead(item.xmldoc.head)) {
      snapshot.reason = "head-changed";
      return 0;
    }
    if (old.instance.pageNumberOffset !== item.instance.pageNumberOffset) {
      snapshot.reason = "page-offset-changed";
      return 0;
    }
    const oldAnalysis = analyzePreviewSnapshot(snapshot);
    mark("oldAnalysisMs");
    if (item.instance.styler.cssWalkProfile) item.instance.styler.cssWalkProfile.phase = "analysis";
    const newAnalysis = analyzePreviewReuse(item);
    mark("newAnalysisMs");
    if (item.instance.styler.cssWalkProfile) item.instance.styler.cssWalkProfile.phase = "restore";
    if (!oldAnalysis.reusable || !newAnalysis.reusable) {
      snapshot.blockers = [
        ...new Set([...oldAnalysis.blockers, ...newAnalysis.blockers]),
      ].sort();
      snapshot.reason = "unsupported-layout";
      return 0;
    }
    mark("eligibilityMs");
    const diff = comparePreviewDocuments(old.xmldoc.body, item.xmldoc.body);
    mark("diffMs");
    const sourceMetadata = createSourceMetadataPatches(old, item, diff.nodes);
    mark("sourceMapMs");
    // Check all mapped elements: later structure and CSS selector dependencies
    // can affect earlier content, including across body-level containers.
    for (const [before, after] of diff.nodes) {
      if (before.nodeType === 1 &&
          (snapshot.committedAnalysis?.styleSignatures?.get(before as Element) ??
            previewElementSignature(old, before as Element)) !==
          previewElementSignature(item, after as Element)) {
        snapshot.reason = "prefix-style-changed";
        mark("styleCheckMs");
        return 0;
      }
    }
    mark("styleCheckMs");
    // Hard line breaks give authoring clients stable inline boundaries inside a
    // long source paragraph. Reuse through the line before the edit, while the
    // page lookbehind below still absorbs widows, orphans, and line reflow.
    let changed = diff.changed;
    let changedBlock = changed?.parentElement;
    while (
      changedBlock &&
      !/^(P|H[1-6]|DIV|SECTION|LI|BLOCKQUOTE)$/.test(changedBlock.nodeName)
    )
      changedBlock = changedBlock.parentElement;
    const hardLineBoundary =
      changed?.nodeType === 3 && changedBlock?.querySelector("br");
    if (!hardLineBoundary) {
      if (changed && changed.nodeType !== 1) changed = changed.parentNode;
      while (
        changed &&
        changed !== old.xmldoc.body &&
        !/^(P|H[1-6]|DIV|SECTION|LI|BLOCKQUOTE)$/.test(changed.nodeName)
      )
        changed = changed.parentNode;
    }
    // A keep-together ancestor or preceding keep-with-next block moves the safe
    // boundary back, rather than assuming a fixed one-page lookbehind is enough.
    if (changed) {
      for (
        let ancestor = changed.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = CssStyler.readStyle(old.instance.styler,ancestor, false);
        if (/avoid/.test(String(style["break-inside"]?.["value"] ?? "")))
          changed = ancestor;
      }
      if (changed.nodeType === 1) {
        while ((changed as Element).previousElementSibling) {
          const previous = (changed as Element).previousElementSibling;
          const style = CssStyler.readStyle(old.instance.styler,previous, false);
          if (!/avoid/.test(String(style["break-after"]?.["value"] ?? ""))) break;
          changed = previous;
        }
      }
    }
    const offset = changed
      ? old.xmldoc.getNodeOffset(changed, 0, false)
      : Infinity;
    const committedCache = snapshot.committedAnalysis;
    if (committedCache && committedCache.boundaryOffsets === undefined) {
      committedCache.boundaryOffsets = createPreviewBoundaryIndex(snapshot.positions.length, page => {
        const position = snapshot.positions[page];
        return position && snapshot.pages[page - 1] ? old.instance.getPosition(position, true) : null;
      });
    }
    mark("boundaryIndexMs");
    let count = 0;
    if (committedCache?.boundaryOffsets && !Number.isNaN(offset)) {
      count = findPreviewBoundary(committedCache.boundaryOffsets, offset);
    } else {
      // Mutable/incomplete snapshots and unusual offset ordering retain the
      // original scan. No safety boundary or lookbehind condition is relaxed.
      for (let i = 1; i < snapshot.positions.length; i++) {
        const position = snapshot.positions[i];
        if (!position || old.instance.getPosition(position, true) >= offset || !snapshot.pages[i - 1]) break;
        count = i;
      }
    }
    mark("boundaryLookupMs");
    if(report) boundaryDiagnostic={
      hardLineBoundary:!!hardLineBoundary,
      changedBlockHasHardBreak:!!changedBlock?.querySelector("br"),
      changedNodeOffset:diff.changed?old.xmldoc.getNodeOffset(diff.changed,0,false):null,
      parentMapped:!!diff.changed?.parentNode && diff.nodes.get(diff.changed.parentNode)===diff.target?.parentNode,
      oldDisplay:diff.changed?.nodeType===1?styleValue(CssStyler.readStyle(old.instance.styler,diff.changed as Element,false)["display"],"inline"):null,
      newDisplay:diff.target?.nodeType===1?styleValue(CssStyler.readStyle(item.instance.styler,diff.target as Element,false)["display"],"inline"):null,
      firstDifference:diff.changed?{nodeType:diff.changed.nodeType,nodeName:diff.changed.nodeName}:null,
      safeBoundaryNode:changed?.nodeName??null,safeBoundaryOffset:Number.isFinite(offset)?offset:null,
      snapshotPages:snapshot.pages.length,snapshotPositions:snapshot.positions.length,
      firstPagePosition:snapshot.positions[1]?old.instance.getPosition(snapshot.positions[1],true):null,
      prefixBeforeLookbehind:count,mappedNodes:diff.nodes.size,
    };
    count = Math.max(0, count - 1);
    // A removed target cannot trigger the resolver when new pages finish.
    // Rebuild its reference source as well, instead of retaining stale numbers.
    if (old.instance.counterStore.hasTargetPreviewReferences) {
      for (const reference of old.instance.counterStore.exportPreviewReferences().references) {
        if (!Object.hasOwn(item.instance.counterStore.countersById, reference.targetId)) count = Math.min(count, reference.pageIndex);
      }
    }
    if (!count) {
      item.previewSuffix = createPreviewSuffix(
        snapshot,
        item,
        diff.nodes,
        diff.suffixNodes,
        sourceMetadata,
        0,
      );
      snapshot.reason = "no-safe-prefix";
      return 0;
    }
    mark("boundaryMs");
    const positions: (Vtree.LayoutPosition | null)[] = [null];
    for (let i = 1; i <= count; i++) {
      const cloned = clonePreviewPosition(
        snapshot.positions[i],
        diff.nodes,
        !!snapshot.cloneDocument,
      );
      if (!cloned) {
        item.previewSuffix = createPreviewSuffix(
          snapshot,
          item,
          diff.nodes,
          diff.suffixNodes,
          sourceMetadata,
          0,
        );
        snapshot.reason = "unsupported-position";
        return 0;
      }
      // Styling may have scanned the whole old document. Its lookahead offsets
      // are not page breaks. Use fresh flow metadata from the new document.
      cloned.flows = item.instance.styler.flows;
      cloned.highestSeenOffset = item.instance.styler.lastOffset;
      cloned.highestSeenNode = null;
      positions.push(cloned);
    }
    item.layoutPositions = positions;
    mark("positionCloneMs");
    item.instance.preparePageGroupPageIndicesForRerender(positions, count, true);
    mark("pageGroupsMs");
    const prefixPages = Array.from({ length: count }, (_, index) =>
      snapshotPage(snapshot, index),
    );
    mark("pageDomMs");
    const metadataUpdates = prefixPages.map((page) =>
      prepareSourceMetadataSync(page.container, sourceMetadata),
    );
    const fragmentUpdates = prefixPages.map((page) => prepareSourceFragmentRemap(page.container, diff.nodes));
    if (metadataUpdates.some((update) => update === null) || fragmentUpdates.some((update) => update === null)) {
      item.previewSuffix = createPreviewSuffix(
        snapshot,
        item,
        diff.nodes,
        diff.suffixNodes,
        sourceMetadata,
        0,
      );
      snapshot.reason = "source-metadata-unmapped";
      return 0;
    }
    metadataUpdates.forEach((update) => update?.());
    fragmentUpdates.forEach((update) => update?.());
    mark("metadataSyncMs");
    item.pages = prefixPages;
    item.pageCounterStarts = old.pageCounterStarts
      .slice(0, count + 1)
      .map((values) =>
        Object.fromEntries(
          Object.entries(values).map(([name, counts]) => [name, [...counts]]),
        ),
      );
    item.pages.forEach((page, index) => {
      restorePageMetadata(item, page, positions[index], index);
      page.container.style.display = "none";
      // Keep reused DOM in the committed presentation while the new revision
      // is still working. AdaptiveViewer moves every adopted page into the
      // working viewport atomically when that revision commits.
    });
    if (old.instance.counterStore.hasTargetPreviewReferences) {
      item.instance.counterStore.restorePreviewReferences(old.instance.counterStore.exportPreviewReferences(), count);
    }
    item.previewSuffix = createPreviewSuffix(
      snapshot,
      item,
      diff.nodes,
      diff.suffixNodes,
      sourceMetadata,
      count,
    );
    snapshot.reason = "reused";
    mark("restoreAndSuffixMs");
    return count;
  } finally {
    if (item.instance.styler.cssWalkProfile) item.instance.styler.cssWalkProfile.phase = "layout";
    if (report) {
      mark("remainingMs");
      report({ phases, boundaryDiagnostic, analysisCacheState, layoutChanges: snapshot.layoutChanges, reason: snapshot.reason, reusedPages: item.pages.length });
    }
  }
}

function restorePageMetadata(
  item: OPFViewItem,
  page: Vtree.Page,
  position: Vtree.LayoutPosition | null,
  pageIndex: number,
): void {
  page.position = position;
  page.offset = item.instance.getPosition(position, true);
  page.spineIndex = item.item.spineIndex;
  page.isFirstPage = item.item.spineIndex === 0 && pageIndex === 0;
  page.isLastPage = item.complete && pageIndex === item.pages.length - 1;
  page.container.setAttribute("data-vivliostyle-page-index", String(pageIndex));
  page.container.setAttribute(
    "data-vivliostyle-spine-index",
    String(page.spineIndex),
  );
}

function cloneCounterStarts(
  values: OPFViewItem["pageCounterStarts"],
): OPFViewItem["pageCounterStarts"] {
  return values.map((counters) =>
    Object.fromEntries(
      Object.entries(counters).map(([name, counts]) => [name, [...counts]]),
    ),
  );
}

function sameCounters(
  first: OPFViewItem["pageCounterStarts"][number],
  second: OPFViewItem["pageCounterStarts"][number],
): boolean {
  const names = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const name of names) {
    const a = first[name] || [];
    const b = second[name] || [];
    if (a.length !== b.length || a.some((value, index) => value !== b[index]))
      return false;
  }
  return true;
}

function counterSignature(
  counters: OPFViewItem["pageCounterStarts"][number],
): string {
  return JSON.stringify(
    Object.keys(counters)
      .sort()
      .map((name) => [name, counters[name]]),
  );
}

function checkpointSignature(
  item: OPFViewItem,
  position: Vtree.LayoutPosition,
  counters: OPFViewItem["pageCounterStarts"][number],
  pageType: string | null,
): string {
  return JSON.stringify([
    position.page,
    position.isBlankPage,
    pageType,
    item.instance.getPosition(position, true),
    Object.keys(position.flowPositions).sort(),
    counterSignature(counters),
  ]);
}

function startsInUnchangedSuffix(
  position: Vtree.LayoutPosition,
  suffixNodes: Set<Node>,
): boolean {
  const primary =
    position.flowPositions.body?.positions[0]?.chunkPosition.primary;
  return !!primary?.steps.some((step) => suffixNodes.has(step.node));
}

function createPreviewSuffix(
  snapshot: PreviewSnapshot,
  item: OPFViewItem,
  nodes: Map<Node, Node>,
  suffixNodes: Set<Node>,
  sourceMetadata: SourceMetadataPatches,
  prefixCount: number,
): PreviewSuffix | undefined {
  const old = snapshot.source;
  if (!old.complete) return undefined;
  // A matching page break alone cannot prove that the carried chapter value
  // matches. Prefix reuse is safe; suffix convergence needs a string checkpoint.
  if (item.instance.counterStore.hasPlainNamedStrings || item.instance.counterStore.hasTargetPreviewReferences) return undefined;
  const firstCandidate = prefixCount + 1;
  if (firstCandidate >= snapshot.pages.length) return undefined;

  // Clone every possible convergence boundary once. If a position cannot be
  // restored, boundaries at or before it cannot safely adopt the complete old
  // suffix, but later self-contained boundaries remain eligible.
  const cloned = snapshot.positions.map((candidate) =>
    candidate
      ? clonePreviewPosition(candidate, nodes, !!snapshot.cloneDocument)
      : null,
  );
  let firstRestorablePageIndex = firstCandidate;
  for (let pageIndex = firstCandidate; pageIndex < cloned.length; pageIndex++) {
    if (!cloned[pageIndex]) firstRestorablePageIndex = pageIndex + 1;
  }
  if (firstRestorablePageIndex >= snapshot.pages.length) return undefined;

  const candidatePageIndices: number[] = [];
  for (
    let pageIndex = firstRestorablePageIndex;
    pageIndex < snapshot.pages.length;
    pageIndex++
  ) {
    const original = snapshot.positions[pageIndex];
    if (original && startsInUnchangedSuffix(original, suffixNodes))
      candidatePageIndices.push(pageIndex);
  }
  if (!candidatePageIndices.length) return undefined;
  const firstPageIndex = candidatePageIndices[0];

  const positions = cloned.slice(firstPageIndex);
  const pageCounterStarts = cloneCounterStarts(
    old.pageCounterStarts.slice(firstPageIndex),
  );
  const checkpoints: PreviewCheckpoint[] = [];
  for (const pageIndex of candidatePageIndices) {
    const position = positions[pageIndex - firstPageIndex];
    const counters = pageCounterStarts[pageIndex - firstPageIndex];
    if (position && counters) {
      checkpoints.push({
        pageIndex,
        signature: checkpointSignature(
          item,
          position,
          counters,
          snapshot.pages[pageIndex - 1]?.pageType ?? null,
        ),
      });
    }
  }
  if (!checkpoints.length) return undefined;
  return {
    firstPageIndex,
    pages: snapshot.pages.slice(firstPageIndex),
    positions,
    pageCounterStarts,
    checkpoints,
    sourceMetadata,
    sourceNodes: nodes,
    complete: true,
    cloneDocument: snapshot.cloneDocument,
  };
}

export function restorePreviewSuffix(
  item: OPFViewItem,
  position: Vtree.LayoutPosition,
  currentCounters: OPFViewItem["pageCounterStarts"][number],
  currentPageType: string | null,
): number {
  const suffix = item.previewSuffix;
  if (!suffix) return 0;

  while (
    suffix.checkpoints.length &&
    suffix.checkpoints[0].pageIndex < position.page
  )
    suffix.checkpoints.shift();
  const checkpoint = suffix.checkpoints[0];
  if (!checkpoint || checkpoint.pageIndex !== position.page) return 0;

  const offset = checkpoint.pageIndex - suffix.firstPageIndex;
  const cachedPosition = suffix.positions[offset];
  const cachedCounters = suffix.pageCounterStarts[offset];
  if (
    !cachedPosition ||
    !cachedCounters ||
    checkpoint.signature !==
      checkpointSignature(item, position, currentCounters, currentPageType) ||
    !position.isSamePosition(cachedPosition) ||
    !sameCounters(currentCounters, cachedCounters)
  ) {
    suffix.checkpoints.shift();
    return 0;
  }

  const positions = suffix.positions.slice(offset);
  const pages = suffix.pages
    .slice(offset)
    .map((page) =>
      clonePreviewPageForDocument(
        page,
        suffix.cloneDocument ?? page.container.ownerDocument,
      ),
    );
  const pageCounterStarts = suffix.pageCounterStarts.slice(offset);
  const metadataUpdates = pages.map((page) =>
    prepareSourceMetadataSync(page.container, suffix.sourceMetadata),
  );
  const fragmentUpdates = pages.map((page) => prepareSourceFragmentRemap(page.container, suffix.sourceNodes));
  if (metadataUpdates.some((update) => update === null) || fragmentUpdates.some((update) => update === null)) {
    suffix.checkpoints.shift();
    return 0;
  }
  metadataUpdates.forEach((update) => update?.());
  fragmentUpdates.forEach((update) => update?.());

  item.layoutPositions.splice(
    checkpoint.pageIndex,
    item.layoutPositions.length - checkpoint.pageIndex,
    ...positions,
  );
  item.pages.splice(
    checkpoint.pageIndex,
    item.pages.length - checkpoint.pageIndex,
    ...pages,
  );
  item.pageCounterStarts.splice(
    checkpoint.pageIndex,
    item.pageCounterStarts.length - checkpoint.pageIndex,
    ...pageCounterStarts,
  );
  item.complete = suffix.complete;
  pages.forEach((page, index) => {
    restorePageMetadata(
      item,
      page,
      positions[index],
      checkpoint.pageIndex + index,
    );
    page.container.style.display = "none";
    // Do not detach a reusable suffix from the committed presentation until
    // the working revision commits. The page object may be referenced by both
    // generations temporarily, but its DOM keeps one owner throughout.
  });
  item.previewSuffix = undefined;
  return pages.length;
}
