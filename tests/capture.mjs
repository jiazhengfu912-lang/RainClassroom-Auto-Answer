import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

mkdirSync('test-results',{recursive:true});
const dir=mkdtempSync(path.resolve('test-results/capture-'));
await build({entryPoints:['src/main/capture.ts'],outfile:path.join(dir,'capture.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{globalThis.capture=require('./capture.cjs');globalThis.window=new BrowserWindow({webPreferences:{sandbox:true}});window.loadURL('about:blank');});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const application=await electron.launch({args:[path.join(dir,'main.cjs')],env});
try{
  await application.firstWindow();
  const report=await application.evaluate(async({BrowserWindow,nativeImage})=>{
    const wc=BrowserWindow.getAllWindows()[0].webContents;
    const image=nativeImage.createFromBitmap(Buffer.alloc(1280*720*4,255),{width:1280,height:720}).toPNG();
    await wc.session.protocol.handle('https',request=>request.url.includes('/expired.jpg')?new Response('expired',{status:403}):new Response(image,{headers:{'Content-Type':'image/png'}}));
    wc.debugger.attach('1.3');await wc.debugger.sendCommand('Page.enable');
    const cover='https://rain-pri-ups-ali.yuketang.cn/fixture.jpg?auth_key=old';
    const q={questionId:'9876543210123456789',coverUrl:cover,imageUrls:[cover]};
    const html=(url,clip=false,page='exercise')=>`<style>body{margin:0}.lesson__container{width:900px;height:${clip?200:600}px;overflow:hidden}.slide__wrap{width:960px;height:540px;transform:scale(.8);transform-origin:top left}img{width:960px;height:540px}</style><aside class="problem"><img src="${cover}"></aside><section class="lesson__container"><section class="page-${page}"><section class="slide__cmp"><section class="slide__wrap"><img class="cover" src="${url}"></section></section></section></section>`;
    async function load(url,clip,page){await wc.loadURL('data:text/html,'+encodeURIComponent(html(url,clip,page)));await wc.executeJavaScript('Promise.all([...document.images].map(i=>i.decode()))');}
    await load(cover.replace('old','rotated'));
    const shots=await globalThis.capture.screenshotQuestion(wc,q,new AbortController().signal);
    const size=nativeImage.createFromDataURL(shots[0]).getSize();
    await load(cover.replace('old','rotated'),false,'subjective');
    const subjectiveShots=await globalThis.capture.screenshotQuestion(wc,q,new AbortController().signal);
    const qiniuCover='https://rain-pri-ups-qn.yuketang.cn/fixture.jpg?e=100&token=old';
    await load(qiniuCover.replace('e=100&token=old','e=200&token=new'));
    const qiniuShots=await globalThis.capture.screenshotQuestion(wc,{...q,coverUrl:qiniuCover},new AbortController().signal);
    const rejected=[];
    for(const [label,url,clip]of [['wrong slide',cover.replace('fixture.jpg','other.jpg'),false],['changed transform',cover+'&crop=1',false],['clipped slide',cover,true]]){
      await load(url,clip);
      try{await globalThis.capture.screenshotQuestion(wc,q,new AbortController().signal);rejected.push([label,false]);}catch{rejected.push([label,true]);}
    }
    const expired={...q,imageUrls:[cover.replace('fixture.jpg','expired.jpg')],revision:'stable',open:true,answered:false,deadline:null};
    let refreshes=0;
    const recovered=await globalThis.capture.capture(expired,null,wc.session,'https://www.yuketang.cn',new AbortController().signal,async()=>{refreshes++;return {...expired,imageUrls:[cover]};});
    for(const [label,change]of [['changed question',{revision:'changed'}],['closed question',{open:false}],['answered question',{answered:true}],['expired question',{deadline:Date.now()}]]){
      try{await globalThis.capture.capture(expired,null,wc.session,'https://www.yuketang.cn',new AbortController().signal,async()=>({...expired,...change,imageUrls:[cover]}));rejected.push([label,false]);}catch{rejected.push([label,true]);}
    }
    return {shots:shots.length,subjectiveShots:subjectiveShots.length,qiniuShots:qiniuShots.length,size,dpr:await wc.executeJavaScript('devicePixelRatio'),rejected,refreshes,recoveredSource:recovered.captureSource};
  });
  assert.equal(report.shots,1);assert.deepEqual(report.size,{width:768*report.dpr,height:432*report.dpr});
  assert.equal(report.subjectiveShots,1);
  assert.equal(report.qiniuShots,1);
  assert.equal(report.refreshes,1);assert.equal(report.recoveredSource,'original');
  assert.ok(report.rejected.every(([,ok])=>ok),JSON.stringify(report));
  console.log(JSON.stringify({passed:true,...report}));
}finally{await application.close();}
