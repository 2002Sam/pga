/* Capture the actual PGA frontend with public demo data, never a user's database.
 * npm install --prefix /tmp/pga-readme-tools playwright
 * NODE_PATH=/tmp/pga-readme-tools/node_modules node scripts/capture-readme.cjs
 * CHROME_PATH may point to an installed Chromium; otherwise use Playwright's browser.
 * Static assets are served from this checkout. All API requests stay in this process.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let chromium;
try { ({chromium} = require('playwright')); } catch { ({chromium} = require('playwright-core')); }
const root = path.resolve(__dirname, '..'), web = path.join(root, 'src/pga/web');
const out = path.join(root, 'docs/media/screenshots');
const uid = '00000000-0000-4000-8000-000000000001';
const now = new Date().toISOString();
const agentNames = ['claude', 'codex', 'gemini'];
const agents = agentNames.map((name, i) => ({name, role: ['代码与写作', '工程与测试', '研究与分析'][i], adapter: ['claude_local', 'codex_local', 'gemini_local'][i], enabled: true, available: true, detail: '演示连接', working: false, external: true, quota: {remaining: .8, remaining_ratio: .8}}));
const records = [
  ['chat:demo-plan', '发布计划与功能清单', 'claude', 'PGA', '帮我把下一版工作台的发布准备拆成三个可以并行推进的任务。',
    '## 发布准备\n\n围绕一个目标推进：让第一次打开 PGA 的人，能直接看懂怎么开始。\n\n1. **品牌与入口**：统一网页、开屏与桌面图标。\n2. **使用文档**：说明安装步骤、工作台与项目上下文。\n3. **功能验收**：检查分屏对话、页面切换和文件阅读。\n\n三项任务可以分别推进；确定结果后，再汇总到这段对话。'],
  ['chat:demo-code', '工作台交互与验证', 'codex', 'PGA', '整理一下工作台里最常用的交互，给我一份验收清单。',
    '## 工作台验收清单\n\n| 场景 | 检查内容 |\n|---|---|\n| 多窗口 | 不同对话并排显示，输入互不干扰 |\n| 小地图 | 点选窗口、查看项目分组 |\n| 页面 | 保存排布，切换后恢复阅读位置 |\n| 折叠 | 单个窗口、分类和整个台面分别收起 |\n\n**下一步**：用两段短对话检查滚动、折叠与恢复，再检查长内容。'],
  ['chat:demo-docs', 'README 与快速开始', 'claude', 'PGA', '写一段给新用户看的介绍，重点是项目、多 Agent 和持续工作。',
    '## 一个项目，一个持续工作的空间\n\n把对话、文件和多个 AI 放在同一张工作台上。\n\n- **开始**：连接本机 Agent，创建一个项目。\n- **协作**：让管理员拆分任务，或自己指定 Agent。\n- **积累**：保留上下文、文件与阶段结论，随时接着做。\n\n第一次使用可以先开两段对话，体验并排工作。'],
  ['chat:demo-research', '检索与记忆的设计笔记', 'gemini', '研究笔记', '项目资料、对话记录和世界树应该怎么配合？',
    '## 三层上下文\n\n**对话记录**保留当前讨论的过程；**项目资料**保存共同的约束和文件；**世界树**组织跨时间积累的主题。\n\n需要继续一个具体任务时，优先选择相关对话；需要概览时，再读主题摘要。'],
  ['chat:demo-compare', '同一个问题，两种思路', 'claude', 'PGA', '首页应该先展示项目，还是先展示对话？', '可以从工作目标和启动速度两个角度比较。'],
];
const details = Object.fromEntries(records.map(([key,title,agent,project,question,answer], i) => [key, {key,title,turns:[
  {role:'user',text:question,run:`demo-run-${i}`,at:now},
  {role:'agent',text:answer,agent,run:`demo-run-${i}`,at:now,elapsed:8.4},
],children:[],context:[],dispatch:[],multi:[],options:{agent,model:'',effort:''}}]));
details['chat:demo-left'] = {key:'chat:demo-left',turns:[{role:'user',text:records[4][4],at:now,run:'demo-left'},{role:'agent',agent:'claude',run:'demo-left',at:now,text:'## 从项目开始\n\n建议让项目成为首页的主要入口。\n\n### 原因\n\n- 用户回到工作台时，通常要继续一件事。\n- 项目能收纳对话、资料和阶段结论。\n- 对话增多以后，仍然容易找到归属。\n\n### 第一屏\n\n最近使用的项目、待继续的任务，以及一个快速提问入口。\n\n**适合长期推进多个项目的人。**'}]};
details['chat:demo-right'] = {key:'chat:demo-right',turns:[{role:'user',text:records[4][4],at:now,run:'demo-right'},{role:'agent',agent:'codex',run:'demo-right',at:now,text:'## 从对话开始\n\n建议优先呈现最近的对话，让打开到输入之间尽量少一步。\n\n### 原因\n\n- 临时问题不需要先创建项目。\n- 最近使用的对话可以直接续接。\n- 分类可以在工作过程中补充。\n\n### 第一屏\n\n输入框、最近对话和项目筛选，随着内容增长再展开项目结构。\n\n**适合高频、轻量的日常使用。**'}]};
details['chat:demo-compare'].split = {lanes:[{key:'chat:demo-left',agent:'claude'},{key:'chat:demo-right',agent:'codex'}]};
for(const k of ['chat:demo-left','chat:demo-right'])details[k].turns[1].text=details[k].turns[1].text.replace(/#{1,3} /g,'').replace(/\*\*/g,'').replace(/- /g,'');
details['chat:pm-demo']={key:'chat:pm-demo',title:'PGA · 管理员',turns:[{role:'user',text:'准备工作台的下一次发布：整理功能验收清单，写快速开始文档，再汇总需要继续讨论的问题。',run:'manager-run',at:now}],dispatch:[{id:'demo-dispatch',run:'manager-run',tasks:[{key:'chat:demo-code',title:'整理功能验收清单',agent:'codex',why:'代码 · 按偏好排序与可用性分配'},{key:'chat:demo-docs',title:'编写快速开始文档',agent:'claude',why:'办公 · 按偏好排序与可用性分配'}]}],children:[]};
const chats = records.map(([key,title,agent,project],i)=>({key,title,agent,project,turns:2,last_at:now,last:details[key].turns[1].text,archived:false}));
const groups = Object.fromEntries(records.map(([key,,,project])=>[key,project]));
const worldNodes = [{id:'root',kind:'root',title:'我的世界',count:20}];
for (const [i, [title, topics]] of [
  ['PGA 工作台', ['界面设计','Agent 协作','发布与文档']],
  ['研究笔记', ['上下文与检索','知识组织','阅读摘记']],
  ['日常规划', ['本周计划','灵感收集','复盘与改进']],
].entries()) {
  const parent=`topic-${i}`; worldNodes.push({id:parent,parent:'root',kind:'topic',title,count:9,summary:`围绕${title}整理讨论、结论与待办。`});
  topics.forEach((title,j)=>{const id=`topic-${i}-${j}`;worldNodes.push({id,parent,kind:'topic',title,count:3,summary:`${title}的阶段记录与可继续的方向。`});
    ['设计讨论','实现记录','阶段小结'].forEach((s,k)=>worldNodes.push({id:`leaf-${i}-${j}-${k}`,parent:id,kind:'leaf',title:`${title} · ${s}`,turns:4,conversation:records[k][0],who:'user'}));});
}
const windows = ['chat:demo-plan','chat:demo-code','chat:demo-docs'].map((key,i)=>({id:`demo-window-${i}`,type:'win',key,ord:i,bw:494,w:494,links:[],title:details[key].title}));
const pageSnap = {v:5,nodes:windows,ws:{},view:{list:false,sl:0}};
const pages = [{id:'demo-page',name:'发布准备',updated_at:now,snap:pageSnap,chats:windows.map(w=>({key:w.key,w:w.bw}))},
  {id:'research-page',name:'研究与阅读',updated_at:now,snap:{v:5,nodes:[],ws:{},view:{}},chats:[{key:'chat:demo-research'}]}];
const unhandled = new Set();
function api(url, req) {
  const u=new URL(url), p=decodeURIComponent(u.pathname), method=req.method();
  if(p==='/healthz')return {ok:true,owner:uid};
  if(p==='/v1/version')return {ui:'readme-capture',branch_copy:true};
  if(p.endsWith('/forest'))return {trees:[],you:null,knowledge:[],personal:null};
  if(p.endsWith('/console'))return {agents};
  if(p==='/v1/agents')return {agents:Object.fromEntries(agents.map(a=>[a.name,{...a,type:a.adapter}]))};
  if(p.endsWith('/chats'))return chats;
  if(p.endsWith('/timeline'))return {days:120,lines:{},sessions:[],hidden:[],pinned:[],pending:0};
  if(p.endsWith('/conversation-projects'))return {names:['PGA','研究笔记','日常对话'],of:groups,folders:{PGA:'/demo/pga'}};
  if(p.endsWith('/pages'))return pages;
  if(p.includes('/pages/'))return pages.find(x=>x.id===p.split('/').pop())||pages[0];
  if(p.includes('/chats/chat:'))return details[p.split('/chats/')[1]]||{turns:[],children:[]};
  if(p.endsWith('/access'))return {current:{access:'auto',folder:'/demo/pga',resolved_folder:'/demo/pga',mcp:false},mcp_servers:[]};
  if(p.endsWith('/world'))return {nodes:worldNodes,built:now,building:null};
  if(p.endsWith('/facts'))return {facts:0,invalidated:0,pending:0};
  if(p.endsWith('/graph'))return {nodes:[],links:[]};
  if(p.endsWith('/inputs'))return {inputs:records.map(r=>({text:r[4],key:r[0],at:now}))};
  if(p.endsWith('/live')||p.endsWith('/live/snapshot'))return [];
  if(p.endsWith('/pad'))return {text:'',rev:1,sent:[]};
  if(p.endsWith('/memos'))return [];
  if(p.endsWith('/avatars'))return {avatars:{}};
  if(p.endsWith('/dreams'))return {dreams:[]};
  if(p.endsWith('/arena'))return {rankings:[]};
  if(p.endsWith('/options'))return {models:[],efforts:[],default_model:''};
  if(p.endsWith('/chat-context'))return {};
  if(p.endsWith('/route'))return {rankings:{}};
  if(p.endsWith('/usage/split'))return {};
  if(p==='/v1/users/'+uid)return {id:uid,preferences:{}};
  if(p.endsWith('/cache'))return {all:{calls:0}};
  if(p.endsWith('/hub'))return {agents:[],conversations:[]};
  if(p.endsWith('/notes'))return [];
  if(p.endsWith('/project-map'))return {project:'PGA',conversations:chats.filter(c=>c.project==='PGA').map(c=>({...c,last:now})),outside:[],edges:[],topics:[],files:[]};
  if(p.endsWith('/models'))return {models:[],agent_models:{}};
  if(p.endsWith('/context'))return {turns:[],text:''};
  if(p.endsWith('/dirs/recent'))return [];
  if(p.endsWith('/files/view'))return {path:'/demo/pga/release-notes.md',name:'release-notes.md',kind:'text',markdown:true,editable:true,mtime:1,text:'# 发布准备\n\n## 这次要交付什么\n\n- 统一魔女猫 Logo 与应用图标\n- 整理工作台的快速开始文档\n- 验收双 Agent 分屏和项目上下文\n\n## 验收记录\n\n| 功能 | 验收方式 |\n|---|---|\n| 工作台 | 打开、排列、折叠两个对话 |\n| 页面 | 保存快照并切换恢复 |\n| 文件 | 对照文档修改代码 |\n\n## 下一步\n\n完成检查后整理发布说明。'};
  if(p.endsWith('/files/stat'))return {mtime:1};
  if(p.endsWith('/background'))return {enabled:false};
  if(p.endsWith('/updates'))return [];
  if(p.endsWith('/chat-world'))return {};
  unhandled.add(method+' '+p.replace(uid,':uid'));
  return {};
}
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json','.ttf':'font/ttf'};
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const rel=u.pathname==='/'?'app.html':u.pathname==='/agents'?'agents.html':u.pathname.replace(/^\/ui\//,'').replace(/^\//,'');
  const f=path.resolve(web,rel);
  if(!f.startsWith(web+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);
});
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const installed='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath=process.env.CHROME_PATH||(fs.existsSync(installed)?installed:undefined);
  const browser=await chromium.launch({headless:true,executablePath});
  try {
    const ctx=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
    await ctx.addInitScript(({uid, snap})=>{
      localStorage.setItem('pga_uid',uid);localStorage.setItem('pga_page_cur','demo-page');
      localStorage.setItem('pga_theme','dark');localStorage.setItem('pga_palette','original');
      localStorage.setItem('pga_st4',JSON.stringify(snap));
      localStorage.setItem('pga_pj_fold_v2',JSON.stringify({PGA:false,'研究笔记':false}));
      localStorage.setItem('pga_world_mode','tree');localStorage.setItem('pga_pad_off','1');
    },{uid,snap:pageSnap});
    await ctx.route('**/*',async r=>{
      const u=new URL(r.request().url());
      if(u.origin===base&&(u.pathname.startsWith('/v1/')||u.pathname==='/healthz'))return r.fulfill({json:api(u.href,r.request())});
      if(!['GET','HEAD'].includes(r.request().method()))return r.abort();
      return r.continue();
    });
    const page=await ctx.newPage(), errors=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error('pageerror',e.stack)});
    const open=async query=>{await page.goto(base+'/?as='+uid+'&'+query,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof S!=='undefined'&&S.chats?.length===5&&!document.querySelector('#boot'));};
    const shot=async name=>{await page.screenshot({path:path.join(out,name+'.png')});console.log('captured',name);};
    await open('view=stage');
    await page.waitForTimeout(1800);
    await page.waitForTimeout(1700);
    await page.evaluate(()=>stDropToggle(true));await page.waitForTimeout(350);await shot('01-workspace');
    await page.locator('#stpgb').click();await shot('02-pages');
    await open('view=chats&c=chat:demo-compare');
    await page.waitForFunction(()=>document.querySelectorAll('.split-lane').length===2);
    await page.evaluate(()=>setMini(false));await page.waitForTimeout(300);await shot('03-second-opinion');
    await open('view=graph');await page.waitForTimeout(1600);
    await page.evaluate(()=>setMini(false));await page.waitForTimeout(350);await page.evaluate(()=>{W.fitted=false;worldFit();});await shot('04-world-tree');
    await open('view=chats&c=chat:pm-demo&manager=PGA');await page.waitForFunction(()=>document.querySelector('#pmsvg-graph')?.children.length>0);await page.waitForTimeout(500);await shot('07-manager');
    await open('view=chats&c=chat:demo-docs');await page.evaluate(()=>openPgaFile('/demo/pga/release-notes.md'));await page.waitForTimeout(500);await shot('06-files');
    await open('view=looks');await page.evaluate(()=>setMini(false));await page.waitForTimeout(300);await shot('05-appearance');
    console.log(JSON.stringify({errors,unhandled:[...unhandled]},null,2));
    if(errors.length)process.exitCode=1;
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
