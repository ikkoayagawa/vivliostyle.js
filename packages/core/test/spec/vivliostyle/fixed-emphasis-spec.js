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
 */

import * as Css from "../../../src/vivliostyle/css";
import {prepareFixedEmphasis, paintFixedEmphasis} from "../../../src/vivliostyle/fixed-emphasis";

describe("Fixed emphasis leading", () => {
  let page;
  const fixed = {};
  const prepare = (element, style = "sesame") => prepareFixedEmphasis(element, {
    ...fixed, "text-emphasis-style": Css.getName(style),
  }, true);
  beforeEach(() => {
    page = document.createElement("div");
    page.style.cssText = "position:relative;width:300px;height:300px;font:16px/28px serif;writing-mode:vertical-rl";
    document.body.appendChild(page);
  });
  afterEach(() => page.remove());
  function marked(html) {
    const span = document.createElement("span");
    span.style.textEmphasisStyle = "sesame";
    span.innerHTML = html;
    prepare(span);
    page.appendChild(span);
    return span;
  }
  const painted = () => [...page.querySelectorAll("[data-viv-fixed-emphasis-paint]>span")];
  it("leaves normal emphasis untouched without opt-in", () => {
    const span = document.createElement("span");
    span.style.textEmphasisStyle = "sesame";
    prepareFixedEmphasis(span, {"text-emphasis-style": Css.getName("sesame")});
    expect(span.style.textEmphasisStyle).toBe("sesame");
    expect(span.hasAttribute("data-viv-fixed-emphasis")).toBeFalse();
  });
  it("records a detached explicit reset", () => {
    const span = document.createElement("span");
    prepare(span, "none");
    expect(span.getAttribute("data-viv-fixed-emphasis")).toBe("none");
  });
  it("does not allow author CSS to enable the preview option", () => {
    const span = document.createElement("span");
    span.style.textEmphasisStyle = "sesame";
    prepareFixedEmphasis(span, {"--viv-fixed-emphasis": Css.getName("1"), "text-emphasis-style": Css.getName("sesame")}, false);
    expect(span.hasAttribute("data-viv-fixed-emphasis")).toBeFalse();
    expect(span.style.textEmphasisStyle).toBe("sesame");
  });
  it("preserves nested inherited marks but honors explicit none", () => {
    const span = marked("甲<span>乙</span><span>丙</span>");
    prepareFixedEmphasis(span.children[0], fixed, true);
    prepare(span.children[1], "none");
    paintFixedEmphasis(page);
    expect(painted().map(e => e.textContent).join("")).toBe("甲乙");
  });
  it("does not paint reading annotations as body text", () => {
    marked("<ruby>甲乙<rt>こうおつ</rt><rp>（</rp></ruby>");
    paintFixedEmphasis(page);
    expect(painted().map(e => e.textContent).join("")).toBe("甲乙");
  });
  it("leaves original nodes and geometry intact and paints idempotently", () => {
    const span = marked("甲乙"), text = span.firstChild;
    const before = span.getBoundingClientRect();
    paintFixedEmphasis(page);
    paintFixedEmphasis(page);
    const after = span.getBoundingClientRect();
    expect(span.firstChild).toBe(text);
    expect(span.textContent).toBe("甲乙");
    expect(after.left).toBeCloseTo(before.left, 3);
    expect(after.top).toBeCloseTo(before.top, 3);
    expect(painted().length).toBe(2);
    const layer = page.querySelector("[data-viv-fixed-emphasis-paint]");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.style.pointerEvents).toBe("none");
  });
  it("aligns transparent paint glyphs at a scaled page", () => {
    page.style.transformOrigin = "0 0";
    page.style.transform = "scale(0.75)";
    const span = marked("甲乙");
    paintFixedEmphasis(page);
    const range = document.createRange();
    range.setStart(span.firstChild, 0); range.setEnd(span.firstChild, 1);
    const desired = range.getBoundingClientRect();
    range.selectNodeContents(painted()[0].firstChild);
    const actual = range.getBoundingClientRect();
    expect(actual.left).toBeCloseTo(desired.left, 1);
    expect(actual.top).toBeCloseTo(desired.top, 1);
  });
});
