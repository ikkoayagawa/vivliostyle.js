import { AdaptiveViewer } from "../../../src/vivliostyle/adaptive-viewer";

describe("focused display selection independent of layout preferences", () => {
  let viewer, root, left, right;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    const paper = () => {
      const container = document.createElement("div");
      root.appendChild(container);
      return { container, spineIndex: 0, fetchers: [] };
    };
    left = paper();
    right = paper();
    viewer = Object.create(AdaptiveViewer.prototype);
    viewer.previewRevision = 1;
    viewer.previewSession = {
      clientRevision: 2,
      paginationMode: "target-display-unit",
      focusedDisplayMode: "spread",
      isCurrent: revision => revision === 1,
    };
    viewer.pref = { spreadView: false };
    viewer.currentPage = left;
    viewer.currentSpread = { left, right };
    viewer.opfView = { spineItems: [{ item: { epage: 0 }, pages: [left, right] }] };
  });
  afterEach(() => root.remove());
  it("retains two papers without changing canonical single-page preferences", () => {
    const unit = viewer.getCurrentPreviewDisplayUnit();
    expect(unit.containers).toEqual([left.container, right.container]);
    expect(unit.revision).toBe(2);
    expect(viewer.pref.spreadView).toBe(false);
  });
  it("keeps the legacy selection when no focused mode is provided", () => {
    viewer.previewSession.focusedDisplayMode = undefined;
    expect(viewer.getCurrentPreviewDisplayUnit().containers).toEqual([left.container]);
    viewer.pref.spreadView = true;
    expect(viewer.getCurrentPreviewDisplayUnit().containers.length).toBe(2);
  });
  it("ignores the focused option during complete pagination", () => {
    viewer.previewSession.paginationMode = "complete";
    expect(viewer.getCurrentPreviewDisplayUnit().containers).toEqual([left.container]);
  });
  it("can select one paper without altering spread layout preferences", () => {
    viewer.pref.spreadView = true;
    viewer.previewSession.focusedDisplayMode = "singlePage";
    expect(viewer.getCurrentPreviewDisplayUnit().containers).toEqual([left.container]);
    expect(viewer.pref.spreadView).toBe(true);
  });
  it("requires the selected neighbor's resources to settle", () => {
    right.fetchers = [{ hasArrived: () => false }];
    expect(viewer.getCurrentPreviewDisplayUnit().resourcesReady).toBe(false);
  });
  it("does not expose a disconnected neighbor as a ready spread", () => {
    right.container.remove();
    expect(viewer.getCurrentPreviewDisplayUnit()).toBe(null);
  });
  it("supports legitimate one-sided boundary units", () => {
    viewer.currentSpread.right = null;
    expect(viewer.getCurrentPreviewDisplayUnit().containers).toEqual([left.container]);
  });
});
