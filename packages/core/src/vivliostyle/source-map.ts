// Ogenkou fork addition: text-fragment correspondence, independent of layout CSS.
import type { Change } from "./diff";

export type SourceTextKind =
  "text" | "ruby-base" | "ruby-reading" | "generated";

/** childNodes indexes from the parsed documentElement; text guards parser drift. */
export type SourceTextEntry = {
  path: readonly number[];
  key: string;
  text: string;
  /** Offset in the original keyed generated text when Core has split a node. */
  offset?: number;
  kind?: SourceTextKind;
};

export type SourceTextPosition = {
  revision: number;
  key: string;
  /** UTF-16 position in the generated source TextNode, NOT in HTML markup. */
  offset: number;
  kind: SourceTextKind;
};

type SourceIdentity = {
  revision: number;
  key: string;
  kind: SourceTextKind;
  baseOffset: number;
};
type TextRun = {
  viewStart: number;
  sourceStart: number;
  length: number;
  generated: boolean;
};
type Fragment = {
  source: Node;
  start: number;
  runs: readonly TextRun[];
  generatedFrom?: number;
};
export type SerializedSourceFragment = {
  path: number[];
  sourcePath: number[];
  start: number;
  runs: TextRun[];
  generatedFrom?: number;
};

const identitySlot = Symbol.for("vivliostyle.ogenkou.source-identity.v1");
const fragmentSlot = Symbol.for("vivliostyle.ogenkou.source-fragment.v1");

// Non-enumerable sidecar slots survive direct, same-agent cross-realm access.
// A WeakMap belonging to one IIFE cannot be read by another iframe's Core.
// cloneNode/serialization still require the explicit copy/export/import paths.
function getIdentity(node: Node): SourceIdentity | undefined {
  return (node as Node & { [key: symbol]: SourceIdentity })[identitySlot];
}
function getFragment(node: Node): Fragment | undefined {
  return (node as Node & { [key: symbol]: Fragment })[fragmentSlot];
}
function putIdentity(node: Node, identity: SourceIdentity): void {
  Object.defineProperty(node, identitySlot, {
    value: identity,
    configurable: true,
  });
}
function putFragment(node: Node, fragment: Fragment): void {
  Object.defineProperty(node, fragmentSlot, {
    value: fragment,
    configurable: true,
  });
}

/** Unsupported source merging must return unknown, never a stale exact offset. */
export function invalidateSourceText(node: Node): void {
  delete (node as Node & { [key: symbol]: SourceIdentity })[identitySlot];
}

function nodeAt(root: Node, path: readonly number[]): Node | null {
  let node: Node | undefined = root;
  for (const index of path) {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    node = node?.childNodes[index];
  }
  return node ?? null;
}

function visit(
  root: Node,
  callback: (node: Node, path: number[]) => void,
): void {
  function walk(node: Node, path: number[]) {
    callback(node, path);
    Array.from(node.childNodes).forEach((child, index) =>
      walk(child, [...path, index]),
    );
  }
  walk(root, []);
}

export function registerSourceTexts(
  document: Document,
  entries: readonly SourceTextEntry[],
  revision: number | undefined,
): void {
  if (!Number.isSafeInteger(revision))
    throw new Error("Source maps require an integer revision");
  const keys = new Map<
      string,
      { start: number; end: number; kind: SourceTextKind }[]
    >(),
    nodes = new Set<Node>();
  const pending: [Node, SourceIdentity][] = [];
  for (const entry of entries) {
    const start = entry.offset ?? 0;
    const kind = entry.kind ?? "text";
    const node = Array.isArray(entry.path)
      ? nodeAt(document.documentElement, entry.path)
      : null;
    if (
      !node ||
      node.nodeType !== 3 ||
      node.nodeValue !== entry.text ||
      typeof entry.key !== "string" ||
      !entry.key ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      keys
        .get(entry.key)
        ?.some(
          (range) =>
            range.kind !== kind ||
            (start < range.end && start + entry.text.length > range.start),
        ) ||
      nodes.has(node) ||
      (entry.kind !== undefined &&
        !["text", "ruby-base", "ruby-reading", "generated"].includes(
          entry.kind,
        ))
    )
      throw new Error("Invalid source text entry: path, text or key mismatch");
    const ranges = keys.get(entry.key) ?? [];
    ranges.push({ start, end: start + entry.text.length, kind });
    keys.set(entry.key, ranges);
    nodes.add(node);
    pending.push([
      node,
      Object.freeze({
        revision: revision!,
        key: entry.key,
        kind: entry.kind ?? "text",
        baseOffset: start,
      }),
    ]);
  }
  pending.forEach(([node, identity]) => putIdentity(node, identity));
}

export function exportSourceTexts(root: Node): SourceTextEntry[] {
  const entries: SourceTextEntry[] = [];
  visit(root, (node, path) => {
    const identity = getIdentity(node);
    if (identity)
      entries.push({
        path,
        key: identity.key,
        kind: identity.kind,
        text: node.nodeValue ?? "",
        offset: identity.baseOffset,
      });
  });
  return entries;
}

/** Preserve Core preprocessing (including inserted characters) as compact runs. */
export function registerTextFragment(
  view: Node,
  source: Node,
  start: number,
  changes: readonly Change[],
): void {
  if (!getIdentity(source)) return;
  const runs: TextRun[] = [];
  let viewStart = 0,
    sourceStart = 0;
  for (const [operation, value] of changes) {
    const length = (value as string).length;
    if (operation !== -1 && length) {
      runs.push({ viewStart, sourceStart, length, generated: operation === 1 });
      viewStart += length;
    }
    if (operation !== 1) sourceStart += length;
  }
  putFragment(view, { source, start, runs });
}

/** Resolve a caret offset. Returns null for unregistered/generated layout nodes. */
export function resolveSourceText(
  node: Node,
  offset: number,
): SourceTextPosition | null {
  const fragment = getFragment(node),
    identity = fragment && getIdentity(fragment.source);
  if (
    !fragment ||
    !identity ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > (node.nodeValue?.length ?? 0)
  )
    return null;
  const generated =
    fragment.generatedFrom !== undefined && offset >= fragment.generatedFrom;
  const index = fragment.start + (generated ? fragment.generatedFrom! : offset);
  const end = fragment.runs.at(-1);
  if (end && index > end.viewStart + end.length) {
    return {
      revision: identity.revision,
      key: identity.key,
      offset: identity.baseOffset + (fragment.source.nodeValue?.length ?? 0),
      kind: "generated",
    };
  }
  const run =
    fragment.runs.find(
      (candidate) => index < candidate.viewStart + candidate.length,
    ) ?? fragment.runs.at(-1);
  if (!run) return null;
  const sourceOffset =
    run.sourceStart +
    (run.generated
      ? 0
      : Math.max(0, Math.min(run.length, index - run.viewStart)));
  return {
    revision: identity.revision,
    key: identity.key,
    offset: identity.baseOffset + sourceOffset,
    kind: generated || run.generated ? "generated" : identity.kind,
  };
}

/** Called before source or generated-view punctuation splitting mutates a node. */
export function inheritSplitText(
  original: Node,
  part: Node,
  offset: number,
  length: number,
): void {
  const identity = getIdentity(original);
  if (identity)
    putIdentity(
      part,
      Object.freeze({ ...identity, baseOffset: identity.baseOffset + offset }),
    );
  const fragment = getFragment(original);
  if (fragment) {
    const generatedFrom =
      fragment.generatedFrom === undefined ||
      fragment.generatedFrom >= offset + length
        ? undefined
        : Math.max(0, fragment.generatedFrom - offset);
    putFragment(part, {
      ...fragment,
      start: fragment.start + offset,
      generatedFrom,
    });
  }
}

/** Layout truncates a tail and may replace it with a generated hyphen/ZWJ. */
export function markGeneratedTextTail(
  node: Node,
  start: number,
  insertedLength: number,
): void {
  const fragment = getFragment(node);
  if (!fragment) return;
  putFragment(node, {
    ...fragment,
    generatedFrom: insertedLength
      ? start
      : fragment.generatedFrom !== undefined && fragment.generatedFrom < start
        ? fragment.generatedFrom
        : undefined,
  });
}

/** Clone sidecar data alongside an importNode/cloneNode; never add layout markup. */
export function copySourceFragments(from: Node, to: Node): void {
  if (
    from.nodeType !== to.nodeType ||
    from.childNodes.length !== to.childNodes.length
  )
    throw new Error("Source-map clone structure mismatch");
  const fragment = getFragment(from);
  if (fragment) putFragment(to, fragment);
  Array.from(from.childNodes).forEach((child, index) =>
    copySourceFragments(child, to.childNodes[index]),
  );
}

export function hasSourceFragments(root: Node): boolean {
  if (!!getFragment(root)) return true;
  return Array.from(root.childNodes).some(hasSourceFragments);
}

/** Prepare atomically before cache adoption. New identities may use new keys. */
export function prepareSourceFragmentRemap(
  root: Node,
  nodes: ReadonlyMap<Node, Node>,
): (() => void) | null {
  const updates: [Node, Fragment][] = [];
  let valid = true;
  visit(root, (node) => {
    const fragment = getFragment(node);
    if (!fragment) return;
    const source = nodes.get(fragment.source);
    if (!source) {
      valid = false;
      return;
    }
    // Metadata can be disabled in a later revision. Clear its stale mapping.
    updates.push([node, { ...fragment, source }]);
  });
  return valid
    ? () => updates.forEach(([node, fragment]) => putFragment(node, fragment))
    : null;
}

export function createSourcePathIndex(
  sourceRoot: Node,
): ReadonlyMap<Node, number[]> {
  const paths = new Map<Node, number[]>();
  visit(sourceRoot, (node, path) => paths.set(node, path));
  return paths;
}

export function exportSourceFragments(
  root: Node,
  sourceRoot: Node,
  paths = createSourcePathIndex(sourceRoot),
): SerializedSourceFragment[] {
  const entries: SerializedSourceFragment[] = [];
  visit(root, (node, path) => {
    const fragment = getFragment(node);
    if (!fragment || !getIdentity(fragment.source)) return;
    const sourcePath = paths.get(fragment.source);
    if (!sourcePath)
      throw new Error(
        "Source-map fragment belongs to another source generation",
      );
    entries.push({
      path,
      sourcePath,
      start: fragment.start,
      runs: fragment.runs.map((run) => ({ ...run })),
      ...(fragment.generatedFrom === undefined
        ? {}
        : { generatedFrom: fragment.generatedFrom }),
    });
  });
  return entries;
}

export function importSourceFragments(
  root: Node,
  sourceRoot: Node,
  entries: readonly SerializedSourceFragment[],
): void {
  const pending: [Node, Fragment][] = [],
    seen = new Set<Node>();
  for (const entry of entries) {
    const node = nodeAt(root, entry.path),
      source = nodeAt(sourceRoot, entry.sourcePath);
    if (
      !node ||
      node.nodeType !== 3 ||
      seen.has(node) ||
      !source ||
      !getIdentity(source) ||
      !Number.isSafeInteger(entry.start) ||
      entry.start < 0 ||
      !Array.isArray(entry.runs)
    )
      throw new Error("Invalid portable source-map fragment");
    let end = 0;
    for (const run of entry.runs) {
      if (
        !Number.isSafeInteger(run.viewStart) ||
        run.viewStart !== end ||
        !Number.isSafeInteger(run.sourceStart) ||
        run.sourceStart < 0 ||
        !Number.isSafeInteger(run.length) ||
        run.length <= 0 ||
        typeof run.generated !== "boolean" ||
        run.sourceStart + (run.generated ? 0 : run.length) >
          (source.nodeValue?.length ?? 0)
      )
        throw new Error("Invalid portable source-map run");
      end += run.length;
    }
    // Layout may append a hyphen outside the original preprocessed text.
    if (
      entry.start > end ||
      (entry.generatedFrom !== undefined &&
        (!Number.isSafeInteger(entry.generatedFrom) ||
          entry.generatedFrom < 0 ||
          entry.generatedFrom >= (node.nodeValue?.length ?? 0)))
    )
      throw new Error("Invalid portable source-map start/tail");
    pending.push([
      node,
      {
        source,
        start: entry.start,
        runs: entry.runs.map((run) => ({ ...run })),
        generatedFrom: entry.generatedFrom,
      },
    ]);
    seen.add(node);
  }
  pending.forEach(([node, fragment]) => putFragment(node, fragment));
}

/** Client coordinates of the displayed document, including its current CSS scale. */
export function hitTestSource(
  root: HTMLElement,
  x: number,
  y: number,
): SourceTextPosition | null {
  if (!root.isConnected || !Number.isFinite(x) || !Number.isFinite(y))
    return null;
  const doc = root.ownerDocument;
  const hit = doc.elementFromPoint(x, y);
  if (!hit || (hit !== root && !root.contains(hit))) return null;
  const caret = doc.caretRangeFromPoint?.(x, y);
  if (!caret || !root.contains(caret.startContainer)) return null;
  const node = caret.startContainer;
  if (node.nodeType !== 3) return null;
  // Browser caret APIs can snap a margin click to unrelated text. Require a glyph.
  const offset = Math.min(caret.startOffset, (node.nodeValue?.length ?? 0) - 1);
  if (offset < 0) return null;
  const range = doc.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  if (
    !Array.from(range.getClientRects()).some(
      (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
    )
  )
    return null;
  return resolveSourceText(node, caret.startOffset);
}

export function clearSourceFragments(root: Node): void {
  visit(
    root,
    (node) => delete (node as Node & { [key: symbol]: Fragment })[fragmentSlot],
  );
}
