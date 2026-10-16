// Ogenkou fork addition (2026-10-16): bounded, atomic absolute-positioned boxes.
type Style = Record<string, unknown>;

function value(style: Style, name: string, fallback: string): string {
  const entry = style[name];
  return entry == null ? fallback : String(typeof entry === "object" && "value" in entry ? entry.value : entry);
}

function length(style: Style, name: string, fallback = "auto"): number | null {
  const text = value(style, name, fallback).trim();
  if (/^[+-]?0(?:\.0+)?$/.test(text)) return 0;
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))(px|pt|pc|mm|cm|in|q)$/i.exec(text);
  if (!match) return null;
  const units: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

function isPlainClippedBox(style: Style): boolean {
  if (value(style, "display", "inline") !== "block" ||
      value(style, "box-sizing", "content-box") !== "border-box" ||
      value(style, "overflow", "visible") !== "hidden" ||
      value(style, "overflow-x", "hidden") !== "hidden" ||
      value(style, "overflow-y", "hidden") !== "hidden") return false;
  for (const name of ["transform", "filter", "perspective", "contain"]) {
    if (value(style, name, "none") !== "none") return false;
  }
  for (const name of Object.keys(style)) {
    if (/^(?:animation|transition)(?:-|$)/.test(name)) return false;
    if (/^inset-/.test(name) && value(style, name, "auto") !== "auto") return false;
    if (/^(?:(?:min-|max-)?(?:inline|block)-size)$/.test(name) &&
        !["auto", "none"].includes(value(style, name, "auto"))) return false;
  }
  for (const dimension of ["width", "height"]) {
    if (!["auto", "0", "0px"].includes(value(style, `min-${dimension}`, "auto")) ||
        value(style, `max-${dimension}`, "none") !== "none") return false;
  }
  for (const side of ["top", "right", "bottom", "left"]) {
    if (length(style, `margin-${side}`, "0") !== 0 ||
        length(style, `padding-${side}`, "0") !== 0 ||
        length(style, `border-${side}-width`, "0") !== 0) return false;
  }
  return value(style, "right", "auto") === "auto" && value(style, "bottom", "auto") === "auto";
}

/** Only direct children of an indivisible, clipped, fixed-size relative box.
 * Literal physical lengths avoid viewport/font/percentage-dependent bounds.
 * Arbitrary absolute/fixed positioning remains on the fresh layout path.
 */
export function isContainedAbsolute(
  element: Element,
  style: Style,
  readStyle: (element: Element) => Style,
): boolean {
  const parent = element.parentElement;
  if (!parent || value(style, "position", "static") !== "absolute" || !isPlainClippedBox(style)) return false;
  const container = readStyle(parent);
  if (value(container, "position", "static") !== "relative" ||
      value(container, "break-inside", "auto") !== "avoid" ||
      !isPlainClippedBox(container)) return false;
  for (const side of ["left", "top"]) {
    if (value(container, side, "auto") !== "auto" && length(container, side) !== 0) return false;
  }
  const width = length(style, "width"), height = length(style, "height");
  const left = length(style, "left"), top = length(style, "top");
  const outerWidth = length(container, "width"), outerHeight = length(container, "height");
  if ([width, height, left, top, outerWidth, outerHeight].some((number) => number === null)) return false;
  return width! > 0 && height! > 0 && outerWidth! > 0 && outerHeight! > 0 &&
    left! >= 0 && top! >= 0 && left! + width! <= outerWidth! && top! + height! <= outerHeight!;
}
