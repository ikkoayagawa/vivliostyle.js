import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath =
  process.argv.find((arg) => arg.startsWith("--browser="))?.slice(10) ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((candidate) => fs.existsSync(candidate));
if (!browserPath)
  throw new Error("Supply --browser=PATH to an existing browser");
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><script src="/core.js"></script><body></body>');
  } else if (req.url === "/slow.css") {
    res.setHeader("Content-Type", "text/css");
    setTimeout(
      () => res.end("/* deliberately delayed import preparation */"),
      100,
    );
  } else if (req.url === "/core.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(
      fs.readFileSync(path.join(root, "packages/core/lib/vivliostyle.iife.js")),
    );
  } else if (req.url.startsWith("/resources/")) {
    const file = path.resolve(
      root,
      "packages/core",
      decodeURIComponent(req.url.slice(1)),
    );
    if (
      !file.startsWith(path.join(root, "packages/core/resources") + path.sep) ||
      !fs.existsSync(file)
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: browserPath,
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const failures = [];
    const check = (ok, name) => {
      if (!ok) failures.push(name);
    };
    const css =
      "@page {size: 400px 500px; margin: 30px;} html {writing-mode: vertical-rl;} body {font-family: serif; font-size: 16px;} p {margin: 0;}";
    const html =
      '<!doctype html><html lang="ja"><body><div id="browse-target"></div>' +
      Array.from(
        { length: 100 },
        (_, i) =>
          `<p id="p${i}">${i}：春の雨が静かに窓をたたく。遠くの街を眺めながら物語を書き続ける。</p>`,
      ).join("") +
      "</body></html>";
    const documentOptions = {
      authorStyleSheet: [{ text: css }],
      fragment: "#browse-target",
    };
    const key = "portable-api-contract-v1\n" + css;
    const make = () => {
      const viewport = document.createElement("div");
      viewport.style.cssText = "width:800px;height:800px";
      document.body.append(viewport);
      return new VivliostyleCore.CoreViewer(
        {
          viewportElement: viewport,
          userAgentRootURL: location.origin + "/resources/",
        },
        {
          autoResize: false,
          allowScripts: false,
          renderAllPages: true,
          paginationMode: "complete",
          pageViewMode: "singlePage",
        },
      );
    };
    const awaitLoaded = (viewer) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(Error("load timeout"));
        }, 30000);
        const done = () => {
            cleanup();
            resolve();
          },
          error = () => {
            cleanup();
            reject(Error("load error"));
          };
        function cleanup() {
          clearTimeout(timer);
          viewer.removeListener("loaded", done);
          viewer.removeListener("error", error);
        }
        viewer.addListener("loaded", done);
        viewer.addListener("error", error);
      });
    const signature = (seed) =>
      JSON.stringify(
        [...seed.snapshots.values()].flatMap((s) =>
          s.pages.map((p) => [
            p.container.textContent,
            p.dimensions,
            p.side,
            p.isBlankPage,
          ]),
        ),
      );
    const producer = make();
    let rejected = false;
    try {
      producer.exportCommittedSeed(key);
    } catch {
      rejected = true;
    }
    check(rejected, "export before full commit rejected");
    const loaded = awaitLoaded(producer);
    producer.loadMemoryDocument(
      {
        url: location.origin + "/document.html",
        html,
        revision: 0,
        resources: [],
      },
      documentOptions,
    );
    await loaded;
    const source = producer.getCommittedPreviewSnapshotSeed();
    const originalSignature = signature(source);
    const audit = JSON.stringify(
      [...source.snapshots.values()][0].pages.map((p) => p.container.outerHTML),
    );
    const packet = JSON.parse(
      JSON.stringify(structuredClone(producer.exportCommittedSeed(key))),
    );
    const fast = make(),
      normal = make(),
      another = make();
    let externalDone = false;
    const precedingListener = () => {
      externalDone = true;
      fast.removeListener("focusedterminal", precedingListener);
    };
    fast.addListener("focusedterminal", precedingListener);
    const [imported, legacy, parallel] = await Promise.all([
      fast.importCommittedSeed(packet, {
        compatibilityKey: key,
        documentOptions,
      }),
      normal.importCommittedSeed(packet, {
        compatibilityKey: key,
        documentOptions,
        skipInitialPage: false,
      }),
      another.importCommittedSeed(packet, {
        compatibilityKey: key,
        documentOptions,
      }),
    ]);
    check(
      imported.initialPagesTypeset === 0 && parallel.initialPagesTypeset === 0,
      "zero-page imports in same realm",
    );
    check(
      externalDone,
      "self-removing earlier listener does not skip import completion",
    );
    check(
      legacy.initialPagesTypeset > 0,
      "normal path actually typesets a page",
    );
    for (const item of [imported, legacy, parallel])
      check(
        signature(item.seed) === originalSignature,
        "imported papers match full pagination",
      );
    check(
      !!fast.getCurrentPreviewDisplayUnit(),
      "import resolves after connected paper",
    );
    const variants = [
      ["format", { ...packet, format: "unknown" }, key],
      ["compatibility", packet, key + "bad"],
      [
        "layout",
        {
          ...packet,
          snapshots: [{ ...packet.snapshots[0], previewLayoutKey: "bad" }],
        },
        key,
      ],
      ["reference-state", { ...packet, snapshots: [{ ...packet.snapshots[0], references: { targets: [{ id: "invalid", spineIndex: 0, pageIndex: -1, counters: {} }], references: [] } }] }, key],
      [
        "nodes",
        {
          ...packet,
          snapshots: [{ ...packet.snapshots[0], nodeSignatures: [] }],
        },
        key,
      ],
      [
        "state",
        {
          ...packet,
          snapshots: [
            {
              ...packet.snapshots[0],
              positions: [
                { class: "unknown", fields: {} },
                ...packet.snapshots[0].positions.slice(1),
              ],
            },
          ],
        },
        key,
      ],
    ];
    for (const [name, payload, compatibilityKey] of variants) {
      let invalid = false;
      try {
        fast.validateCommittedSeed(payload, compatibilityKey);
      } catch {
        invalid = true;
      }
      check(invalid, "reject " + name);
      check(
        signature(imported.seed) === originalSignature,
        "validation leaves donor unchanged " + name,
      );
    }
    const targetDonor = make();
    const atTarget = await targetDonor.importCommittedSeed(packet, {
      compatibilityKey: key,
      documentOptions: { ...documentOptions, fragment: "#p75" },
    });
    check(atTarget.initialPagesTypeset === 0, "late target imports without layout");
    check(targetDonor.getCurrentPreviewDisplayUnit()?.containers[0].textContent.includes("75："), "late imported target is connected and displayed");

    const broken = make(),
      unaffected = make();
    const [bad, good] = await Promise.allSettled([
      broken.importCommittedSeed(variants[2][1], {
        compatibilityKey: key,
        documentOptions,
        timeoutMs: 10000,
      }),
      unaffected.importCommittedSeed(packet, {
        compatibilityKey: key,
        documentOptions,
        timeoutMs: 10000,
      }),
    ]);
    check(
      bad.status === "rejected" && bad.reason.code === "layout",
      "layout failure reports original error",
    );
    check(
      good.status === "fulfilled" && good.value.initialPagesTypeset === 0,
      "failed import does not reject another viewer",
    );
    const aborted = make(),
      controller = new AbortController();
    const aborting = aborted.importCommittedSeed(packet, {
      compatibilityKey: key,
      documentOptions,
      signal: controller.signal,
    });
    controller.abort();
    let abortName;
    try {
      await aborting;
    } catch (error) {
      abortName = error.name;
    }
    check(abortName === "AbortError", "abort terminates promise");
    const canceled = make(),
      canceling = canceled.importCommittedSeed(packet, {
        compatibilityKey: key,
        documentOptions,
      });
    canceled.cancelPreviewUpdate();
    let canceledName;
    try {
      await canceling;
    } catch (error) {
      canceledName = error.name;
    }
    check(canceledName === "AbortError", "explicit cancel terminates promise");
    const timed = make();
    let timeoutCode;
    try {
      await timed.importCommittedSeed(packet, {
        compatibilityKey: key,
        documentOptions: {
          authorStyleSheet: [{ url: location.origin + "/slow.css" }],
        },
        timeoutMs: 5,
      });
    } catch (error) {
      timeoutCode = error.code;
    }
    check(timeoutCode === "timeout", "timeout terminates promise");
    let locked = false;
    try {
      fast.refreshMemoryDocument({
        url: location.origin + "/document.html",
        html,
        revision: 1,
      });
    } catch (error) {
      locked = error.code === "ownership";
    }
    check(locked, "imported donor cannot be reloaded");
    const finalViewer = make(),
      finalLoad = awaitLoaded(finalViewer);
    finalViewer.loadMemoryDocument(
      { url: location.origin + "/document.html", html, revision: 1 },
      documentOptions,
    );
    await finalLoad;
    check(
      signature(finalViewer.getCommittedPreviewSnapshotSeed()) ===
        originalSignature,
      "ordinary load works after import failures/cancellation",
    );
    check(
      JSON.stringify(
        [...source.snapshots.values()][0].pages.map(
          (p) => p.container.outerHTML,
        ),
      ) === audit,
      "producer DOM unchanged",
    );
    return {
      failures,
      pages: packet.snapshots[0].pages.length,
      fastPagesTypeset: imported.initialPagesTypeset,
      normalPagesTypeset: legacy.initialPagesTypeset,
      parallelPagesTypeset: parallel.initialPagesTypeset,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(result.failures, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
