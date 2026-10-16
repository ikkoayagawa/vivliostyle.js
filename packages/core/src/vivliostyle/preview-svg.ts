// Ogenkou fork addition (2026-10-16): static inline SVG preview reuse.
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const staticElements = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline",
  "polygon", "text", "tspan", "title", "desc",
]);

/** Initial reuse scope: geometry and text without referenced or live content.
 * This is a cache eligibility check, not an HTML/SVG sanitizer. Resource-bearing
 * SVG, local definition references and animation remain on the fresh path.
 */
export function isStaticSelfContainedSvg(root: Element): boolean {
  return [root, ...Array.from(root.querySelectorAll("*"))].every((element) =>
    element.namespaceURI === SVG_NAMESPACE &&
    staticElements.has(element.localName) &&
    Array.from(element.attributes).every((attribute) => {
      const name = attribute.localName.toLowerCase();
      return !name.startsWith("on") &&
        !["href", "src", "base"].includes(name) &&
        !/url\s*\(/i.test(attribute.value) &&
        (name !== "style" || isStaticSvgStyle(attribute.value));
    }),
  );
}

/** Cascaded CSS may introduce dependencies absent from the SVG attributes. */
export function isStaticSvgStyle(signature: string): boolean {
  return !/url\s*\(|(?:^|[;{])\s*(?:animation|transition)(?:-|\s*:)/i.test(signature);
}
