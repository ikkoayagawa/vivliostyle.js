import { CoreViewer } from "../../../src/vivliostyle/core-viewer";

describe("preview resource readiness", () => {
  let viewer, unit, ready, seed;
  beforeEach(() => {
    viewer = Object.create(CoreViewer.prototype);
    viewer.settings = { window };
    ready = false;
    unit = {
      generation: 1,
      containers: [document.createElement("div")],
      resourcesReady: false,
    };
    seed = {
      snapshots: new Map([
        ["source", { pages: [{ fetchers: [{ hasArrived: () => ready }] }] }],
      ]),
    };
    viewer.getCurrentPreviewDisplayUnit = () => unit;
    viewer.getCommittedPreviewSnapshotSeed = () => ({ ...seed });
  });
  it("has no timer delay for image-free paper", async () => {
    unit.resourcesReady = true;
    await viewer.waitForPreviewResources();
  });
  it("waits for both selected pages before copying", async () => {
    unit.containers.push(document.createElement("div"));
    let cloned = false;
    viewer.retainPreviewDisplayUnit = () => {
      cloned = true;
      return "paper";
    };
    const pending = viewer.retainPreviewDisplayUnitAsync();
    expect(cloned).toBe(false);
    unit.resourcesReady = true;
    expect(await pending).toBe("paper");
  });
  it("checks all completed paper rather than just the visible page", async () => {
    unit.resourcesReady = true;
    let settled = false;
    const pending = viewer
      .waitForPreviewResources({ complete: true })
      .then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    ready = true;
    await pending;
  });
  it("rejects navigation and generation changes", async () => {
    const pending = viewer.waitForPreviewResources();
    unit = { ...unit, generation: 2 };
    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
  });
  it("rejects canceled or disposed paper", async () => {
    const pending = viewer.waitForPreviewResources();
    unit = null;
    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
  });
  it("supports an explicit abort signal", async () => {
    const controller = new AbortController();
    const pending = viewer.waitForPreviewResources({
      signal: controller.signal,
    });
    controller.abort();
    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
  });
  it("bounds a stuck fetcher", async () => {
    await expectAsync(
      viewer.waitForPreviewResources({ timeoutMs: 5 }),
    ).toBeRejectedWithError("Preview resource wait timed out");
  });
  it("rejects a synchronous clone before URLs are assigned", () => {
    expect(() =>
      CoreViewer.prototype.retainPreviewDisplayUnit.call(viewer, document),
    ).toThrowError(/resources are pending/);
  });
  it("rejects exporting or cloning an unfinished completed snapshot", () => {
    expect(() => viewer.exportCompletedPaper("test")).toThrowError(
      /resources are pending/,
    );
    expect(() => viewer.exportCommittedSeed("test")).toThrowError(
      /resources are pending/,
    );
    expect(() => viewer.preparePreviewSnapshotSeed(seed)).toThrowError(
      /resources are pending/,
    );
  });
  it("does not clone after disposal during an already-ready wait", async () => {
    unit.resourcesReady = true;
    const pending = viewer.retainPreviewDisplayUnitAsync();
    viewer.previewResourceEpoch = (viewer.previewResourceEpoch ?? 0) + 1;
    await expectAsync(pending).toBeRejectedWith(
      jasmine.objectContaining({ name: "AbortError" }),
    );
  });
});
