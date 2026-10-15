import { PageStartIndex } from "../../../src/vivliostyle/page-start-index";

describe("page start structural index", () => {
  let root, index;
  beforeEach(() => {
    root = new DOMParser().parseFromString(
      "<root><hidden><p>ab</p></hidden><span><p>cd</p></span><p>ef</p></root>",
      "text/xml",
    ).documentElement;
    index = new PageStartIndex(root, 0);
  });
  const normal = (element) => element.localName !== "hidden";
  const inline = (element) => element.localName === "span";
  it("skips an excluded ancestor and accepts descendants of inline elements", () => {
    expect(index.find(2, () => true, normal, inline)).toBe(
      root.children[1].firstElementChild,
    );
  });
  it("supports backward searches", () => {
    expect(index.find(9, () => true, normal, inline)).toBe(
      root.lastElementChild,
    );
    expect(index.find(2, () => true, normal, inline)).toBe(
      root.children[1].firstElementChild,
    );
  });
  it("rechecks CSS eligibility for every lookup", () => {
    index.find(2, () => true, normal, inline);
    expect(
      index.find(
        2,
        () => true,
        (element) => element.localName !== "span",
        inline,
      ),
    ).toBe(root.children[0].firstElementChild);
  });
  it("falls back instead of forcing lazy CSS traversal", () => {
    expect(index.find(9, () => undefined, normal, inline)).toBeUndefined();
  });
  it("falls back for expression-dependent skipped properties", () => {
    expect(index.find(9, () => false, normal, inline)).toBeUndefined();
  });
  it("falls back for pending mutations", () => {
    root.lastElementChild.firstChild.data += "extra";
    expect(index.find(9, () => true, normal, inline)).toBeUndefined();
  });
  it("falls back for mutations delivered between calls", async () => {
    root.append(root.ownerDocument.createElement("p"));
    await Promise.resolve();
    expect(index.find(9, () => true, normal, inline)).toBeUndefined();
  });
  it("ignores lazy offset metadata but detects mutation during evaluation", () => {
    root.firstElementChild.setAttribute("data-adapt-eloff", "1");
    expect(index.find(2, () => true, normal, inline)).not.toBeUndefined();
    expect(
      index.find(
        2,
        () => true,
        (element) => {
          root.setAttribute("class", "changed");
          return normal(element);
        },
        inline,
      ),
    ).toBeUndefined();
  });
  it("rejects inconsistent source offsets", () => {
    root.lastElementChild.setAttribute("data-adapt-eloff", "999");
    index = new PageStartIndex(root, 0);
    expect(index.find(2, () => true, normal, inline)).toBeUndefined();
  });
});
