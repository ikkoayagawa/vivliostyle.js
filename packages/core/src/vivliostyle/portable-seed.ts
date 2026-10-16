// Ogenkou fork addition (2026-10-09): portable, completed body-flow seeds.
import * as Vtree from "./vtree";
import type { OPFView } from "./epub";
import { analyzePreviewSnapshot, clonePreviewPosition } from "./preview-cache";
import type { PreviewSnapshotSeed } from "./adaptive-viewer";
import type { CounterValues } from "./css-cascade";
import type { PreviewReferenceState } from "./counters";
import {
  createSourcePathIndex,
  exportSourceTexts,
  exportSourceFragments,
  importSourceFragments,
  type SourceTextEntry,
  type SerializedSourceFragment,
} from "./source-map";

/** A compatibility key must identify the exact Core build, CSS and font resources.
 * Packets are trusted output of the same Core build, not arbitrary external HTML.
 */
export type PortableSeedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PortableSeedValue[]
  | { [key: string]: PortableSeedValue };

export type PortablePreviewSeed = {
  readonly format: "vivliostyle-portable-body-v1";
  readonly compatibilityKey: string;
  readonly clientRevision: number;
  readonly snapshots: readonly {
    readonly url: string;
    readonly sourceHtml: string;
    readonly sourceTexts?: readonly SourceTextEntry[];
    readonly hasSplitTextNodes?: boolean;
    readonly nodeSignatures: readonly [number, string, string | null, number][];
    readonly positions: readonly PortableSeedValue[];
    readonly styles: readonly [number, string][];
    readonly previewLayoutKey: string;
    readonly pageNumberOffset: number;
    readonly pageCounterStarts: CounterValues[];
    readonly references?: PreviewReferenceState;
    readonly pages: readonly {
      html: string;
      sourceMap?: readonly SerializedSourceFragment[];
      nodeSignatures?: readonly [number, string, string | null, number][];
      properties: Pick<Vtree.Page, (typeof pageKeys)[number]>;
    }[];
  }[];
};

/** Internal request owned by one viewer/load command, never a prototype hook. */
export type PortableSeedImportRequest = {
  payload: PortablePreviewSeed;
  compatibilityKey: string;
  skipInitialPage: boolean;
  onRestored: (
    seed: PreviewSnapshotSeed,
    prepareMs: number,
    hydrateMs: number,
  ) => void;
  onFailed: (error: Error) => void;
};

export class PortableSeedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PortableSeedError";
  }
}

export function validatePortableSeed(
  payload: PortablePreviewSeed,
  key: string,
): void {
  if (
    !key ||
    !payload ||
    payload.format !== "vivliostyle-portable-body-v1" ||
    payload.compatibilityKey !== key
  )
    throw new PortableSeedError(
      "compatibility",
      "Portable compatibility mismatch",
    );
  if (
    !Number.isSafeInteger(payload.clientRevision) ||
    !Array.isArray(payload.snapshots) ||
    payload.snapshots.length !== 1
  )
    throw new PortableSeedError(
      "structure",
      "Portable v1 requires one revisioned source document",
    );
  const saved = payload.snapshots[0];
  if (
    !saved ||
    typeof saved.url !== "string" ||
    typeof saved.sourceHtml !== "string" ||
    !Array.isArray(saved.nodeSignatures) ||
    !Array.isArray(saved.positions) ||
    !Array.isArray(saved.styles) ||
    !Array.isArray(saved.pages) ||
    !saved.pages.length ||
    saved.positions.length < saved.pages.length ||
    typeof saved.previewLayoutKey !== "string" ||
    !Number.isFinite(saved.pageNumberOffset) ||
    !Array.isArray(saved.pageCounterStarts)
  )
    throw new PortableSeedError("structure", "Invalid portable source state");
  for (const page of saved.pages) {
    const properties = page?.properties;
    if (
      typeof page?.html !== "string" ||
      !properties ||
      properties.spineIndex !== 0 ||
      !Number.isFinite(properties.offset) ||
      !properties.dimensions ||
      !Number.isFinite(properties.dimensions.width) ||
      properties.dimensions.width <= 0 ||
      !Number.isFinite(properties.dimensions.height) ||
      properties.dimensions.height <= 0
    )
      throw new PortableSeedError("structure", "Invalid portable page state");
  }
  if (saved.references) {
    const state = saved.references;
    const position = (row: { spineIndex: number; pageIndex: number }) => row.spineIndex === 0 && Number.isSafeInteger(row.pageIndex) && row.pageIndex >= 0 && row.pageIndex < saved.pages.length;
    const counters = (value: CounterValues | null) => value === null || value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(values => Array.isArray(values) && values.every(Number.isFinite));
    if (!Array.isArray(state.targets) || !Array.isArray(state.references) ||
        state.targets.some(row => !row || typeof row.id !== "string" || !position(row) || !row.counters || !counters(row.counters) || row.docCounters !== undefined && !counters(row.docCounters)) ||
        state.references.some(row => !row || typeof row.targetId !== "string" || typeof row.resolved !== "boolean" || !position(row) || !counters(row.pageCounters))) {
      throw new PortableSeedError("structure", "Invalid portable reference state");
    }
  }
}

const classes = {
  LayoutPosition: Vtree.LayoutPosition,
  Flow: Vtree.Flow,
  FlowPosition: Vtree.FlowPosition,
  FlowChunk: Vtree.FlowChunk,
  FlowChunkPosition: Vtree.FlowChunkPosition,
  ChunkPosition: Vtree.ChunkPosition,
};
export function nodesIn(root: Node): Node[] {
  const result: Node[] = [];
  function visit(node: Node) {
    result.push(node);
    for (const child of node.childNodes) visit(child);
  }
  visit(root);
  return result;
}
export const nodeSignature = (node: Node): [number, string, string | null, number] => [
  node.nodeType,
  node.nodeName,
  node.nodeValue,
  node.childNodes.length,
];

/** HTML serialization coalesces adjacent TextNodes created by source polyfills.
 * Restore only those boundaries, guarded by exact parsed text and element shape.
 * No markup/characters are inserted into the source.
 */
export function restorePortableSourceBoundaries(
  root: Node,
  signatures: PortablePreviewSeed["snapshots"][number]["nodeSignatures"],
): void {
  const document = root.ownerDocument!;
  let index = 0;
  function align(node: Node): void {
    const saved = signatures[index++];
    if (
      !saved ||
      saved[0] !== node.nodeType ||
      saved[1] !== node.nodeName ||
      saved[2] !== node.nodeValue ||
      !Number.isSafeInteger(saved[3]) ||
      saved[3] < 0
    )
      throw new PortableSeedError(
        "source",
        `Portable source structure mismatch: expected ${saved?.[1] ?? "missing"}, received ${node.nodeName}`,
      );
    const parsed = Array.from(node.childNodes),
      restored: Node[] = [];
    let parsedIndex = 0;
    for (let childIndex = 0; childIndex < saved[3]; childIndex++) {
      const next = signatures[index];
      if (next?.[0] === 3) {
        const children: Text[] = [];
        let text = "";
        do {
          const part = signatures[index++];
          if (
            part[1] !== "#text" ||
            typeof part[2] !== "string" ||
            part[3] !== 0
          )
            throw new PortableSeedError(
              "source",
              "Invalid portable source text boundary",
            );
          text += part[2];
          children.push(document.createTextNode(part[2]));
          if (childIndex + 1 >= saved[3] || signatures[index]?.[0] !== 3) break;
          childIndex++;
        } while (true);
        if (text) {
          const actual = parsed[parsedIndex++];
          if (!actual || actual.nodeType !== 3 || actual.nodeValue !== text)
            throw new PortableSeedError(
              "source",
              "Portable source text mismatch",
            );
        }
        restored.push(...children);
      } else {
        const child = parsed[parsedIndex++];
        if (!child)
          throw new PortableSeedError(
            "source",
            "Missing portable source child",
          );
        align(child);
        restored.push(child);
      }
    }
    if (parsedIndex !== parsed.length)
      throw new PortableSeedError("source", "Unexpected portable source child");
    if (saved[3]) (node as Element).replaceChildren(...restored);
  }
  align(root);
  if (index !== signatures.length)
    throw new PortableSeedError("source", "Trailing portable source state");
}
const pageKeys = [
  "dimensions",
  "isFirstPage",
  "isLastPage",
  "isBlankPage",
  "isAutoPageWidth",
  "isAutoPageHeight",
  "spineIndex",
  "offset",
  "side",
  "pageType",
] as const;

/** Only completed conservative body-flow snapshots are accepted. */
export function serializePortableSeed(
  seed: PreviewSnapshotSeed,
  compatibilityKey: string,
): PortablePreviewSeed {
  if (
    !compatibilityKey ||
    !seed ||
    !Number.isSafeInteger(seed.clientRevision) ||
    seed.snapshots.size !== 1
  )
    throw new PortableSeedError(
      "unsupported",
      "Portable v1 requires one completed source document",
    );
  const snapshots = [...seed.snapshots].map(([url, snapshot]) => {
    if (!snapshot.source.complete || !snapshot.committedAnalysis)
      throw new PortableSeedError("unsupported", "Incomplete portable source");
    const analysis = analyzePreviewSnapshot(snapshot);
    if (!analysis.reusable)
      throw new PortableSeedError(
        "unsupported",
        `Unsupported portable source: ${analysis.blockers.join(",")}`,
      );
    const source = snapshot.source;
    const nodes = nodesIn(source.xmldoc.document.documentElement);
    const index = new Map(nodes.map((node, id) => [node, id]));
    const identity = new Map(nodes.map((node) => [node, node]));
    const sourcePaths = createSourcePathIndex(
      source.xmldoc.document.documentElement,
    );
    // Check all formatting/shadow/float state before dropping supported Block contexts.
    for (const position of snapshot.positions)
      if (position && !clonePreviewPosition(position, identity, true))
        throw new PortableSeedError(
          "unsupported",
          "Unsupported portable layout position",
        );
    function encode(value: any): PortableSeedValue {
      if (
        value == null ||
        typeof value === "string" ||
        typeof value === "boolean"
      )
        return value;
      if (typeof value === "number")
        return Number.isFinite(value) ? value : { number: String(value) };
      if (index.has(value)) {
        return { node: index.get(value) };
      }
      if (Array.isArray(value)) return value.map(encode);
      if (typeof value !== "object")
        throw new PortableSeedError("structure", "Non-data portable state");
      const proto = Object.getPrototypeOf(value);
      const className = Object.keys(classes).find(
        (name) => proto === classes[name].prototype,
      );
      if (!className && proto !== Object.prototype && proto !== null)
        throw new PortableSeedError(
          "unsupported",
          "Unknown portable state class",
        );
      const fields = {};
      for (const [key, field] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new PortableSeedError("structure", "Reserved state field");
        if (key === "formattingContext") fields[key] = null;
        else if (key === "highestSeenNode") fields[key] = null;
        else fields[key] = encode(field);
      }
      return { class: className ?? "Object", fields };
    }
    return {
      url,
      sourceHtml: source.xmldoc.document.documentElement.outerHTML,
      sourceTexts: exportSourceTexts(source.xmldoc.document.documentElement),
      hasSplitTextNodes: nodes.some(
        (node) => node.nodeType === 3 && node.previousSibling?.nodeType === 3,
      ),
      nodeSignatures: nodes.map(nodeSignature),
      positions: snapshot.positions.map(encode),
      styles: nodes.flatMap((node, id) =>
        node.nodeType === 1 &&
        snapshot.committedAnalysis.styleSignatures?.has(node as Element)
          ? [
              [
                id,
                snapshot.committedAnalysis.styleSignatures.get(node as Element),
              ] as [number, string],
            ]
          : [],
      ),
      previewLayoutKey: source.previewLayoutKey,
      pageNumberOffset: source.instance.pageNumberOffset,
      pageCounterStarts: structuredClone(source.pageCounterStarts),
      ...(source.instance.counterStore.hasTargetPreviewReferences ? { references: source.instance.counterStore.exportPreviewReferences() } : {}),
      pages: snapshot.pages.map((page) => {
        const sourceMap = exportSourceFragments(
          page.container,
          source.xmldoc.document.documentElement,
          sourcePaths,
        );
        return {
          html: page.container.outerHTML,
          ...(sourceMap.length
            ? {
                sourceMap,
                nodeSignatures: nodesIn(page.container).map(nodeSignature),
              }
            : {}),
          properties: Object.fromEntries(
            pageKeys.map((key) => [key, page[key]]),
          ) as Pick<Vtree.Page, (typeof pageKeys)[number]>,
        };
      }),
    };
  });
  const payload = {
    format: "vivliostyle-portable-body-v1" as const,
    compatibilityKey,
    clientRevision: seed.clientRevision,
    snapshots,
  };
  // Catch accidental DOM/functions/prototypes in the outbound contract.
  return structuredClone(payload);
}

/** Restore into a prepared local StyleInstance, without paginating the prefix.
 * Validate and reconstruct all data before replacing the source state.
 */
export function restorePortableSeed(
  view: OPFView,
  window: Window,
  payload: PortablePreviewSeed,
  compatibilityKey: string,
  apply = true,
): PreviewSnapshotSeed {
  validatePortableSeed(payload, compatibilityKey);
  const items = view?.spineItems;
  if (!items || payload.snapshots.length !== 1)
    throw new PortableSeedError(
      "structure",
      "Portable destination not initialized",
    );
  const snapshots = new Map();
  for (const saved of payload.snapshots) {
    const source = items.find((item) => item?.item.src === saved.url);
    if (
      !source ||
      source.previewLayoutKey !== saved.previewLayoutKey ||
      source.instance.pageNumberOffset !== saved.pageNumberOffset
    )
      throw new PortableSeedError("layout", "Portable layout mismatch");
    const nodes = nodesIn(source.xmldoc.document.documentElement);
    if (
      JSON.stringify(nodes.map(nodeSignature)) !==
      JSON.stringify(saved.nodeSignatures)
    )
      throw new PortableSeedError("source", "Portable source node mismatch");
    function decode(value: any): any {
      if (value == null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(decode);
      if ("node" in value) {
        if (!Number.isSafeInteger(value.node) || !nodes[value.node])
          throw new PortableSeedError(
            "structure",
            "Invalid source node address",
          );
        return nodes[value.node];
      }
      if ("number" in value) {
        if (!["Infinity", "-Infinity", "NaN"].includes(value.number))
          throw new PortableSeedError("structure", "Invalid numeric state");
        return Number(value.number);
      }
      if (
        !value.fields ||
        typeof value.fields !== "object" ||
        Object.keys(value.fields).some((key) =>
          ["__proto__", "constructor", "prototype"].includes(key),
        )
      )
        throw new PortableSeedError(
          "structure",
          "Invalid portable state fields",
        );
      const fields = Object.fromEntries(
        Object.entries(value.fields).map(([key, field]) => [
          key,
          decode(field),
        ]),
      );
      let instance: any;
      switch (value.class) {
        case "Object":
          return fields;
        case "LayoutPosition":
          instance = new Vtree.LayoutPosition();
          break;
        case "Flow":
          instance = new Vtree.Flow(
            fields.flowName,
            fields.parentFlowName,
            null,
          );
          break;
        case "FlowPosition":
          instance = new Vtree.FlowPosition();
          break;
        case "FlowChunk":
          instance = new Vtree.FlowChunk(
            fields.flowName,
            fields.element,
            fields.startOffset,
            fields.priority,
            fields.linger,
            fields.exclusive,
            fields.repeated,
            fields.last,
            fields.breakBefore,
          );
          break;
        case "ChunkPosition":
          instance = new Vtree.ChunkPosition(fields.primary);
          break;
        case "FlowChunkPosition":
          instance = new Vtree.FlowChunkPosition(
            fields.chunkPosition,
            fields.flowChunk,
          );
          break;
        default:
          throw new PortableSeedError("structure", "Unknown portable class");
      }
      return Object.assign(instance, fields);
    }
    const positions = saved.positions.map(decode);
    const doc = window.document;
    const pages = saved.pages.map((savedPage) => {
      const template = doc.createElement("template");
      template.innerHTML = savedPage.html;
      const container = template.content.firstElementChild as HTMLElement;
      if (!container || template.content.children.length !== 1)
        throw new PortableSeedError("structure", "Invalid portable page DOM");
      const bleed = container.matches("[data-vivliostyle-bleed-box]")
        ? container
        : ((container.querySelector(
            "[data-vivliostyle-bleed-box]",
          ) as HTMLElement) ?? container);
      const page = new Vtree.Page(container, bleed);
      if (savedPage.nodeSignatures)
        restorePortableSourceBoundaries(container, savedPage.nodeSignatures);
      if (savedPage.sourceMap)
        importSourceFragments(
          container,
          source.xmldoc.document.documentElement,
          savedPage.sourceMap,
        );
      Object.assign(page, structuredClone(savedPage.properties));
      page.pageAreaElement = container.querySelector(
        "[data-vivliostyle-page-area]",
      );
      for (const element of container.querySelectorAll("[id]"))
        page.registerElementWithId(element, element.id);
      return page;
    });
    const styleSignatures = new WeakMap<Element, string>();
    for (const [id, signature] of saved.styles) {
      if (
        !Number.isSafeInteger(id) ||
        nodes[id]?.nodeType !== 1 ||
        typeof signature !== "string"
      )
        throw new PortableSeedError(
          "structure",
          "Invalid portable style address",
        );
      styleSignatures.set(nodes[id] as Element, signature as string);
    }
    // Keep the initialized source immutable as a cache donor. It is never resumed.
    if (apply) {
      source.complete = true;
      source.pageCounterStarts = structuredClone(saved.pageCounterStarts);
      source.layoutPositions = positions;
      source.pages = pages;
      if (saved.references) source.instance.counterStore.restorePreviewReferences(saved.references, pages.length);
    }
    snapshots.set(saved.url, {
      source,
      pages,
      positions,
      cloneDocument: doc,
      committedAnalysis: {
        result: { reusable: true, blockers: [] },
        styleSignatures,
      },
    });
  }
  return { clientRevision: payload.clientRevision, snapshots };
}
