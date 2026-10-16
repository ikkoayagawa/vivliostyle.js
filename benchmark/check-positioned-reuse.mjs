// Ogenkou fork regression: contained absolute positioning in a multi-page preview.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const split = arg.indexOf("=");
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
const require = createRequire(path.join(args.modules ? path.resolve(args.modules) : root, "package.json"));
const { chromium } = require("playwright");
const browserPath = args.browser || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);
const bundle = path.join(root, "packages/core/lib/vivliostyle.iife.js");
const server = http.createServer(async (req, res) => {
  if (req.url === "/core.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await fs.readFile(bundle));
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><div id="viewport" style="width:900px;height:800px"></div><script src="/core.js"></script>');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch(browserPath ? { executablePath: browserPath, headless: true } : { headless: true });
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const mode of ["horizontal-tb", "vertical-rl"]) {
    const page = await browser.newPage();
    await page.goto(origin);
    const result = await page.evaluate(async (mode) => {
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const css = `@page{size:100mm 100mm;margin:10mm;@bottom-center{content:counter(page)}}@page:left{margin-left:12mm}@page:right{margin-right:12mm}@page special{margin:15mm;@bottom-center{content:none}}html,body{writing-mode:${mode}}body{font:12pt serif}.positioned-box{display:block;position:relative;width:60mm;height:40mm;break-inside:avoid;overflow:hidden;box-sizing:border-box;margin:0;padding:0;border:0}.positioned-content{display:block;position:absolute;top:5mm;left:5mm;width:40mm;height:20mm;overflow:hidden;box-sizing:border-box;margin:0;padding:0;border:0}.special{page:special;break-before:page;break-after:page}.after{break-before:page}`;
      function html(edit = "none", graphic) {
        const paragraphs = (count, prefix) => Array.from({ length: count }, (_, i) => `<p id="${prefix}${i}">${prefix} ${i}. 春の雨が窓をたたく。遠くの街を眺めながら、物語を書き続ける。</p>`);
        const before = paragraphs(20, "before"), after = paragraphs(40, "after");
        if (edit === "after") after.splice(28, 0, "<p><br></p>");
        if (edit === "before") before.splice(4, 0, "<p><br></p>");
        const left = edit === "move" ? "8mm" : "5mm";
        const width = edit === "width" ? "45mm" : "40mm";
        const drawing = graphic ?? `<div class="positioned-box"><div class="positioned-content" style="left:${left};width:${width}">${edit === "text" ? "変更した奥付の内容。" : "書名と著者と発行日。"}</div></div>`;
        return `<!doctype html><html lang="ja"><head><style>${css}</style></head><body><section>${before.join("")}</section><section class="special"><h1>特殊ページ</h1>${drawing}</section><section class="after">${after.join("")}</section></body></html>`;
      }
      function source(html, revision) {
        const parsed = new DOMParser().parseFromString(html, "text/html"), sourceMap = [];
        function walk(node, path) {
          if (node.nodeType === 3 && node.parentElement.closest("body")) sourceMap.push({ path, key: `revision${revision}:${sourceMap.length}`, text: node.nodeValue, kind: "text" });
          Array.from(node.childNodes).forEach((child, index) => walk(child, [...path, index]));
        }
        walk(parsed.documentElement, []);
        return { url: location.origin + "/book.html", html, revision, sourceMap };
      }
      function make() {
        const viewport = document.createElement("div"); viewport.style.cssText = "width:900px;height:800px"; document.body.append(viewport);
        return new VivliostyleCore.CoreViewer({ viewportElement: viewport }, { autoResize: false, allowScripts: false, renderAllPages: true, paginationMode: "complete", pageViewMode: "singlePage" });
      }
      function wait(viewer, type = "loaded") {
        return new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); viewer.removeListener(type, done); viewer.removeListener("error", fail); };
          const done = (event) => { cleanup(); resolve(event); };
          const fail = (event) => { cleanup(); reject(Error(String(event.content?.error ?? event.content))); };
          const timer = setTimeout(() => { cleanup(); const a=viewer.adaptViewer_; reject(Error(type + " timeout " + JSON.stringify({position:a.pagePosition,current:!!a.currentPage,currentIndex:a.opfView?.spineItems[0]?.pages.indexOf(a.currentPage),spread:a.currentSpread&&[a.currentSpread.left,a.currentSpread.right].map(p=>p&&({connected:p.container.isConnected,index:a.opfView.spineItems[0].pages.indexOf(p)})),session:a.previewSession&&{revision:a.previewSession.clientRevision,mode:a.previewSession.paginationMode},unit:!!viewer.getCurrentPreviewDisplayUnit(),pages:a.opfView?.spineItems[0]?.pages.length}))); }, 10000);
          viewer.addListener(type, done); viewer.addListener("error", fail);
        });
      }
      async function load(viewer, input, reuse = false, seed, focused = false) {
        const done = wait(viewer, focused ? "focusedterminal" : "loaded");
        viewer.loadMemoryDocument(input, { reusePages: reuse, previewSnapshotSeed: seed, ...(focused ? { fragment: "#after28", focusedDisplayMode: "spread" } : {}) }, { renderAllPages: !reuse, paginationMode: focused ? "target-display-unit" : "complete" });
        await done; await viewer.waitForPreviewResources({ complete: !focused });
      }
      function signature(viewer) {
        const items = viewer.adaptViewer_.opfView.spineItems;
        for (const item of items) for (const page of item.pages) page.container.style.display = "block";
        const round = (value) => Math.round(value * 1000) / 1000;
        return items.flatMap((item) => item.pages.map((page) => {
          const base = page.container.getBoundingClientRect();
          return { text: page.container.textContent, dimensions: page.dimensions, side: page.side,
            boxes: Array.from(page.container.querySelectorAll("p,h1,.positioned-box,.positioned-content")).map((element) => {
              const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
              return [element.tagName, element.textContent, round(rect.x - base.x), round(rect.y - base.y), round(rect.width), round(rect.height), style.fill, style.stroke, style.fontSize, style.writingMode];
            }) };
        }));
      }
      async function verifySource(viewer, input) {
        const packet = viewer.exportCompletedPaper("positioned-reuse"), parent = document.createElement("div"); document.body.append(parent);
        const host = new VivliostyleCore.CompletedPaperHost(packet, parent, "positioned-reuse");
        await host.awaitReady();
        const lease = host.retainPages(packet.pages.map((_, index) => index));
        const texts = new Map(input.sourceMap.map((entry) => [entry.key, entry.text]));
        let checked = 0;
        for (const container of lease.containers) {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode, position = lease.resolveTextPosition(node, 0);
            if (!position) continue;
            check(position.revision === input.revision && texts.has(position.key), "stale source revision/key");
            check(texts.get(position.key).slice(position.offset, position.offset + node.nodeValue.length) === node.nodeValue, "source text mismatch");
            checked++;
          }
        }
        check(checked > 40, "insufficient source fragments");
        lease.release(); host.release(); parent.remove();
        return checked;
      }
      const rows = [], original = source(html(), 1);
      for (const portable of [false, true]) {
        const producer = make(); await load(producer, original);
        check(producer.adaptViewer_.opfView.spineItems[0].pages.length > 5, "fixture is not multi-page");
        let seed, donor;
        if (portable) {
          const payload = JSON.parse(JSON.stringify(producer.exportCommittedSeed("positioned-reuse")));
          donor = make(); const imported = await donor.importCommittedSeed(payload, { compatibilityKey: "positioned-reuse", skipInitialPage: true }); seed = imported.seed;
        }
        for (const edit of ["after", "move", "text", "width", "before"]) {
          const viewer = make(), oracle = make();
          const baseline = viewer.preparePreviewSnapshotSeed(seed ?? producer.getCommittedPreviewSnapshotSeed());
          const input = source(html(edit), rows.length + 2);
          await load(viewer, input, true, baseline); await load(oracle, input);
          const actual = signature(viewer), fresh = signature(oracle);
          check(JSON.stringify(actual) === JSON.stringify(fresh), `${portable}/${edit}: fresh layout mismatch`);
          const reused = viewer.adaptViewer_.opfView.previewReusedPages;
          check(reused > 0, `${portable}/${edit}: no reuse`);
          const specialIndex = actual.findIndex((page) => page.text.includes("特殊ページ"));
          if (edit === "after") check(specialIndex >= 0 && specialIndex < viewer.adaptViewer_.opfView.previewReusedPrefixPages, "unchanged absolute box page not reused");
          const fragments = await verifySource(viewer, input);
          rows.push({ portable, edit, pages: actual.length, reused, fragments });
        }
        const focused = make(), focusedSeed = focused.preparePreviewSnapshotSeed(seed ?? producer.getCommittedPreviewSnapshotSeed());
        await load(focused, source(html("after"), 100), true, focusedSeed, true);
        const unit = focused.getCurrentPreviewDisplayUnit();
        check(unit?.containers.length > 0 && unit.resourcesReady && unit.containers.every((container) => container.isConnected), "focused paper unavailable");
        check(focused.adaptViewer_.opfView.previewReusedPages > 0, "focused absolute reuse missing");
        rows.push({ portable, edit: "focused-spread", papers: unit.containers.length });
      }
      const box = (outer = "", inner = "") => `<div class="positioned-box" style="${outer}"><div class="positioned-content" style="${inner}">奥付の内容。</div></div>`;
      const excluded = [
        box("", "position:fixed"),
        box("position:static"),
        box("height:auto"),
        box("break-inside:auto"),
        box("overflow:visible"),
        box("", "overflow:visible"),
        box("", "left:-1mm"),
        box("", "width:80mm"),
        box("", "width:50%"),
        box("", "transform:translateX(1mm)"),
        box("border:1px solid black"),
        box("display:inline"),
        box("", "display:inline"),
        box("", "max-height:5mm"),
        box("", "min-width:50mm"),
        box("left:10mm"),
      ];
      for (const graphic of excluded) {
        const viewer = make(); await load(viewer, source(html("none", graphic), 200));
        let rejected = false; try { viewer.exportCommittedSeed("positioned-reuse"); } catch { rejected = true; }
        check(rejected, "unsupported absolute box became portable");
        await load(viewer, source(html("after", graphic), 201), true);
        check(viewer.adaptViewer_.opfView.previewReusedPages === 0, "unsupported absolute box reused");
      }
      const styled = make(), referenced = html().replace("</style>", ".positioned-content{transform:translateX(1mm)}</style>");
      await load(styled, source(referenced, 300));
      let rejected = false; try { styled.exportCommittedSeed("positioned-reuse"); } catch { rejected = true; }
      check(rejected, "CSS introduced a transformed absolute box");
      return { mode, rows, excluded: excluded.length + 1 };
    }, mode);
    results.push(result); console.log(JSON.stringify(result)); await page.close();
  }
  assert.equal(results.length, 2);
  const report = { browser: browser.version(), sha256: createHash("sha256").update(await fs.readFile(bundle)).digest("hex"), results };
  if (args.output) await fs.writeFile(path.resolve(args.output), JSON.stringify(report, null, 2) + "\n");
  console.log("Contained absolute reuse, source correspondence, portable import and exclusions passed.");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
