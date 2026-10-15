import { RepeatIndex } from "../../../src/vivliostyle/repeat-index";
import {
  StyleStore,
  StyleOwnership,
  Styler,
  readStyle,
} from "../../../src/vivliostyle/css-styler";
import * as Plugin from "../../../src/vivliostyle/plugin";

describe("owned repeating-element index", () => {
  let index, parent, revision, allowed;
  const evaluate = (element) => ({
    negative: element.tagName !== "HEADER",
    value: element,
  });
  const walk = () => [
    ...index.scan(
      parent,
      parent,
      () => revision,
      evaluate,
      () => allowed,
    ),
  ];
  beforeEach(() => {
    parent = document.createElement("div");
    parent.innerHTML = "<p>a</p><p>b</p>";
    index = new RepeatIndex();
    revision = 0;
    allowed = true;
  });
  afterEach(() => index.dispose());
  it("omits certified negatives after a complete first traversal", () => {
    expect(walk().length).toBe(2);
    expect(walk().length).toBe(0);
  });
  it("invalidates synchronously when a new header is inserted", () => {
    walk();
    parent.insertBefore(document.createElement("header"), parent.lastChild);
    expect(walk().map((e) => e.tagName)).toEqual(["P", "HEADER", "P"]);
    expect(walk().map((e) => e.tagName)).toEqual(["P", "HEADER", "P"]);
  });
  it("invalidates for attributes, text and style revisions", () => {
    walk();
    parent.firstChild.setAttribute("class", "changed");
    expect(walk().length).toBe(2);
    parent.firstChild.firstChild.data = "edited";
    expect(walk().length).toBe(2);
    revision++;
    expect(walk().length).toBe(2);
  });
  it("ignores only the first Core offset attribute addition", () => {
    walk();
    parent.firstChild.setAttribute("data-adapt-eloff", "1");
    expect(walk().length).toBe(0);
    parent.firstChild.setAttribute("data-adapt-eloff", "2");
    expect(walk().length).toBe(2);
  });
  it("does not save an incomplete traversal", () => {
    const iterator = index.scan(
      parent,
      parent,
      () => revision,
      evaluate,
      () => allowed,
    );
    iterator.next();
    iterator.return();
    expect(walk().length).toBe(2);
  });
  it("disposal releases the observer and falls back without permanent waiting", () => {
    walk();
    index.dispose();
    expect(walk().length).toBe(2);
    parent.appendChild(document.createElement("header"));
    expect(walk().length).toBe(3);
  });
  it("public mutable reads preserve identity and disable omission permanently", () => {
    const style = { display: { value: "block" } };
    const store = new StyleStore({ getElementOffset: () => 0 }, new StyleOwnership());
    store.storeForLayout(0, style);
    expect(store.canIndexRepeatingElements).toBeTrue();
    const borrowed = store.styleOf(parent);
    expect(borrowed).toBe(style);
    borrowed.display.value = "table-header-group";
    expect(store.canIndexRepeatingElements).toBeFalse();
    expect(store.styleForLayout(parent).display.value).toBe(
      "table-header-group",
    );
  });
  it("public store insertion cannot certify caller-retained aliases", () => {
    const store = new StyleStore({ getElementOffset: () => 0 }),
      style = {};
    store.setAt(0, style);
    expect(store.canIndexRepeatingElements).toBeFalse();
    style.display = "changed";
    expect(store.styleOf(parent)).toBe(style);
  });
  it("internal reads preserve indexing; public getStyle escapes the same object", () => {
    const styler = Object.create(Styler.prototype),
      style = {};
    styler.xmldoc = { getElementOffset: () => 0 };
    styler.lastOffset = Infinity;
    styler.styles = new StyleStore(styler.xmldoc, new StyleOwnership());
    styler.styles.storeForLayout(0, style);
    expect(readStyle(styler, parent, false)).toBe(style);
    expect(styler.styles.canIndexRepeatingElements).toBeTrue();
    expect(styler.getStyle(parent, false)).toBe(style);
    expect(styler.styles.canIndexRepeatingElements).toBeFalse();
  });
  it("preserves unknown styler implementations", () => {
    const style = {},
      custom = { getStyle: () => style };
    expect(readStyle(custom, parent, false)).toBe(style);
  });
  it("a mutable escape also disables stores sharing CSS ownership", () => {
    const ownership = new StyleOwnership();
    const first = new StyleStore({ getElementOffset: () => 0 }, ownership);
    const second = new StyleStore({ getElementOffset: () => 0 }, ownership);
    const shared = { display: { value: "block" } };
    first.storeForLayout(0, shared);second.storeForLayout(0, shared);
    first.styleOf(parent).display.value = "changed";
    expect(first.canIndexRepeatingElements).toBeFalse();
    expect(second.canIndexRepeatingElements).toBeFalse();
    expect(second.styleForLayout(parent).display.value).toBe("changed");
  });
  it("allows progress notifications but rejects unknown style hooks", () => {
    const hook = () => {};
    Plugin.registerHook(Plugin.HOOKS.PAGINATION_PROGRESS, hook);
    try {
      expect(Plugin.hasUnsafeRepeatingElementHooks()).toBeFalse();
    } finally {
      Plugin.removeHook(Plugin.HOOKS.PAGINATION_PROGRESS, hook);
    }
    Plugin.registerHook(Plugin.HOOKS.PREPROCESS_ELEMENT_STYLE, hook);
    try {
      expect(Plugin.hasUnsafeRepeatingElementHooks()).toBeTrue();
    } finally {
      Plugin.removeHook(Plugin.HOOKS.PREPROCESS_ELEMENT_STYLE, hook);
    }
    expect(Plugin.hasUnsafeRepeatingElementHooks()).toBeTrue();
  });
});
