import { _electron as electron } from 'playwright';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

mkdirSync('test-results', { recursive: true });
const profile = mkdtempSync(path.resolve('test-results', '课堂跳转-'));
const lesson = '1234567890123456789';
const lessonPath = `/lesson/fullscreen/v3/${lesson}`;
const sockets = new Set();
let checkins = 0, mode = 'redirect';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const html = data => { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(data); };
  if (url.pathname === '/v2/web/index') return html('<button onclick="fetch(\'/login\').then(()=>this.textContent=\'已登录\')">测试登录</button>');
  if (url.pathname === '/login') { res.setHeader('Set-Cookie', 'sessionid=navigation-fixture; HttpOnly; Path=/'); return json({ ok: true }); }
  if (!(req.headers.cookie ?? '').includes('sessionid=navigation-fixture')) { res.writeHead(401); return res.end(); }
  if (url.pathname === '/api/v3/user/basic-info') return json({ code: 0, data: { id: '12345', name: '本地跳转测试' } });
  if (url.pathname === '/api/v3/classroom/on-lesson') return json({ code: 0, data: { onLessonClassrooms: [{ lessonId: lesson, classroomId: '789', courseName: '跳转测试', role: 3 }] } });
  if (url.pathname === lessonPath) {
    if (mode === 'network') return req.socket.destroy();
    if (mode === 'cancel' || mode === 'timeout') return;
    const next = mode === 'wrong-lesson' ? '/lesson/fullscreen/v3/456/exercise/0' : `${lessonPath}/exercise/0`;
    return html(`<script>location.replace('${next}')</script><img src='/slow-image'>`);
  }
  if (url.pathname === '/lesson/fullscreen/v3/456/exercise/0') return html('<h1>其他课堂</h1>');
  if (url.pathname === `${lessonPath}/exercise/0`) {
    if (mode === 'redirect-network') return req.socket.destroy();
    return html(`<h1>课堂题目页面</h1>${mode === 'subframe' ? "<iframe src='/broken-frame'></iframe>" : ''}<script>setTimeout(()=>fetch('/api/v3/lesson/checkin',{method:'POST'}),500)</script>`);
  }
  if (url.pathname === '/broken-frame') return req.socket.destroy();
  if (url.pathname === '/api/v3/lesson/checkin') {
    checkins++;
    res.setHeader('Set-Auth', 'navigation-fixture-bearer');
    return json({ code: 0, data: { lessonId: lesson, role: 3, lessonToken: 'navigation-fixture-lesson', isGuest: false } });
  }
  if (url.pathname === '/slow-image') return setTimeout(() => res.end(), 2000);
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/wsapp/' });
wss.on('connection', ws => {
  sockets.add(ws); ws.on('close', () => sockets.delete(ws));
  ws.on('message', bytes => { if (JSON.parse(bytes.toString()).op === 'hello') ws.send(JSON.stringify({ op: 'hello', timeline: [] })); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, RAIN_E2E: '1', RAIN_TEST_DATA: profile, RAIN_TEST_ORIGIN: origin };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await electron.launch({ args: ['.'], env, timeout: 20000 });
  const page = await application.firstWindow();
  await page.getByRole('heading', { name: '课堂工作台', exact: true }).waitFor();
  await page.evaluate(() => { window.navigationNotices = []; window.rain.subscribe(s => window.navigationNotices.push(s.notice)); });
  await page.evaluate(() => window.rain.command({ type: 'login' }));
  const official = application.context().pages().find(p => p.url().startsWith(origin));
  assert.ok(official, 'official view is available');
  await official.getByRole('button', { name: '测试登录' }).click();
  await official.getByRole('button', { name: '已登录' }).waitFor();
  await page.evaluate(() => window.rain.command({ type: 'refresh' }));
  await page.evaluate(() => window.rain.command({ type: 'saveModel', config: { baseUrl: 'https://example.test/v1', model: 'navigation-vision', apiKey: 'synthetic-navigation-key' } }));
  assert.ok(!readFileSync(path.join(profile, 'settings.json'), 'utf8').includes('synthetic-navigation-key'));
  await page.evaluate(lessonId => window.rain.command({ type: 'select', lessonId }), lesson);
  await page.waitForFunction(() => window.navigationNotices.some(n => /会话已连接/.test(n)), undefined, { timeout: 10000 });
  const notices = await page.evaluate(() => window.navigationNotices);
  console.log(JSON.stringify({ scenario: mode, notices, checkins }));
  assert.ok(!notices.some(n => /进入课堂失败.*ERR_ABORTED/.test(n)), 'a same-lesson page redirect must not report entering the classroom as failed');
  const state = await page.evaluate(() => window.rain.command({ type: 'state' }));
  assert.equal(state.selected?.id, lesson);
  assert.equal(checkins, 1, 'native app must not replay the official check-in');
  await application.close(); application = null;
  application = await electron.launch({ args: ['.'], env, timeout: 20000 });
  const restarted = await application.firstWindow();
  await restarted.getByRole('heading', { name: '课堂工作台', exact: true }).waitFor();
  const restored = await restarted.evaluate(() => window.rain.command({ type: 'state' }));
  assert.equal(restored.model.baseUrl, 'https://example.test/v1');
  assert.equal(restored.model.model, 'navigation-vision');
  assert.equal(restored.model.hasKey, true);
  assert.equal(restored.mode, 'stopped');
  for (const scenario of ['network', 'redirect-network', 'wrong-lesson', 'cancel', 'timeout', 'subframe']) {
    mode = scenario;
    const dashboard = await application.firstWindow();
    await dashboard.evaluate(() => { window.navigationNotices = []; window.rain.subscribe(s => window.navigationNotices.push(s.notice)); });
    await dashboard.evaluate(() => window.rain.command({ type: 'refresh' }));
    const before = checkins;
    if (scenario === 'cancel') {
      await dashboard.evaluate(() => window.rain.command({ type: 'login' }));
      await application.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find(w => w.getURL().includes('/v2/web/index'));
        wc.once('did-start-navigation', () => setTimeout(() => wc.stop(), 100));
      });
    }
    const result = await dashboard.evaluate(lessonId => window.rain.command({ type: 'select', lessonId }), lesson);
    if (scenario === 'subframe') {
      await dashboard.waitForFunction(() => window.navigationNotices.some(n => /会话已连接/.test(n)), undefined, { timeout: 10000 });
      const all = await dashboard.evaluate(() => window.navigationNotices);
      assert.ok(!all.some(n => /失败|超时/.test(n)), 'a failed subframe must not overwrite a successful classroom connection');
      assert.equal(checkins, before + 1);
    } else {
      assert.equal(result.selected, null, `${scenario}: unsuccessful navigation cannot select a classroom`);
      assert.equal(checkins, before, `${scenario}: native app cannot replay check-in to recover`);
      if (scenario === 'wrong-lesson') assert.match(result.notice, /未进入所选课堂/);
      else if (scenario === 'timeout') assert.match(result.notice, /加载超时/);
      else if (scenario === 'cancel') assert.match(result.notice, /失败|加载超时/);
      else assert.match(result.notice, /失败.*ERR_|加载失败/);
      assert.equal(result.model.hasKey, true);
    }
    console.log(`PASS: ${scenario}`);
    await application.close(); application = null;
    application = await electron.launch({ args: ['.'], env, timeout: 20000 });
    const next = await application.firstWindow();
    await next.getByRole('heading', { name: '课堂工作台', exact: true }).waitFor();
  }
  console.log('PASS: 8 navigation/restart scenarios; same-classroom redirect, genuine failures, canceled/stalled load, wrong classroom, subframe failure and saved configuration');
} finally {
  if (application) await application.close().catch(() => {});
  for (const ws of sockets) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
