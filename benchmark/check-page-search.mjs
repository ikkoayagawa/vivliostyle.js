import fs from 'node:fs';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
const source = fs.readFileSync(new URL('../packages/core/src/vivliostyle/ops.ts', import.meta.url), 'utf8');
const start = source.indexOf('  private getFirstInFlowElementAtOrAfter(');
const end = source.indexOf('  private getDeepestFirstInFlowChildOffset(', start);
assert(start >= 0 && end > start);
const code = `class Search {
  pageGroupSearch = null; reusePageGroupSearch = false; visits = 0;
  xmldoc = {getElementOffset: (element) => Number(element.dataset.offset)};
  isNormalFlowElement(element) {this.visits++; return !element.hasAttribute('data-hidden');}
  isInlineLevelElement(element) {return element.hasAttribute('data-inline');}
  isPageBoundaryCandidateElement(element) {return this.isNormalFlowElement(element) && !this.isInlineLevelElement(element);}
  ${source.slice(start, end).replace('private ', '')}
}`;
const compiled = (await transform(code, {loader:'ts', target:'es2022'})).code;
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 const result = await page.evaluate((compiled) => {
  const Search = new Function(compiled + '; return Search;')();
  document.body.innerHTML = '<main id="root" data-offset="0">' + Array.from({length:80}, (_,i) =>
   `<section id="s${i}" data-offset="${i*10+1}"><span data-inline data-offset="${i*10+2}"><b id="b${i}" data-offset="${i*10+3}"></b></span><aside data-hidden data-offset="${i*10+4}"><p data-offset="${i*10+5}"></p></aside><p id="p${i}" data-offset="${i*10+6}"></p></section>`).join('') + '</main>';
  const root = document.getElementById('root');
  const reference = new Search(), optimized = new Search();
  optimized.reusePageGroupSearch = true;
  const offsets = Array.from({length:80}, (_,i)=>i*10+5);
  const expected = offsets.map(x=>reference.getFirstInFlowElementAtOrAfter(root,x)?.id ?? null);
  const actual = offsets.map(x=>optimized.getFirstInFlowElementAtOrAfter(root,x)?.id ?? null);
  const visits = [reference.visits, optimized.visits];
  const backwards = [9999, 2, 2, 25, 0, 800, 13].map(x=>[
    reference.getFirstInFlowElementAtOrAfter(root,x)?.id ?? null,
    optimized.getFirstInFlowElementAtOrAfter(root,x)?.id ?? null,
  ]);
  const subtree = document.getElementById('s10');
  const roots = [100, 103, 105, 110].map(x=>[
    reference.getFirstInFlowElementAtOrAfter(subtree,x)?.id ?? null,
    optimized.getFirstInFlowElementAtOrAfter(subtree,x)?.id ?? null,
  ]);
  return {expected,actual,visits,backwards,roots};
 }, compiled);
 assert.deepEqual(result.actual,result.expected);
 for(const [expected,actual] of [...result.backwards,...result.roots]) assert.equal(actual,expected);
 assert(result.visits[1] < result.visits[0]/5);
 console.log('Page-start search matches fresh traversal: nested/inline/hidden nodes, backward/equal offsets, changed roots. Visits:', result.visits);
} finally {await browser.close();}
