import { _electron as electron } from 'playwright';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(); mkdirSync('test-results',{recursive:true});
const dataPath=mkdtempSync(path.join(root,'test-results','账户测试-'));
const lesson='1234567890123456789';
let current=0, unknown=false, brokenImage=false, closed=false;
const submissions=[], modelCalls=[], sockets=new Set();
const problems=[
  {problemId:'9876543210123456781',problemType:1,body:'图形中标示的答案是什么？',options:[{key:'A',value:'甲'},{key:'B',value:'乙'},{key:'C',value:'丙'}],blanks:[],expected:['B']},
  {problemId:'9876543210123456782',problemType:2,body:'选择所有满足条件的选项。',options:[{key:'A',value:'甲'},{key:'B',value:'乙'},{key:'C',value:'丙'},{key:'D',value:'丁'},{key:'E',value:'戊'}],blanks:[],expected:['A','C','E']},
  {problemId:'9876543210123456783',problemType:4,body:'依次填写两个空位：坐标 ____；文字 ____。',options:[],blanks:[{},{}],expected:['x,y','中文 ∫x dx']},
  {problemId:'9876543210123456784',problemType:1,body:'提交结果未知的测试题。',options:[{key:'A',value:'甲'},{key:'B',value:'乙'}],blanks:[],expected:['A']},
  {problemId:'9876543210123456785',problemType:5,body:'',options:[],blanks:[],expected:['嵌入式系统需要中央处理器、系统存储器和一组输入输出端口。']}
];
function crc(b){let c=0xffffffff;for(const byte of b){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(t,v){const tag=Buffer.from(t),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(v.length);c.writeUInt32BE(crc(Buffer.concat([tag,v])));return Buffer.concat([n,tag,v,c]);}
function image(){const w=400,h=150,raw=Buffer.alloc(h*(1+w*3));for(let y=0;y<h;y++)for(let x=0;x<w;x++)raw.set([50,140,100],y*(1+w*3)+1+x*3);const hd=Buffer.alloc(13);hd.writeUInt32BE(w);hd.writeUInt32BE(h,4);hd[8]=8;hd[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hd),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
function readProbe(url){const png=Buffer.from(url.split(',')[1],'base64');let offset=8,width=0,chunks=[];while(offset<png.length){const n=png.readUInt32BE(offset),t=png.toString('ascii',offset+4,offset+8),v=png.subarray(offset+8,offset+8+n);if(t==='IHDR')width=v.readUInt32BE(0);if(t==='IDAT')chunks.push(v);offset+=12+n;}const raw=inflateSync(Buffer.concat(chunks));return Array.from({length:4},(_,i)=>{const x=Math.floor(width*(i+.5)/4),p=1+x*3;return raw[p]>180?'红':raw[p+1]>100?'绿':'蓝';});}
function questionHtml(){const q=problems[current];return `<section data-problem-id="${q.problemId}" style="padding:24px;background:white;min-height:${brokenImage?'2700':'350'}px"><h1>${q.body}</h1>${q.options.map(o=>`<p>${o.key}. ${o.value}</p>`).join('')}<p>空位数：${q.blanks.length}</p><div style="margin-top:${brokenImage?'2200':'40'}px">题目末尾：此处必须进入截图</div></section>`;}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const authenticated=(req.headers.cookie??'').includes('sessionid=fixture-session');
  const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const html=s=>{res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(s);};
  if(url.pathname==='/v2/web/index')return html('<!doctype html><meta charset="utf-8"><h1>官方登录模拟页面</h1><button onclick="fetch(\'/login\').then(()=>document.getElementById(\'ok\').textContent=\'已登录\')">测试登录</button><p id="ok"></p>');
  if(url.pathname==='/login'){res.setHeader('Set-Cookie','sessionid=fixture-session; HttpOnly; Path=/; SameSite=Lax');return json({ok:true});}
  if(url.pathname==='/v1/chat/completions'){
    let body='';for await(const c of req)body+=c;const parsed=JSON.parse(body);modelCalls.push({body,headers:req.headers});
    const data=JSON.parse(parsed.messages[1].content[0].text);const imgs=parsed.messages[1].content.filter(x=>x.type==='image_url');assert.ok(imgs.length);assert.ok(!req.headers.cookie);assert.ok(!body.includes('fixture-session'));
    const answers=data.stem.includes('四个等宽')?readProbe(imgs[0].image_url.url):problems.find(p=>p.body===data.stem).expected;
    return json({choices:[{message:{content:JSON.stringify({kind:data.kind,answers,explanation:'模拟视觉模型已分析本次题图。'})}}]});
  }
  if(!authenticated)return json({code:401},401);
  if(url.pathname==='/api/v3/user/basic-info')return json({code:0,data:{id:'12345',name:'本地测试账号'}});
  if(url.pathname==='/api/v3/classroom/on-lesson')return json({code:0,data:{onLessonClassrooms:[{lessonId:lesson,classroomId:'789',courseName:'电路基础 · 模拟课堂',role:3}]}});
  if(url.pathname.startsWith('/lesson/fullscreen/v3/'))return html(`<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:sans-serif;background:#ddd}</style><main id="question">${questionHtml()}</main><script>fetch('/api/v3/lesson/checkin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lessonId:'${lesson}',source:5})});setInterval(()=>fetch('/current').then(r=>r.text()).then(t=>{if(document.getElementById('question').innerHTML!==t)document.getElementById('question').innerHTML=t}),150);</script>`);
  if(url.pathname==='/current')return html(questionHtml());
  if(url.pathname==='/api/v3/lesson/checkin'){res.setHeader('Set-Auth','fixture-bearer');return json({code:0,data:{lessonId:lesson,role:3,lessonToken:'fixture-lesson-token',isGuest:false}});}
  if(url.pathname==='/api/v3/lesson/presentation/fetch')return json({code:0,data:{slides:problems.map(p=>({cover:`${origin}/image`,problem:{...p,result:submissions.some(s=>s.problemId===p.problemId)?p.expected:null}}))}});
  if(url.pathname==='/image'){if(brokenImage)return json({error:'image expired'},404);res.writeHead(200,{'Content-Type':'image/png'});return res.end(image());}
  if(url.pathname==='/api/v3/lesson/problem/answer'){let body='';for await(const c of req)body+=c;submissions.push(JSON.parse(body));if(unknown)return req.socket.destroy();return json({code:0});}
  return json({error:'not found'},404);
});
const wss=new WebSocketServer({server,path:'/wsapp/'});
wss.on('connection',ws=>{sockets.add(ws);ws.on('close',()=>sockets.delete(ws));ws.on('message',bytes=>{const d=JSON.parse(bytes.toString());if(d.op==='hello')ws.send(JSON.stringify({op:'hello',presentation:'555',timeline:[],unlockedproblem:[problems[current].problemId]}));if(d.op==='fetchtimeline')ws.send(JSON.stringify({op:'fetchtimeline',timeline:[{type:'problem',prob:problems[current].problemId,pres:'555',sid:problems[current].problemId,limit:120}]}));if(d.op==='probleminfo')ws.send(JSON.stringify({op:'probleminfo',problemid:d.problemid,limit:closed?0:120,now:Date.now(),dt:Date.now(),closed}));});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let application;
const env={...process.env,RAIN_E2E:'1',RAIN_TEST_DATA:dataPath,RAIN_TEST_ORIGIN:origin};delete env.ELECTRON_RUN_AS_NODE;
const state=page=>page.evaluate(()=>window.rain.command({type:'state'}));
async function waitState(page,fn,label){const end=Date.now()+15000;while(Date.now()<end){const s=await state(page);if(fn(s))return s;await new Promise(r=>setTimeout(r,100));}throw new Error(`Timed out: ${label}; ${JSON.stringify(await state(page),(k,v)=>k==='images'?`[${v.length} images]`:v)}`);}
function unlock(){for(const ws of sockets)ws.send(JSON.stringify({op:'unlockproblem',problem:{sid:problems[current].problemId,limit:120}}));}
try{
  application=await electron.launch({args:['.'],env,timeout:20000});
  const page=await application.firstWindow();await page.getByRole('heading',{name:'课堂工作台',exact:true}).waitFor();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.screenshot({path:'test-results/01-dashboard.png',fullPage:true});
  await page.getByRole('button',{name:'打开官方页面'}).click();
  const platformPage=await application.context().waitForEvent('page',{predicate:p=>p!==page,timeout:12000}).catch(()=>null);
  const getPlatform=async()=>{for(let i=0;i<100;i++){const p=application.context().pages().find(p=>p.url().startsWith(origin));if(p)return p;await new Promise(r=>setTimeout(r,100));}throw new Error('platform page not loaded');};
  const official=platformPage?.url().startsWith(origin)?platformPage:await getPlatform();
  await official.getByRole('button',{name:'测试登录'}).click();await official.getByText('已登录',{exact:true}).waitFor();
  await page.getByRole('button',{name:'核验登录 / 刷新课堂'}).click();await waitState(page,s=>s.identity?.name==='本地测试账号','login');
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  await page.getByLabel('Base URL').fill(`${origin}/v1`);await page.getByLabel('模型名称').fill('fixture-vision');await page.getByLabel('API Key').fill('fixture-key');
  await page.getByRole('button',{name:'保存配置',exact:true}).click();await waitState(page,s=>s.model.hasKey,'key saved');
  assert.ok(!readFileSync(path.join(dataPath,'settings.json'),'utf8').includes('fixture-key'));
  await page.getByRole('button',{name:'验证图片识别',exact:true}).click();await waitState(page,s=>s.model.tested,'vision test');
  await page.screenshot({path:'test-results/02-model.png',fullPage:true});
  await page.getByRole('button',{name:'课堂工作台',exact:true}).click();
  await page.getByLabel('正在上课的课堂').selectOption(lesson);await waitState(page,s=>s.selected?.id===lesson&&s.connection==='课堂已连接','lesson joined');
  await page.getByRole('button',{name:'仅预览答案',exact:true}).click();await waitState(page,s=>s.records.some(r=>r.status==='PREVIEW'),'preview');assert.equal(submissions.length,0);
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.getByRole('button',{name:'开始自动提交',exact:true}).click();await waitState(page,s=>s.records.some(r=>r.status==='ACCEPTED'),'single submitted');assert.deepEqual(submissions[0].result,['B']);
  unlock();unlock();await new Promise(r=>setTimeout(r,300));assert.equal(submissions.length,1);
  current=1;unlock();await waitState(page,s=>s.records.filter(r=>r.status==='ACCEPTED').length===2,'multiple submitted');assert.deepEqual(submissions[1].result,['A','C','E']);assert.equal(submissions[1].problemType,2);
  current=2;brokenImage=true;await new Promise(r=>setTimeout(r,500));
  await application.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.minimize();});
  unlock();const blank=await waitState(page,s=>s.records.filter(r=>r.status==='ACCEPTED').length===3,'blank screenshot fallback');
  assert.equal(blank.question.captureSource,'screenshot');assert.equal(blank.question.images.length,2);assert.deepEqual(submissions[2].result,['x,y','中文 ∫x dx']);assert.equal(submissions[2].problemType,4);
  await application.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].restore();});
  await page.screenshot({path:'test-results/03-answered.png',fullPage:true});
  for(const ws of sockets)ws.terminate();
  await waitState(page,s=>s.connection.includes('断开'),'disconnect');
  await waitState(page,s=>s.connection==='课堂已连接','reconnect');
  await new Promise(r=>setTimeout(r,300));assert.equal(submissions.length,3);
  current=4;brokenImage=false;unlock();
  const subjective=await waitState(page,s=>s.records.some(r=>r.questionId===problems[4].problemId&&r.status==='ACCEPTED'),'image-only subjective translation');
  assert.equal(subjective.question.kind,'subjective');
  assert.equal(subjective.question.captureSource,'original');
  assert.equal(submissions[3].problemType,5);assert.equal(submissions[3].problemId,problems[4].problemId);
  assert.deepEqual(submissions[3].result,{content:problems[4].expected[0],pics:[{pic:'',thumb:''}]});
  assert.ok(Number.isSafeInteger(submissions[3].dt)&&submissions[3].dt>1e12);
  assert.match(JSON.parse(modelCalls.at(-1).body).messages[0].content,/英译中/);
  await page.locator('.answer-content').getByText(problems[4].expected[0],{exact:true}).waitFor();
  current=3;unknown=true;unlock();await waitState(page,s=>s.records.some(r=>r.status==='UNKNOWN'),'unknown result');assert.equal(submissions.length,5);
  await page.getByRole('button',{name:'停止',exact:true}).click();await page.getByRole('button',{name:'开始自动提交',exact:true}).click();await new Promise(r=>setTimeout(r,300));assert.equal(submissions.length,5);
  await page.getByRole('button',{name:/^处理记录/}).click();await page.screenshot({path:'test-results/04-records.png',fullPage:true});
  assert.deepEqual(errors,[]);await application.close();application=null;
  application=await electron.launch({args:['.'],env,timeout:20000});const restarted=await application.firstWindow();await restarted.getByRole('heading',{name:'课堂工作台',exact:true}).waitFor();
  const restored=await state(restarted);assert.equal(restored.mode,'stopped');assert.equal(restored.model.tested,true);assert.ok(restored.records.some(r=>r.status==='UNKNOWN'));assert.ok(restored.records.some(r=>r.kind==='subjective'&&r.status==='ACCEPTED'));assert.equal(submissions.length,5);
  await restarted.getByRole('button',{name:'核验登录 / 刷新课堂'}).click();await waitState(restarted,s=>s.identity?.id==='12345','persistent login');
  await restarted.getByRole('button',{name:'退出',exact:true}).click();await waitState(restarted,s=>s.identity===null,'logout');
  const cookieCount=await application.evaluate(async({session})=>(await session.fromPartition('persist:rain-platform').cookies.get({})).length);assert.equal(cookieCount,0);
  const report={passed:true,scenarios:['login','persistent login','logout clears cookies','encrypted API key','image capability probes','preview does not submit','single choice','duplicate events','multiple choice','multi-blank punctuation/order','authenticated screenshot fallback','long screenshot segmentation','minimized capture','websocket reconnect without duplicate submission','image-only subjective translation payload','unknown receipt does not retry','restart stopped with ledger'],submissions:submissions.length,modelRequests:modelCalls.length,screenshotCount:4};
  writeFileSync('test-results/desktop-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(application)await application.close().catch(()=>{});for(const ws of sockets)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
