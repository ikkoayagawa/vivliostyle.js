import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath =
  process.argv.find((arg) => arg.startsWith("--browser="))?.slice(10) ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(fs.existsSync);
if (!executablePath)
  throw Error("Supply --browser=PATH to an existing browser");
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><script src="/core.js"></script><body></body>');
  } else {
    const file =
      req.url === "/core.js"
        ? path.join(root, "packages/core/lib/vivliostyle.iife.js")
        : path.resolve(
            root,
            "packages/core",
            decodeURIComponent(req.url.slice(1)),
          );
    if (
      (req.url !== "/core.js" &&
        !file.startsWith(
          path.join(root, "packages/core/resources") + path.sep,
        )) ||
      !fs.existsSync(file)
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      req.url === "/core.js" ? "text/javascript" : "application/octet-stream",
    );
    res.end(fs.readFileSync(file));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const size = Number(
    process.argv.find((arg) => arg.startsWith("--size="))?.slice(7) || 4000,
  );
  if (!Number.isSafeInteger(size) || size < 4000)
    throw Error("--size must be at least 4000");
  const result = await page.evaluate(
    async ({ size, fontBase64 }) => {
      const failures = [],
        counts = {};
      const check = (condition, name) => {
        if (!condition) failures.push(name);
      };
      const css =
        "@page {size:400px 500px;margin:30px;} html {writing-mode:vertical-rl;} body {font:16px serif;} p {margin:0;}";
      const longText = "雨の窓。反復する文章。🌸".repeat(150);
      let remaining = size - longText.length;
      const paragraphs = [];
      for (let i = 0; remaining > 0; i++) {
        const text =
          `同じ文章を何度も繰り返す。${i}：静かな街で物語を書き続ける。`.slice(
            0,
            remaining,
          );
        paragraphs.push(`<p id="p${i}">${text}</p>`);
        remaining -= text.length;
      }
      const html =
        '<!doctype html><html lang="ja"><head></head><body><p id="long">' +
        longText +
        "</p>" +
        paragraphs.join("") +
        "</body></html>";
      function sidecar(html, revision) {
        const parsed = new DOMParser().parseFromString(html, "text/html"),
          entries = [];
        function walk(node, path) {
          if (node.nodeType === 3 && node.parentElement.closest("body"))
            entries.push({
              path,
              key: `r${revision}:${entries.length}`,
              text: node.nodeValue,
              kind: node.parentElement.closest("rt")
                ? "ruby-reading"
                : node.parentElement.closest("ruby")
                  ? "ruby-base"
                  : "text",
            });
          Array.from(node.childNodes).forEach((child, index) =>
            walk(child, [...path, index]),
          );
        }
        walk(parsed.documentElement, []);
        return entries;
      }
      const source = (html, revision, map = true, resources = []) => ({
        url: location.origin + "/document.html",
        html,
        revision,
        resources,
        ...(map ? { sourceMap: sidecar(html, revision) } : {}),
      });
      const make = (writing = css) => {
        const viewport = document.createElement("div");
        viewport.style.cssText = "width:800px;height:800px";
        document.body.append(viewport);
        const viewer = new VivliostyleCore.CoreViewer(
          {
            viewportElement: viewport,
            userAgentRootURL: location.origin + "/resources/",
          },
          {
            autoResize: false,
            allowScripts: false,
            renderAllPages: false,
            reusePages: true,
            paginationMode: "complete",
            pageViewMode: "singlePage",
          },
        );
        return { viewer, writing };
      };
      function wait(viewer, name = "loaded") {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(Error(name + " timeout"));
          }, 120000);
          const done = (event) => {
            cleanup();
            resolve(event);
          };
          const failed = () => {
            cleanup();
            reject(Error("Core error"));
          };
          function cleanup() {
            clearTimeout(timer);
            viewer.removeListener(name, done);
            viewer.removeListener("error", failed);
          }
          viewer.addListener(name, done);
          viewer.addListener("error", failed);
        });
      }
      async function load(item, input, fragment = "#long") {
        const done = wait(item.viewer);
        item.viewer.loadMemoryDocument(input, {
          fragment,
          authorStyleSheet: [{ text: item.writing }],
        });
        await done;
      }
      const signature = (viewer) =>
        JSON.stringify(
          [
            ...viewer.getCommittedPreviewSnapshotSeed().snapshots.values(),
          ].flatMap((s) =>
            s.pages.map((p) => [p.container.textContent, p.dimensions, p.side]),
          ),
        );
      const mapped = make(),
        plain = make();
      const original = source(html, 10);
      let started = performance.now();
      await load(mapped, original);
      counts.mappedLoadMs = performance.now() - started;
      started = performance.now();
      await load(plain, source(html, 10, false));
      counts.plainLoadMs = performance.now() - started;
      check(
        signature(mapped.viewer) === signature(plain.viewer),
        "sidecar leaves pagination/text unchanged",
      );
      const pageCount = mapped.viewer.getPageSizes().length;
      counts.pages = pageCount;
      let fragmentsChecked = 0;
      function verify(handle, input, label) {
        const texts = new Map(
          input.sourceMap.map((entry) => [entry.key, entry]),
        );
        for (const paper of handle.containers) {
          const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const first = handle.resolveTextPosition(node, 0);
            if (!first) continue;
            fragmentsChecked++;
            for (const offset of [
              0,
              Math.floor(node.nodeValue.length / 2),
              node.nodeValue.length,
            ]) {
              const mapped = handle.resolveTextPosition(node, offset),
                text = texts.get(mapped.key);
              check(
                mapped.revision === input.revision && !!text,
                label + " revision/key",
              );
              check(
                mapped.offset === first.offset + offset &&
                  mapped.offset <= text.text.length,
                label + " fragment offset",
              );
            }
            check(
              texts
                .get(first.key)
                .text.slice(
                  first.offset,
                  first.offset + node.nodeValue.length,
                ) === node.nodeValue,
              label + " exact text slice",
            );
          }
        }
      }
      started = performance.now();
      const paperPacket = JSON.parse(
        JSON.stringify(mapped.viewer.exportCompletedPaper("paper-test")),
      );
      counts.paperExportMs = performance.now() - started;
      counts.paperBytes = new TextEncoder().encode(
        JSON.stringify(paperPacket),
      ).length;
      let leases = 0;
      started = performance.now();
      const paperDocument = new VivliostyleCore.CompletedPaperDocument(
        paperPacket,
        document,
        "paper-test",
        () => {
          leases++;
          return () => leases--;
        },
      );
      counts.paperImportMs = performance.now() - started;
      check(
        paperDocument.pageCount === pageCount,
        "completed paper page count",
      );
      const allPaper = paperDocument.retainPages(
        Array.from({ length: pageCount }, (_, i) => i),
        document,
      );
      check(leases === 2, "document and retained unit have separate leases");
      const sourcePages = [
        ...mapped.viewer.getCommittedPreviewSnapshotSeed().snapshots.values(),
      ].flatMap((s) => s.pages);
      check(
        allPaper.containers.every(
          (p, i) => p.textContent === sourcePages[i].container.textContent,
        ),
        "completed paper exact text",
      );
      paperDocument.release();
      paperDocument.release();
      check(leases === 1, "release leaves retained unit lease alive");
      verify(allPaper, original, "completed transport after document release");
      allPaper.release();
      allPaper.release();
      check(leases === 0, "completed paper releases all leases");
      const hostParent = document.createElement("div");
      hostParent.style.cssText = "width:1100px;height:850px";
      document.body.appendChild(hostParent);
      const paperHost = new VivliostyleCore.CompletedPaperHost(
        paperPacket,
        hostParent,
        "paper-test",
      );
      const isolated = paperHost.retainPages([0]);
      const sourceFirst = sourcePages[0].container;
      check(
        isolated.containers[0].offsetWidth === sourceFirst.offsetWidth &&
          isolated.containers[0].offsetHeight === sourceFirst.offsetHeight,
        "isolated host preserves paper geometry",
      );
      const interference = document.createElement("style");
      interference.textContent = "iframe p { filter: blur(8px) !important; }";
      document.head.appendChild(interference);
      check(
        paperHost.document.defaultView.getComputedStyle(
          isolated.containers[0].querySelector("p"),
        ).filter === "none",
        "parent CSS does not affect old host",
      );
      interference.remove();
      paperHost.release();
      check(
        hostParent.querySelectorAll("iframe").length === 1,
        "retained paper keeps retired host alive",
      );
      verify(isolated, original, "isolated paper after host release");
      isolated.release();
      check(
        hostParent.querySelectorAll("iframe").length === 0,
        "last paper release reclaims host",
      );
      hostParent.remove();
      const assetViewer = make();
      const assetInput = source(
        html
          .replace(
            "<head></head>",
            '<head><link rel="stylesheet" href="assets.css"></head>',
          )
          .replace(
            '<p id="long">',
            '<p>ABCD xyz 123</p><img src="picture.svg"><p id="long">',
          ),
        20,
      );
      assetInput.resources = [
        {
          url: "picture.svg",
          mediaType: "image/svg+xml",
          content:
            '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40"><rect width="30" height="40" fill="red"/></svg>',
        },
        {
          url: "assets.css",
          mediaType: "text/css",
          content:
            "@font-face {font-family:PaperTest;src:url('./font.woff2')} p{font-family:PaperTest,serif}",
        },
        {
          url: "font.woff2",
          mediaType: "font/woff2",
          content: Uint8Array.from(atob(fontBase64), (c) => c.charCodeAt(0))
            .buffer,
        },
      ];
      await load(assetViewer, assetInput);
      const assetPacket = JSON.parse(
        JSON.stringify(
          await assetViewer.viewer.exportCompletedPaperWithResources("assets"),
        ),
      );
      check(
        assetPacket.resources.length === 3,
        "memory image, relative CSS and font bytes included",
      );
      const assetParent = document.createElement("div");
      assetParent.style.cssText = "width:1100px;height:850px";
      document.body.appendChild(assetParent);
      const assetHost = new VivliostyleCore.CompletedPaperHost(
        assetPacket,
        assetParent,
        "assets",
      );
      const assetHandle = assetHost.retainPages([0]);
      const assetImage = assetHandle.containers[0].querySelector("img");
      check(
        !!assetImage && assetImage.src !== assetPacket.resources[0].url,
        "receiver owns a new image URL",
      );
      assetPacket.resources.forEach((resource) =>
        URL.revokeObjectURL(resource.url),
      );
      await assetHost.awaitReady();
      check(
        Array.from(assetHost.document.fonts).some(
          (font) => font.status === "loaded",
        ),
        "receiver font loaded after donor URL revocation",
      );
      await assetImage.decode();
      check(
        assetImage.naturalWidth === 30,
        "image survives donor URL revocation",
      );
      assetHost.release();
      assetHandle.release();
      assetParent.remove();
      const brokenParent = document.createElement("div");
      brokenParent.style.cssText = "width:1100px;height:850px";
      document.body.appendChild(brokenParent);
      const brokenPacket = {
        ...assetPacket,
        resources: assetPacket.resources.map((resource) =>
          resource.mediaType === "font/woff2"
            ? { ...resource, base64: "AA==" }
            : resource,
        ),
      };
      const brokenHost = new VivliostyleCore.CompletedPaperHost(
        brokenPacket,
        brokenParent,
        "assets",
      );
      const brokenHandle = brokenHost.retainPages([0]);
      let brokenFontRejected = false;
      try {
        await brokenHost.awaitReady();
      } catch {
        brokenFontRejected = true;
      }
      check(
        brokenFontRejected,
        "recipient rejects loss of a donor-loaded font",
      );
      brokenHost.release();
      brokenHandle.release();
      brokenParent.remove();
      for (const [label, packet, key] of [
        ["key", paperPacket, "bad"],
        [
          "source",
          {
            ...paperPacket,
            pages: [{ ...paperPacket.pages[0], source: 999999 }],
          },
          "paper-test",
        ],
        [
          "boundaries",
          {
            ...paperPacket,
            sources: [{ ...paperPacket.sources[0], signatures: [] }],
          },
          "paper-test",
        ],
      ]) {
        let rejected = false;
        try {
          new VivliostyleCore.CompletedPaperDocument(packet, document, key);
        } catch {
          rejected = true;
        }
        check(rejected, "completed packet rejects " + label);
      }
      for (const epage of [0, Math.floor(pageCount / 2), pageCount - 1]) {
        if (epage !== 0) {
          const nav = wait(mapped.viewer, "nav");
          mapped.viewer.navigateToPage("epage", epage);
          await nav;
        }
        const retained = mapped.viewer.retainPreviewDisplayUnit();
        check(!!retained, "retain page " + epage);
        verify(retained, original, "original " + epage);
        retained.release();
      }
      const back = wait(mapped.viewer, "nav");
      mapped.viewer.navigateToPage("epage", 0);
      await back;
      const old = mapped.viewer.retainPreviewDisplayUnit();
      const oldText = old.containers.map((paper) => paper.textContent).join("");
      started = performance.now();
      const packet = JSON.parse(
        JSON.stringify(
          mapped.viewer.exportCommittedSeed("source-map-test:" + css),
        ),
      );
      counts.packetExportMs = performance.now() - started;
      counts.packetBytes = new TextEncoder().encode(
        JSON.stringify(packet),
      ).length;
      counts.plainPacketBytes = new TextEncoder().encode(
        JSON.stringify(
          plain.viewer.exportCommittedSeed("source-map-test:" + css),
        ),
      ).length;
      const previousSeed = mapped.viewer.getCommittedPreviewSnapshotSeed();
      const oldPagePositions = previousSeed.snapshots.values().next()
        .value.pages;
      const cachedHandle = new VivliostyleCore.SourceMappedPresentation(
        10,
        0,
        [oldPagePositions[0].container],
        document,
        () => () => {},
      );
      check(
        packet.snapshots[0].sourceTexts.length === original.sourceMap.length,
        "portable source registration",
      );
      check(
        packet.snapshots[0].pages.some((page) => page.sourceMap?.length),
        "portable fragments included",
      );
      const donor = make();
      started = performance.now();
      const imported = await donor.viewer.importCommittedSeed(packet, {
        compatibilityKey: "source-map-test:" + css,
        documentOptions: {
          fragment: "#long",
          authorStyleSheet: [{ text: css }],
        },
      });
      counts.packetImportMs = performance.now() - started;
      check(
        imported.initialPagesTypeset === 0,
        "map import has zero initial layout",
      );
      const transferred = donor.viewer.retainPreviewDisplayUnit();
      verify(transferred, original, "portable import");
      transferred.release();
      // Changing keys alone must not invalidate layout reuse; all reused fragments get r11 identities.
      const next = source(html, 11),
        ready = wait(mapped.viewer),
        reusedReady = wait(mapped.viewer, "previewdisplay");
      mapped.viewer.refreshMemoryDocument(next, {
        reusePages: true,
        fragment: "#long",
      });
      await ready;
      const event = await reusedReady;
      counts.metadataReusedPages = event.reusedPages;
      check(event.reusedPages > 0, "metadata-only update reuses pages");
      const current = mapped.viewer.retainPreviewDisplayUnit();
      verify(current, next, "metadata update");
      current.release();
      verify(old, original, "old presentation after refresh");
      const cachedAgain = new VivliostyleCore.SourceMappedPresentation(
        10,
        0,
        [oldPagePositions[0].container],
        document,
        () => () => {},
      );
      verify(cachedAgain, original, "old cache source map after reuse");
      cachedAgain.release();
      cachedHandle.release();
      check(
        old.containers.map((paper) => paper.textContent).join("") === oldText,
        "old retained DOM unchanged",
      );
      // Change a middle paragraph so prefix/suffix reuse and regenerated text are all exercised.
      const edited = source(
          html.replace('id="p20">', 'id="p20">新しい文。'),
          12,
        ),
        editedReady = wait(mapped.viewer),
        editedReuseReady = wait(mapped.viewer, "previewdisplay");
      mapped.viewer.refreshMemoryDocument(edited, {
        reusePages: true,
        fragment: "#p20",
      });
      await editedReady;
      const editedEvent = await editedReuseReady;
      counts.editedReusedPages = editedEvent.reusedPages;
      const editHandle = mapped.viewer.retainPreviewDisplayUnit();
      verify(editHandle, edited, "edited presentation");
      editHandle.release();
      // A separate Core IIFE must preserve sidecar data on direct same-origin seed cloning too.
      const realm = document.createElement("iframe");
      realm.srcdoc =
        '<!doctype html><script src="' +
        location.origin +
        '/core.js"></script><body><div id="viewport" style="width:800px;height:800px"></div></body>';
      const realmReady = new Promise((resolve) => (realm.onload = resolve));
      document.body.append(realm);
      await realmReady;
      const realmViewer = new realm.contentWindow.VivliostyleCore.CoreViewer(
        {
          window: realm.contentWindow,
          viewportElement: realm.contentDocument.getElementById("viewport"),
          userAgentRootURL: location.origin + "/resources/",
        },
        {
          autoResize: false,
          allowScripts: false,
          renderAllPages: false,
          paginationMode: "complete",
          pageViewMode: "singlePage",
        },
      );
      const realmInput = source(edited.html, 13),
        realmLoaded = wait(realmViewer),
        realmDisplay = wait(realmViewer, "previewdisplay");
      const parentUnit = mapped.viewer.getCurrentPreviewDisplayUnit();
      const directClone =
        new realm.contentWindow.VivliostyleCore.SourceMappedPresentation(
          parentUnit.revision,
          parentUnit.epage,
          parentUnit.containers,
          realm.contentDocument,
          () => () => {},
        );
      verify(directClone, edited, "separate Core IIFE direct DOM clone");
      directClone.release();
      realmViewer.loadMemoryDocument(realmInput, {
        fragment: "#p20",
        authorStyleSheet: [{ text: css }],
        reusePages: true,
        previewSnapshotSeed: realmViewer.preparePreviewSnapshotSeed(
          mapped.viewer.getCommittedPreviewSnapshotSeed(),
        ),
      });
      await realmLoaded;
      const realmEvent = await realmDisplay;
      counts.otherRealmReusedPages = realmEvent.reusedPages;
      counts.otherRealmCache = realmEvent.cacheResults;
      const realmPaper = realmViewer.retainPreviewDisplayUnit(document);
      verify(realmPaper, realmInput, "separate Core IIFE clone");
      // A preprocessing/layout mismatch may conservatively reject cache reuse.
      // Its fresh result must still have the right correspondence.
      realmPaper.release();
      const splitPacket = JSON.parse(
        JSON.stringify(realmViewer.exportCommittedSeed("split-source:" + css)),
      );
      const splitReceiver = make();
      await splitReceiver.viewer.importCommittedSeed(splitPacket, {
        compatibilityKey: "split-source:" + css,
        documentOptions: {
          fragment: "#p20",
          authorStyleSheet: [{ text: css }],
        },
      });
      const splitPaper = splitReceiver.viewer.retainPreviewDisplayUnit();
      verify(splitPaper, realmInput, "split-source portable round trip");
      splitPaper.release();
      splitReceiver.viewer.disposeMemoryResources();
      realmViewer.disposeMemoryResources();
      realm.remove();
      // A shortened long TextNode can still contribute unchanged prefix pages.
      // Their mapping must remain serializable against the shorter source node.
      const shortened = source(
        edited.html.replace(longText, longText.slice(0, 1300)),
        14,
      );
      const shortReady = wait(mapped.viewer);
      mapped.viewer.refreshMemoryDocument(shortened, {
        reusePages: true,
        fragment: "#long",
      });
      await shortReady;
      const shortPacket = mapped.viewer.exportCommittedSeed(
          "short-source:" + css,
        ),
        shortReceiver = make();
      await shortReceiver.viewer.importCommittedSeed(shortPacket, {
        compatibilityKey: "short-source:" + css,
        documentOptions: {
          fragment: "#long",
          authorStyleSheet: [{ text: css }],
        },
      });
      const shortPaper = shortReceiver.viewer.retainPreviewDisplayUnit();
      verify(shortPaper, shortened, "shortened source round trip");
      shortPaper.release();
      shortReceiver.viewer.disposeMemoryResources();
      // Reject invalid registrations before allocating declared resources.
      let badRejected = 0;
      for (const change of [
        (entry) => ({ ...entry, text: "wrong" }),
        (entry) => ({ ...entry, path: [9999] }),
        (entry) => ({ ...entry, key: 12 }),
        (entry) => ({ ...entry, kind: "" }),
      ]) {
        const bad = { ...original, sourceMap: [change(original.sourceMap[0])] };
        try {
          plain.viewer.loadMemoryDocument(bad);
        } catch {
          badRejected++;
        }
      }
      check(badRejected === 4, "invalid source text registrations rejected");
      const corrupt = structuredClone(packet);
      corrupt.snapshots[0].pages.find(
        (p) => p.sourceMap?.length,
      ).sourceMap[0].sourcePath = [9999];
      let corruptRejected = false;
      try {
        await make().viewer.importCommittedSeed(corrupt, {
          compatibilityKey: "source-map-test:" + css,
          documentOptions: { authorStyleSheet: [{ text: css }] },
        });
      } catch {
        corruptRejected = true;
      }
      check(corruptRejected, "corrupt portable source correspondence rejected");
      // Ruby and vertical/horizontal writing use the same correspondence, without portable eligibility assumptions.
      const richHtml =
        '<!doctype html><html lang="ja"><body><p id="long"><ruby>親文字<rt>よみ</rt></ruby> と <span style="text-emphasis: sesame">傍点</span> と <span style="text-combine-upright:all">12</span></p></body></html>';
      for (const writing of [
        css,
        css.replace("vertical-rl", "horizontal-tb"),
      ]) {
        const rich = make(writing),
          input = source(richHtml, 20);
        await load(rich, input);
        const handle = rich.viewer.retainPreviewDisplayUnit();
        verify(handle, input, "ruby/writing");
        handle.release();
        rich.viewer.disposeMemoryResources();
      }
      // Core's generated hyphen is anchored to the original soft-hyphen boundary.
      const hyphen = make(
        "@page {size:90px 150px;margin:10px;} html {writing-mode:horizontal-tb;} body {font:16px serif;} p {margin:0;hyphens:manual;}",
      );
      const hyphenInput = source(
        '<!doctype html><html><body><p id="long">' +
          "ab\u00adcd\u00adef\u00adgh\u00adij\u00adkl ".repeat(20) +
          "</p></body></html>",
        25,
      );
      await load(hyphen, hyphenInput);
      let generatedHyphens = 0;
      for (const snapshot of hyphen.viewer
        .getCommittedPreviewSnapshotSeed()
        .snapshots.values()) {
        for (const paper of snapshot.pages) {
          const handle = new VivliostyleCore.SourceMappedPresentation(
            25,
            0,
            [paper.container],
            document,
            () => () => {},
          );
          const walker = document.createTreeWalker(
            handle.containers[0],
            NodeFilter.SHOW_TEXT,
          );
          while (walker.nextNode()) {
            const node = walker.currentNode;
            for (let index = 0; index < node.nodeValue.length; index++)
              if (
                node.nodeValue[index] === "-" ||
                node.nodeValue[index] === "\u2010"
              ) {
                const position = handle.resolveTextPosition(node, index);
                if (position) {
                  generatedHyphens++;
                  check(
                    position.kind === "generated",
                    "generated hyphen classification",
                  );
                  check(
                    hyphenInput.sourceMap[0].text[position.offset] === "\u00ad",
                    "generated hyphen source anchor",
                  );
                }
              }
          }
          handle.release();
        }
      }
      counts.generatedHyphens = generatedHyphens;
      check(
        generatedHyphens > 0,
        "hyphen fixture exercises generated layout text",
      );
      hyphen.viewer.disposeMemoryResources();
      // Coordinate lookup uses actual rendered glyph geometry, including CSS scaling.
      const host = document.createElement("div");
      host.style.cssText =
        "position:fixed;top:0;left:0;z-index:99999;background:white;transform-origin:0 0";
      document.body.append(host);
      host.append(...old.containers);
      const walker = document.createTreeWalker(
        old.containers[0],
        NodeFilter.SHOW_TEXT,
      );
      let node;
      while (walker.nextNode())
        if (
          old.resolveTextPosition(walker.currentNode, 0) &&
          walker.currentNode.nodeValue.length > 3
        ) {
          node = walker.currentNode;
          break;
        }
      check(!!node, "click fixture mapped text exists");
      for (const scale of [1, 0.65, 1.4]) {
        host.style.transform = `scale(${scale})`;
        const range = document.createRange();
        range.setStart(node, 2);
        range.setEnd(node, 3);
        const rect = range.getBoundingClientRect(),
          x = rect.left + rect.width / 2,
          y = rect.top + rect.height / 2;
        const hit = old.hitTestSource(x, y),
          expected = old.resolveTextPosition(node, 2);
        check(
          hit?.key === expected.key &&
            hit?.revision === 10 &&
            Math.abs(hit.offset - expected.offset) <= 1,
          "coordinate lookup scale " + scale,
        );
      }
      check(
        old.hitTestSource(1300, 900) === null,
        "outside paper has no source",
      );
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const cloned = old.cloneInto(iframe.contentDocument);
      verify(cloned, original, "other-document clone");
      old.release();
      old.release();
      verify(cloned, original, "clone survives original release");
      let rejected = false;
      try {
        old.containers;
      } catch {
        rejected = true;
      }
      check(rejected, "released handle rejects access");
      cloned.release();
      host.remove();
      iframe.remove();
      // Memory Blob URLs remain valid until the last retained handle is released.
      const image = make(),
        imageInput = source(
          '<!doctype html><html><body><p id="long">画像の本文</p><img src="dot.svg"></body></html>',
          30,
          true,
          [
            {
              url: "dot.svg",
              mediaType: "image/svg+xml",
              content:
                '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
            },
          ],
        );
      await load(image, imageInput);
      const lease = image.viewer.retainPreviewDisplayUnit(),
        blobURL = lease.containers[0].querySelector("img").src;
      const leaseClone = lease.cloneInto(document);
      image.viewer.disposeMemoryResources();
      check(
        (await fetch(blobURL)).ok,
        "retained resource survives viewer resource disposal",
      );
      lease.release();
      check((await fetch(blobURL)).ok, "cloned resource lease remains valid");
      leaseClone.release();
      let revoked = false;
      try {
        await fetch(blobURL);
      } catch {
        revoked = true;
      }
      check(revoked, "last release revokes disposed Blob URL");
      // Paper without a sidecar must not keep the old page-float/OPFView tree.
      const plainSignature = signature(plain.viewer);
      const plainPages = [...plain.viewer.getCommittedPreviewSnapshotSeed().snapshots.values()][0].pages;
      const plainReady = wait(plain.viewer);
      const plainReuseReady = wait(plain.viewer, "previewdisplay");
      plain.viewer.refreshMemoryDocument(source(html, 20, false), {
        reusePages: true, fragment: "#long",
      });
      await plainReady;
      const plainReuse = await plainReuseReady;
      const newPlainPages = [...plain.viewer.getCommittedPreviewSnapshotSeed().snapshots.values()][0].pages;
      check(plainReuse.reusedPages > 0, "unmapped paper still reuses layout");
      check(newPlainPages[0] !== plainPages[0] && newPlainPages[0].pageFloatLayoutContext === null,
        "unmapped reused paper drops old layout context");
      check(signature(plain.viewer) === plainSignature, "unmapped refresh preserves complete paper");
      counts.fragmentsChecked = fragmentsChecked;
      mapped.viewer.disposeMemoryResources();
      plain.viewer.disposeMemoryResources();
      donor.viewer.disposeMemoryResources();
      counts.size = size;
      return { failures: [...new Set(failures)], counts };
    },
    {
      size,
      fontBase64: fs
        .readFileSync(
          path.join(
            root,
            "packages/core/test/files/fonts/ArchivoBlack/archivo-black-subset.woff2",
          ),
        )
        .toString("base64"),
    },
  );
  console.log(JSON.stringify(result, null, 2));
  const output = process.argv
    .find((arg) => arg.startsWith("--output="))
    ?.slice(9);
  if (output) {
    const file = path.resolve(output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...result,
          coreSHA256: createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(root, "packages/core/lib/vivliostyle.iife.js"),
              ),
            )
            .digest("hex"),
          nodeVersion: process.version,
          browserVersion: browser.version(),
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  }
  assert.deepEqual(result.failures, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
