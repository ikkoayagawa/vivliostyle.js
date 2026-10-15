import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createBenchmarkFixture} from './core-fixture.mjs';

const input=createBenchmarkFixture(16000,'end');
const fixture={...input,css:'@-epubx-viewport { width:148mm; height:105mm; }\n'+input.css};
const tail=fixture.html.lastIndexOf('</p>');
assert(tail>=0,'fixture has a final paragraph');
const edited=fixture.html.slice(0,tail)+'字'+fixture.html.slice(tail);
const legacyCss=fixture.css.replace(/@-epubx-viewport\s*\{[^}]*\}\s*/u,'');
const css=process.argv.includes('--legacy')?legacyCss:fixture.css;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const file=url.pathname==='/'?'benchmark/harness/index.html':url.pathname==='/vivliostyle.iife.js'?'packages/core/lib/vivliostyle.iife.js':url.pathname.startsWith('/resources/')?'packages/core/resources/'+url.pathname.slice(11):null;
 if(!file||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try {
 // Core intentionally uses a fallback viewport for Headless user agents.
 // This regression must exercise the real host dimensions, as VS Code does.
 const page=await browser.newPage({viewport:{width:1100,height:850},userAgent:'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36'});await page.goto(url);
 await page.waitForFunction(()=>typeof window.benchmarkInit==='function');
 await page.addStyleTag({content:'#viewport { height:850px !important; }'});
 await page.evaluate(()=>window.benchmarkInit({reusePages:true,metric:'loaded',autoResize:false}));
 await page.evaluate(([html,css,url])=>window.benchmarkLoad(html,css,url,120000),[fixture.html,css,url+'/document.html']);
 const originalPaper=await page.evaluate(()=>window.benchmarkPaper());
 await page.setViewportSize({width:1100,height:650});
 await page.addStyleTag({content:'#viewport { height:650px !important; }'});
 const reused=await page.evaluate(([html,css,url])=>window.benchmarkRefresh(html,css,url,120000,'loaded'),[edited,css,url+'/document.html']);
 const paper=await page.evaluate(()=>window.benchmarkPaper());
 console.log(JSON.stringify({heightBefore:850,heightAfter:650,elapsedMs:reused.elapsedMs,reusedPages:reused.reusedPages,results:reused.reuseProfiles.map(x=>({reason:x.reason,layoutChanges:x.layoutChanges,boundary:x.boundaryDiagnostic}))}));
 assert(reused.reusedPages>0,'height-only change must reuse fixed-paper pages');
 await page.evaluate(()=>window.benchmarkInit({reusePages:false,metric:'loaded',autoResize:false}));
 await page.evaluate(([html,css,url])=>window.benchmarkLoad(html,css,url,120000),[edited,css,url+'/document.html']);
 assert.deepEqual(paper,await page.evaluate(()=>window.benchmarkPaper()),'reused text/source must match fresh pagination');
 await page.setViewportSize({width:1100,height:850});
 await page.addStyleTag({content:'#viewport { height:850px !important; }'});
 await page.evaluate(()=>window.benchmarkInit({reusePages:false,metric:'loaded',autoResize:false}));
 await page.evaluate(([html,css,url])=>window.benchmarkLoad(html,css,url,120000),[fixture.html,legacyCss,url+'/document.html']);
 assert.deepEqual(originalPaper,await page.evaluate(()=>window.benchmarkPaper()),'logical viewport must preserve the existing fixed-paper text/source');
 console.log('Fixed-paper height change reuses pages and matches fresh pagination');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
