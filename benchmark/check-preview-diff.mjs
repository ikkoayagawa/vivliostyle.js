import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const bundle=await build({entryPoints:['packages/core/src/vivliostyle/preview-diff.ts'],bundle:true,write:false,format:'iife',globalName:'Diff',platform:'browser'});
const browser=await chromium.launch({headless:true,channel:process.env.PREVIEW_TEST_BROWSER??'msedge'});
try {
 const page=await browser.newPage();await page.addScriptTag({content:bundle.outputFiles[0].text});
 const result=await page.evaluate(()=>{
  const parse=html=>new DOMParser().parseFromString(html,'text/html').body;
  const blank='<p>\u00a0</p>';
  const cases=[];
  for(const count of [1,2,20]) {
   const old=parse('<p>前</p>'+blank.repeat(count)+'<p>後</p>');
   const next=parse('<p>前</p>'+blank.repeat(count+1)+'<p>後</p>');
   const diff=Diff.comparePreviewDocuments(old,next);
   cases.push({count,prefixStable:Array.from(old.children).slice(0,-1).every((node,index)=>diff.nodes.get(node)===next.children[index]),tailMapped:diff.nodes.get(old.lastElementChild)===next.lastElementChild});
  }
  const old=parse('<p>前</p><p>古</p><p>後</p>'),next=parse('<p>前</p><p>新</p><p>後</p>');
  const ordinary=Diff.comparePreviewDocuments(old,next);
  return {cases,ordinaryTail:ordinary.suffixNodes.has(old.lastElementChild)&&ordinary.nodes.get(old.lastElementChild)===next.lastElementChild};
 });
 for(const row of result.cases){assert.equal(row.prefixStable,true,JSON.stringify(row));assert.equal(row.tailMapped,true);}
 assert.equal(result.ordinaryTail,true);console.log(JSON.stringify(result));
}finally{await browser.close();}
