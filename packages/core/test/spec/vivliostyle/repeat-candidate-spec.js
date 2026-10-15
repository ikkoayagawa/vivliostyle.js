import * as Css from "../../../src/vivliostyle/css";
import * as CssCascade from "../../../src/vivliostyle/css-cascade";
import { ViewFactory } from "../../../src/vivliostyle/vgen";

describe("conservative repeating-element candidate", () => {
  function factory() {
    const view = Object.create(ViewFactory.prototype);
    view.sourceNode = document.createElement("div");
    view.xmldoc = { root: document.createElement("html") };
    return view;
  }
  const casc = (value) => new CssCascade.CascadeValue(value, 0);
  it("keeps table headers and explicit repeat-on-break", () => {
    const view = factory();
    expect(
      view.repeatCandidate({
        display: casc(Css.ident.table_header_group),
        "repeat-on-break": casc(Css.ident.auto),
      }).value,
    ).toBe("header");
    expect(
      view.repeatCandidate({ "repeat-on-break": casc(Css.ident.footer) }).value,
    ).toBe("footer");
    expect(
      view.repeatCandidate({
        "repeat-on-break": casc(Css.ident.none),
        display: casc(Css.ident.table_header_group),
      }).value,
    ).toBeNull();
  });
  it("uses computed display when floating a table header", () => {
    expect(
      factory().repeatCandidate({
        display: casc(Css.ident.table_header_group),
        float: casc(Css.ident.left),
        "repeat-on-break": casc(Css.ident.auto),
      }).value,
    ).toBeNull();
  });
  it("falls back for conditional styles and context-dependent values", () => {
    const view = factory();
    expect(view.repeatCandidate({ _regions: {} })).toBeUndefined();
    expect(
      view.repeatCandidate({ _viewConditionalStyles: [{}] }),
    ).toBeUndefined();
    expect(
      view.repeatCandidate({ width: casc(new Css.Numeric(1, "vw")) }),
    ).toBeUndefined();
    expect(
      view.repeatCandidate({ width: casc(new Css.Numeric(50, "%")) }),
    ).toBeUndefined();
    expect(
      view.repeatCandidate({ width: casc(new Css.Func("calc", [])) }),
    ).toBeUndefined();
    expect(
      view.repeatCandidate({
        _viewConditionalStyles: [],
        width: casc(new Css.Numeric(1, "em")),
      }).value,
    ).toBeNull();
  });
  it("does not trust overridden cascade values", () => {
    class DynamicValue extends CssCascade.CascadeValue {}
    expect(
      factory().repeatCandidate({
        display: new DynamicValue(Css.ident.block, 0),
      }),
    ).toBeUndefined();
  });
});
