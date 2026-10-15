import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=await mkdtemp(path.join(tmpdir(),'vivliostyle-page-content-'));
try {
 const bundle=path.join(output,'page-content.mjs');
 await build({stdin:{contents:'export * from "./packages/core/src/vivliostyle/css-page.ts"; export {CascadeValue} from "./packages/core/src/vivliostyle/css-cascade.ts"; export {LexicalScope} from "./packages/core/src/vivliostyle/exprs.ts"; export * as Css from "./packages/core/src/vivliostyle/css.ts";',resolveDir:root},bundle:true,format:'iife',globalName:'PageContentTest',platform:'browser',outfile:bundle,define:{VIVLIOSTYLE_DEBUG:'false'}});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage();await page.setContent('<!doctype html>');await page.addScriptTag({path:bundle});
  const result=await page.evaluate(()=>{
   const {PageRulePartition,resolvePageSizeAndBleed,CascadeValue,LexicalScope,Css}=PageContentTest;
   const create=style=>new PageRulePartition(new LexicalScope(null),{children:[]},style,resolvePageSizeAndBleed(style));
   const read=p=>[p.contentWritingMode?.value.toString()??null,p.contentColumnCount?.value.toString()??null];
   const defaults=read(create({'writing-mode':new CascadeValue(Css.ident.vertical_rl,0)}));
   const valid=['horizontal-tb','vertical-rl','vertical-lr'].map(mode=>read(create({'--vivliostyle-page-content-writing-mode':new CascadeValue(Css.getName(mode),0),'--vivliostyle-page-content-column-count':new CascadeValue(new Css.Int(1),0)})));
   const invalid=[['invalid',0],['inherit',-1],['auto',1.5],['sideways-rl',101]].map(([mode,count])=>read(create({'--vivliostyle-page-content-writing-mode':new CascadeValue(Css.getName(mode),0),'--vivliostyle-page-content-column-count':new CascadeValue(new Css.Numeric(count,''),0)})));
   return {defaults,valid,invalid};
  });
  assert.deepEqual(result.defaults,[null,null]);assert.deepEqual(result.valid,[['horizontal-tb','1'],['vertical-rl','1'],['vertical-lr','1']]);assert(result.invalid.every(p=>p.every(v=>v===null)));
 } finally {await browser.close();}
 console.log('page content style: defaults unchanged; three writing modes; literal column count; invalid values ignored');
} finally {if(path.dirname(output)!==path.resolve(tmpdir())||!path.basename(output).startsWith("vivliostyle-page-content-"))throw Error("Unexpected temporary directory");await rm(output,{recursive:true,force:true});}
