import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createBenchmarkFixture } from './core-fixture.mjs';

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(fs.readFileSync('benchmark/harness/index.html', 'utf8').replace(
      'window.benchmarkPaper = function () {',
      'window.cancelViewer = () => viewer; window.benchmarkPaper = function () {'));
  } else if (req.url === '/vivliostyle.iife.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync('packages/core/lib/vivliostyle.iife.js'));
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  const fixture = createBenchmarkFixture(40000, 'middle');
  await page.evaluate(([html, css, url]) => {
    window.benchmarkInit({ reusePages: true, metric: 'loaded' });
    const viewer = window.cancelViewer();
    viewer.addListener('error', () => {});
    viewer.loadMemoryDocument({ url, html }, { authorStyleSheet: [{ text: css }] });
  }, [fixture.html, fixture.css, url + '/document.html']);
  await page.waitForFunction(() => !!window.cancelViewer().adaptViewer_.renderTask, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const viewer = window.cancelViewer();
    const task = viewer.adaptViewer_.renderTask;
    let done = false;
    task.whenDone(() => { done = true; });
    viewer.cancelPreviewUpdate();
    await new Promise(resolve => setTimeout(resolve, 100));
    return { done, running: task.isRunning(), currentTaskCleared: viewer.adaptViewer_.renderTask === null };
  });
  console.log(JSON.stringify({ cancellation: result }));
  assert.equal(result.running, false, 'interrupted render task must terminate');
  assert.equal(result.done, true, 'task completion callbacks must run after cancellation');
  await page.evaluate(() => window.benchmarkInit({ reusePages: true, metric: 'loaded' }));
  const loaded = await page.evaluate(([html, css, url]) => window.benchmarkLoad(html, css, url, 60000),
    [fixture.html, fixture.css, url + '/document.html']);
  console.log(JSON.stringify({ subsequentLoadedMs: loaded.elapsedMs }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
