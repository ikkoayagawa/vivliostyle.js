// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
const NON_LAYOUT_ATTRIBUTES = new Set([
  "data-adapt-eloff",
  "data-file-path",
  "data-source-end-offset",
  "data-source-line",
  "data-source-offset",
]);

export const SOURCE_MAP_ATTRIBUTES = [
  "data-file-path",
  "data-source-end-offset",
  "data-source-line",
  "data-source-offset",
] as const;

export type SourceMetadataPatch = {
  elementOffset: string;
  attributes: ReadonlyMap<string, string | null>;
};

export type SourceMetadataPatches = ReadonlyMap<string, SourceMetadataPatch>;

function layoutAttributes(element: Element): string {
  return Array.from(element.attributes)
    .filter((attribute) => !NON_LAYOUT_ATTRIBUTES.has(attribute.name))
    .map((attribute) => [attribute.name, attribute.value])
    .sort()
    .map((value) => JSON.stringify(value))
    .join();
}

/** Match unchanged prefix and suffix nodes while ignoring source map metadata. */
export function comparePreviewDocuments(oldRoot: Element, newRoot: Element) {
  const nodes = new Map<Node, Node>();
  const suffixNodes = new Set<Node>();
  let changed: Node | null = null;
  let target: Node | null = null;
  const visit = (oldNode: Node, newNode: Node): boolean => {
    if (
      oldNode.nodeType !== newNode.nodeType ||
      oldNode.nodeName !== newNode.nodeName ||
      (oldNode.nodeType === 1 &&
        layoutAttributes(oldNode as Element) !== layoutAttributes(newNode as Element))
    ) {
      changed = oldNode;
      target = newNode;
      return false;
    }
    nodes.set(oldNode, newNode);
    if (oldNode.nodeType === 3 && oldNode.textContent !== newNode.textContent) {
      changed = oldNode;
      target = newNode;
      return false;
    }
    const oldChildren = Array.from(oldNode.childNodes);
    const newChildren = Array.from(newNode.childNodes);
    for (let index = 0; index < Math.max(oldChildren.length, newChildren.length); index++) {
      const oldChild = oldChildren[index];
      const newChild = newChildren[index];
      if (!oldChild || !newChild) {
        changed = oldChild || (oldNode as Element).lastElementChild || oldNode;
        target = newChild || newNode;
        return false;
      }
      if (!visit(oldChild, newChild)) return false;
    }
    return true;
  };
  visit(oldRoot, newRoot);

  // A prefix difference prevents the forward walk from visiting later
  // siblings. Retain mappings for an identical tail so pagination can
  // converge on reusable suffix pages.
  const mapSuffix = (oldNode: Node, newNode: Node): boolean => {
    if (
      oldNode.nodeType !== newNode.nodeType ||
      oldNode.nodeName !== newNode.nodeName ||
      (oldNode.nodeType === 1 &&
        layoutAttributes(oldNode as Element) !== layoutAttributes(newNode as Element)) ||
      (oldNode.nodeType === 3 && oldNode.textContent !== newNode.textContent)
    )
      return false;
    const oldChildren = Array.from(oldNode.childNodes);
    const newChildren = Array.from(newNode.childNodes);
    let oldIndex = oldChildren.length - 1;
    let newIndex = newChildren.length - 1;
    while (oldIndex >= 0 && newIndex >= 0) {
      if (!mapSuffix(oldChildren[oldIndex]!, newChildren[newIndex]!)) return false;
      oldIndex--;
      newIndex--;
    }
    if (oldIndex >= 0 || newIndex >= 0) return false;
    nodes.set(oldNode, newNode);
    suffixNodes.add(oldNode);
    return true;
  };
  mapSuffix(oldRoot, newRoot);
  if (oldRoot.parentNode && newRoot.parentNode)
    nodes.set(oldRoot.parentNode, newRoot.parentNode);
  return { nodes, suffixNodes, changed, target };
}

/**
 * Locate the trailing edge of an edit in the new document.
 *
 * Prefix matching is intentionally performed before suffix matching. This
 * right-biases ambiguous insertions such as repeated prose or blank lines,
 * placing the edit target at the final newly inserted character rather than
 * an earlier identical occurrence.
 */
export function editedTextOffset(
  oldRoot: Element,
  newRoot: Element,
): { node: Node; offset: number } | null {
  const before = oldRoot.textContent || "";
  const after = newRoot.textContent || "";
  if (before === after) return null;

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++;

  let oldEnd = before.length;
  let newEnd = after.length;
  while (
    oldEnd > prefix &&
    newEnd > prefix &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  if (after.length === 0) return { node: newRoot, offset: 0 };
  const absoluteOffset = newEnd > prefix
    ? newEnd - 1
    : Math.min(prefix, after.length - 1);
  const walker = newRoot.ownerDocument.createTreeWalker(newRoot, 4);
  let remaining = Math.max(0, absoluteOffset);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length || 0;
    if (remaining < length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return { node: newRoot, offset: 0 };
}

/**
 * Prepare an atomic metadata update for a reused page container.
 * Returns null when any rendered source element cannot be mapped to the new
 * revision, allowing the caller to fall back to fresh pagination safely.
 */
export function prepareSourceMetadataSync(
  root: Element,
  patches: SourceMetadataPatches,
): (() => void) | null {
  const updates: { element: Element; patch: SourceMetadataPatch }[] = [];
  for (const element of Array.from(root.querySelectorAll("[data-adapt-eloff]"))) {
    const oldOffset = element.getAttribute("data-adapt-eloff");
    const patch = oldOffset === null ? undefined : patches.get(oldOffset);
    if (!patch) return null;
    updates.push({ element, patch });
  }
  return () => {
    for (const { element, patch } of updates) {
      element.setAttribute("data-adapt-eloff", patch.elementOffset);
      for (const attribute of SOURCE_MAP_ATTRIBUTES) {
        const value = patch.attributes.get(attribute);
        if (value === null || value === undefined) element.removeAttribute(attribute);
        else element.setAttribute(attribute, value);
      }
    }
  };
}
