import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-editor.js',import.meta.url),'utf8');
function harness(){
 const timers=new Map(),opened=[];let seq=0;
 class Element {
  constructor(tag){this.tag=tag;this.children=[];this.events={};this.isConnected=true;}
  append(...nodes){for(const n of nodes){n.remove();this.children.push(n);n.parentNode=this;}}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}}
  replaceChildren(){for(const n of [...this.children])n.remove();}
  addEventListener(k,f){this.events[k]=f;}
  set innerHTML(v){this.replaceChildren();this.html=v;}
 }
 const ctx={document:{createElement:t=>new Element(t)},L:a=>a,esc:a=>a,window:{open:(...args)=>opened.push(args)},setTimeout:(f,ms)=>{assert.equal(ms,15000);timers.set(++seq,f);return seq;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(src.slice(src.indexOf('function fileFrame('),src.indexOf('/* ------------------------------------------------ opening a file')),ctx);
 return {ctx,timers,opened,timeout(){const jobs=[...timers.values()];timers.clear();jobs.forEach(f=>f());}};
}
test('original webpage load clears its timeout and spinner',()=>{
 const h=harness(),w=h.ctx.fileFrame('https://example.com','Site','Loading',true),f=w.children.find(n=>n.tag==='iframe');
 assert.equal(h.timers.size,1);f.events.load();assert.equal(h.timers.size,0);assert.equal(w.children.length,1);
});
test('stalled or failed pages offer retry and external open; a late load still clears the message',()=>{
 const h=harness(),w=h.ctx.fileFrame('https://example.com','Site','Loading',true),f=w.children.find(n=>n.tag==='iframe');
 h.timeout();const l=w.children.find(n=>n.className==='fileloading');assert.equal(l.children.length,3);
 l.children[2].onclick();assert.deepEqual(h.opened,[['https://example.com','_blank','noopener']]);
 l.children[1].onclick();assert.equal(h.timers.size,1);f.events.error();assert.equal(h.timers.size,0);assert.equal(l.children.length,3);
 f.events.load();assert.equal(w.children.length,1);
});
test('local document conversions are not given the website timeout',()=>{
 const h=harness();h.ctx.fileFrame('/preview.pdf','PDF','Converting');assert.equal(h.timers.size,0);
});
function links(embedded=false){
 const opened=[],read=[];let click;
 const ctx={URL,S:{uid:'fixture',chat:'chat:source'},location:{href:'http://127.0.0.1:8010/ui/app.html',origin:'http://127.0.0.1:8010'},window:{open:(...a)=>opened.push(a)},openPgaUrl:u=>read.push(u),fpBrowserAvailable:()=>embedded,
  document:{querySelectorAll:()=>[],getElementById:()=>null,addEventListener:(k,f,capture)=>{assert.ok(['click','pointerdown'].includes(k));assert.equal(capture,true);if(k==='click')click=f;}}};
 vm.runInNewContext(src.slice(src.indexOf('const FP_WEB_DOC')),ctx);
 const go=(href,{target='',mods={},inReader=false}={})=>{
  const a={target,getAttribute:()=>href,hasAttribute:()=>false,closest:s=>s==='.webread'&&inReader?{}:null};
  const e={button:0,defaultPrevented:false,...mods,target:{closest:()=>a},preventDefault(){this.defaultPrevented=true;},stopPropagation(){}};
  click(e);return e.defaultPrevented;
 };
 return {opened,read,go};
}
test('web pages and documents open in the right-hand workspace',()=>{
 const h=links();
 for(const u of ['https://example.com/','https://news.example.com/2026/11/story.html','https://github.com/a/b/blob/main/README.md','https://github.com/a/b/tree/main/docs','https://example.com/search?q=report.pdf'])
  assert.equal(h.go(u),true,u);
 assert.deepEqual(h.read,['https://example.com/','https://news.example.com/2026/11/story.html','https://github.com/a/b/blob/main/README.md','https://github.com/a/b/tree/main/docs','https://example.com/search?q=report.pdf']);
 for(const u of ['https://example.com/files/report.pdf','https://example.com/%E6%8A%A5%E5%91%8A.docx','https://example.com/data.xlsx?dl=1','https://example.com/deck.pptx','https://raw.githubusercontent.com/a/b/main/README.md','https://example.com/a.png','https://arxiv.org/pdf/2401.12345','https://openreview.net/pdf?id=abc'])
  assert.equal(h.go(u),true,u);
 assert.equal(h.read.length,13);assert.equal(h.opened.length,0);
});
test('PGA links and modifier clicks stay untouched; Markdown new-tab links use the reader',()=>{
 const h=links();
 assert.equal(h.go('/v1/bodies/1/markdown'),false);
 assert.equal(h.go('mailto:a@example.com'),false);
 assert.equal(h.go('https://example.com/',{mods:{metaKey:true}}),false);
 assert.equal(h.go('https://example.com/',{target:'_blank'}),true);
 assert.equal(h.go('https://example.com/',{target:'_blank',inReader:true}),true);
 assert.equal(h.opened.length,0);assert.equal(h.read.length,2);
});
test('direct video links open a file window and ordinary links still open a reading conversation', async () => {
 const files=[], articles=[], messages=[];
 const ctx={URL,window:{},S:{view:'stage',uid:'user'},L:zh=>zh,toast:m=>messages.push(m),
  stOpenFile:(...args)=>files.push(args),readingOpen:(...args)=>articles.push(args),document:{addEventListener(){}}};
 ctx.window.top=ctx.window;
 vm.runInNewContext(src.slice(src.indexOf('async function openPgaUrl(')),ctx);
 const origin={key:'chat:source'};
 for(const url of ['https://media.example/clip%2EMP4?token=ab#t=15','https://media.example/clip.webm'])
  await ctx.openPgaUrl(url,'user',true,origin);
 for(const url of ['https://example.org/watch?q=clip.mp4','https://github.com/a/b/blob/main/clip.mov','https://arxiv.org/pdf/1234'])
  await ctx.openPgaUrl(url,'user',true,origin);
 await ctx.openPgaUrl('https://u:p@media.example/clip.mp4','user',true,origin);
 assert.equal(files.length,2);assert.equal(articles.length,3);assert.equal(messages.length,1);
 assert.deepEqual(files[0],['https://media.example/clip%2EMP4?token=ab#t=15',origin.key,'user',true,origin]);
});
test('desktop links including target blank stay in PGA while modifier clicks remain external',()=>{
 const h=links(true);
 assert.equal(h.go('https://example.com/'),true);
 assert.equal(h.go('https://example.com/new',{target:'_blank'}),true);
 assert.equal(h.go('https://example.com/report.pdf'),true);
 assert.equal(h.go('https://example.com/',{mods:{metaKey:true}}),false);
 assert.equal(h.go('https://example.com/',{mods:{ctrlKey:true}}),false);
 assert.equal(h.go('http://127.0.0.1:8010/v1/foo'),false);
 assert.equal(h.go('javascript:alert(1)'),false);
 assert.equal(h.read.length,3);assert.equal(h.opened.length,0);
});

test('file actions download the original ticket and reveal the resolved file in Finder',async()=>{
 const calls=[],downloads=[],messages=[];
 class Element{constructor(tag){this.tag=tag;this.removed=false;}click(){downloads.push(this.href);}remove(){this.removed=true;}}
 const ctx={URL,window:{},location:{origin:'http://127.0.0.1:8010'},S:{uid:'user-1'},
  document:{body:{append(){}},createElement:t=>new Element(t)},L:a=>a,
  api:async(path,opts)=>{calls.push([path,opts.body]);if(path.endsWith('/files/view'))return {download_url:'/v1/file-preview/ticket-1/download'};return {opened:true};},
  toast:m=>messages.push(m)};
 vm.runInNewContext(src.slice(src.indexOf('async function fpReveal('),src.indexOf('function fpTab(')),ctx);
 assert.equal(await ctx.fpDownload({path:'/tmp/report.pptx',uid:'user-1',key:'chat-1',info:{download_url:'/v1/file-preview/ticket-1/download'}}),true);
 assert.deepEqual(downloads,['http://127.0.0.1:8010/v1/file-preview/ticket-1/download']);
 assert.equal(await ctx.fpDownload({file:{download_url:'/v1/file-preview/ticket-2/download'}}),true);
 assert.equal(downloads.at(-1),'http://127.0.0.1:8010/v1/file-preview/ticket-2/download');
 assert.equal(await ctx.fpReveal({path:'/tmp/report.pptx',uid:'user-1',key:'chat-1',info:{path:'/tmp/report.pptx'}}),true);
 assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['/v1/users/user-1/files/open',{path:'/tmp/report.pptx',key:'chat-1',reveal:true}]));
 assert.equal(await ctx.fpReveal({path:'/tmp/cache.pdf'}),true);
 assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['/v1/users/user-1/files/open',{path:'/tmp/cache.pdf',key:'',reveal:true}]));
 assert.equal(await ctx.fpDownload({path:'/tmp/report.pptx',uid:'user-1',key:'chat-1'}),true);
 assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['/v1/users/user-1/files/view',{path:'/tmp/report.pptx',key:'chat-1'}]));
 assert.equal(downloads.length,3);
 assert.equal(await ctx.fpDownload({path:'/tmp/report.pptx',uid:'user-1',dirty:true,info:{download_url:'/v1/file-preview/ticket-1/download'}}),false);
 assert.equal(downloads.length,3);assert.match(messages.at(-1),/先保存/);
});

test('ordinary browsing opens sites and remote PDFs in the shared desktop tab strip', async () => {
  const tabs = [], origin = {key:'chat:source'};
  const ctx = {URL, window:{}, document:{addEventListener(){}}, S:{uid:'user',view:'stage'},
    fpCaptureOrigin:()=>origin, fpBrowserAvailable:()=>true, openPgaBrowser:(...args)=>tabs.push(args)};
  ctx.window.top = ctx.window;
  vm.runInNewContext(src.slice(src.indexOf('async function openPgaUrl(')),ctx);
  for (const url of ['https://example.com/article','https://example.com/file.pdf','https://arxiv.org/pdf/1234']) {
    await ctx.openPgaUrl(url, "user", undefined, origin);
    assert.deepEqual(tabs.at(-1),[url,'user',origin]);
  }
});
