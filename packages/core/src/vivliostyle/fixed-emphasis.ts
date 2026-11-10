/**
 * Copyright 2026 Vivliostyle Foundation
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
 */
/** Fixed-leading emphasis: lay out the original text, then paint native marks. */
import type * as Css from "./css";

const attribute = "data-viv-fixed-emphasis";
const paintAttribute = "data-viv-fixed-emphasis-paint";
const segments = new Intl.Segmenter("ja", {granularity: "grapheme"});

/** Opt-in only. Source text, its DOM paths, and line breaking stay untouched. */
export function prepareFixedEmphasis(
  element: HTMLElement,
  computed: {[name: string]: Css.Val},
  enabled = false,
): void {
  if (!enabled) return;
  const style = computed["text-emphasis-style"]?.toString();
  if (!style) return; // Preserve inherited emphasis metadata.
  if (style === "none") {
    // The view has not been attached to its parent yet. Record explicit resets
    // even without a parent so the painter can stop inherited emphasis.
    element.setAttribute(attribute, "none");
    return;
  }
  element.setAttribute(attribute, style);
  element.style.setProperty("text-emphasis-style", "none", "important");
}

/**
 * Called after a page's final line/page breaks. All measurements are read before
 * writes, and alignment is corrected in one batch. No per-character Ruby boxes
 * enter the line breaker. Native text-emphasis still chooses/skips the marks.
 */
export function paintFixedEmphasis(page: HTMLElement): void {
  page.querySelectorAll(`[${paintAttribute}]`).forEach(e => e.remove());
  if (!page.querySelector(`[${attribute}]:not([${attribute}="none"])`)) return;
  const doc = page.ownerDocument, win = doc.defaultView!;
  const frame = page.getBoundingClientRect();
  const scaleX = frame.width / page.offsetWidth, scaleY = frame.height / page.offsetHeight;
  if (!(scaleX > 0 && scaleY > 0)) return;
  const rows: {text: string; rect: DOMRect; style: CSSStyleDeclaration; emphasis: string}[] = [];
  const walker = doc.createTreeWalker(page, 4 /* SHOW_TEXT */), range = doc.createRange();
  const styles = new Map<Element, CSSStyleDeclaration>();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, parent = node.parentElement;
    const owner = parent?.closest(`[${attribute}]`);
    const emphasis = owner?.getAttribute(attribute);
    if (!parent || !emphasis || emphasis === "none" || !node.data.trim() || parent.closest("rt, rp")) continue;
    let style = styles.get(parent);
    if (!style) {style = win.getComputedStyle(parent); styles.set(parent, style);}
    const units = style.textCombineUpright === "all"
      ? [{segment: node.data, index: 0}]
      : segments.segment(node.data);
    for (const {segment, index} of units) {
      if (!segment.trim()) continue;
      range.setStart(node, index); range.setEnd(node, index + segment.length);
      const rect = Array.from(range.getClientRects()).find(r => r.width > 0 && r.height > 0);
      if (rect) rows.push({text: segment, rect, style, emphasis});
    }
  }
  if (!rows.length) return;
  const layer = doc.createElement("span");
  layer.setAttribute(paintAttribute, "true");
  layer.setAttribute("data-adapt-spec", "fixed-emphasis");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:absolute;inset:0;pointer-events:none;user-select:none;overflow:visible;";
  const painted: {element: HTMLElement; text: Text; x: number; y: number}[] = [];
  const properties = ["font-family", "font-size", "font-weight", "font-style", "font-stretch",
    "font-feature-settings", "font-variation-settings", "font-variant-east-asian", "font-kerning",
    "writing-mode", "text-orientation", "text-combine-upright", "letter-spacing"];
  for (const row of rows) {
    const element = doc.createElement("span"), text = doc.createTextNode(row.text);
    element.style.cssText = "position:absolute;display:block;margin:0;padding:0;border:0;line-height:1;white-space:pre;color:transparent;-webkit-text-fill-color:transparent;text-shadow:none;pointer-events:none;";
    for (const property of properties) element.style.setProperty(property, row.style.getPropertyValue(property));
    element.style.textEmphasisStyle = row.emphasis;
    element.style.textEmphasisColor = row.style.textEmphasisColor || row.style.color;
    element.style.textEmphasisPosition = row.style.textEmphasisPosition;
    const x = (row.rect.left - frame.left) / scaleX - page.clientLeft;
    const y = (row.rect.top - frame.top) / scaleY - page.clientTop;
    element.style.left = `${x}px`; element.style.top = `${y}px`;
    element.append(text); layer.append(element); painted.push({element, text, x, y});
  }
  page.append(layer);
  const adjustments = painted.map((row, i) => {
    range.selectNodeContents(row.text);
    const actual = range.getBoundingClientRect(), desired = rows[i].rect;
    return {row, x: row.x + (desired.left - actual.left) / scaleX,
      y: row.y + (desired.top - actual.top) / scaleY};
  });
  for (const {row, x, y} of adjustments) {
    row.element.style.left = `${x}px`; row.element.style.top = `${y}px`;
  }
}
