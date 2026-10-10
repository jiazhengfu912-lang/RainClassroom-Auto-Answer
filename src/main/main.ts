import { app, BrowserWindow, WebContentsView, ipcMain, session, safeStorage, dialog } from 'electron';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Ledger } from '../core/ledger';
import { AnswerEngine } from '../core/engine';
import { solve, validateConfig } from '../core/model';
import { capture } from './capture';
import { visionProbe } from './vision-probe';
import { Yuketang } from './platform';
import type { AppState, Command, ModelConfig, Lesson } from '../shared/types';

const test = !app.isPackaged && process.env.RAIN_E2E === '1';
const profile = app.commandLine.getSwitchValue('user-data-dir');
if (profile) app.setPath('userData', path.resolve(profile));
if (test && process.env.RAIN_TEST_DATA) app.setPath('userData', process.env.RAIN_TEST_DATA);
const origin = test ? process.env.RAIN_TEST_ORIGIN! : 'https://www.yuketang.cn';
if (test && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Test origin must be loopback');
if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(initialize).catch(() => { dialog.showErrorBox('无法启动', '本地配置或提交记录无法读取。请保留应用数据并核对官方提交记录。'); app.quit(); });

async function initialize() {
  const dataPath = app.getPath('userData'); mkdirSync(dataPath, { recursive: true });
  const settingsFile = path.join(dataPath, 'settings.json');
  const startupWarnings: string[] = [];
  let config: ModelConfig = { baseUrl: '', model: '', apiKey: '' }, testedFingerprint = '';
  const fingerprint = () => createHash('sha256').update(JSON.stringify(config)).digest('hex');
  if (existsSync(settingsFile)) {
    try {
      const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
      config.baseUrl = typeof saved.baseUrl === 'string' ? saved.baseUrl : '';
      config.model = typeof saved.model === 'string' ? saved.model : '';
      config.apiKey = (await safeStorage.decryptStringAsync(Buffer.from(saved.key, 'base64'))).result;
      testedFingerprint = saved.tested ?? '';
    } catch { startupWarnings.push('已保存的模型密钥暂时无法读取；地址和模型名称已保留，请重启重试或重新输入密钥'); }
  }
  const persistSettings = async () => { const key = (await safeStorage.encryptStringAsync(config.apiKey)).toString('base64'); writeFileSync(`${settingsFile}.tmp`, JSON.stringify({ baseUrl: config.baseUrl, model: config.model, key, tested: testedFingerprint }), { mode: 0o600 }); renameSync(`${settingsFile}.tmp`, settingsFile); };
  const platformSession = session.fromPartition('persist:rain-platform');
  const sessionFile = path.join(dataPath, 'platform-session.json');
  // Chromium 不跨应用重启保留 session-only cookies；仅在用户核验登录后加密保存，
  // 恢复时保留原过期时间，并由服务端身份核验决定是否仍然有效。
  if (existsSync(sessionFile)) {
    try {
    const snapshot = JSON.parse((await safeStorage.decryptStringAsync(readFileSync(sessionFile))).result);
    for (const cookie of snapshot) {
      const host = String(cookie.domain).replace(/^\./, '');
      if (host !== new URL(origin).hostname || (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000)) continue;
      await platformSession.cookies.set({ url: `${new URL(origin).protocol}//${new URL(origin).host}${cookie.path}`, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, ...(cookie.hostOnly ? {} : { domain: cookie.domain }), ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}) });
    }
    } catch { startupWarnings.push('雨课堂登录会话未能恢复，请重新核验登录；模型配置已独立保留'); }
  }
  const saveSession = async () => {
    const cookies = await platformSession.cookies.get({ url: origin });
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(cookies));
    writeFileSync(`${sessionFile}.tmp`, encrypted, { mode: 0o600 }); renameSync(`${sessionFile}.tmp`, sessionFile);
    await platformSession.cookies.flushStore();
  };
  platformSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  platformSession.setPermissionCheckHandler(() => false);
  const platform = new Yuketang(platformSession, origin, test ? origin.replace('http:', 'ws:') + '/wsapp/' : undefined);
  const ledger = new Ledger(path.join(dataPath, 'ledger.json'));
  const state: AppState = { identity: null, lessons: [], selected: null, mode: 'stopped', connection: '未连接课堂', question: null, proposal: null, records: ledger.list(), model: { baseUrl: config.baseUrl, model: config.model, hasKey: !!config.apiKey, tested: !!config.apiKey && testedFingerprint === fingerprint() }, notice: '先登录雨课堂，选择正在上课的课堂。' };
  if (startupWarnings.length) state.notice = startupWarnings.join('；');
  const main = new BrowserWindow({ width: 1320, height: 880, minWidth: 1030, minHeight: 720, title: '雨课堂 AI · 课堂工作台', backgroundColor: '#f3f2ed', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  main.setMenu(null);
  const appUrl = new URL(`file://${path.join(__dirname, 'renderer/index.html').replace(/\\/g, '/')}`).href;
  const emit = () => { state.records = ledger.list(); if (!main.isDestroyed()) main.webContents.send('rain:state', state); };
  let platformWindow: BrowserWindow | null = null, platformView: WebContentsView | null = null;
  let joining: Lesson | null = null;
  const notice = (text: string) => { state.notice = text; emit(); };
  const engine = new AnswerEngine({ ledger,
    capture: (q, signal) => capture(q, platformView?.webContents ?? null, platformSession, origin, signal, current => platform.fresh(current)),
    solve: (q, signal) => solve(config, q, signal),
    fresh: q => platform.fresh(q), submit: (q, a, signal) => platform.submit(q, a, signal),
    changed(q, a, r) { state.question = q; state.proposal = a; state.notice = r.message; emit(); },
    error(message) { state.mode = 'paused'; notice(message); }
  });
  platform.onQuestion = q => { state.question = q; emit(); engine.offer(q); };
  platform.onCloseQuestion = qid => engine.invalidate(qid);
  platform.onConnection = s => { state.connection = s; emit(); };
  platform.onEnd = () => { engine.stop(); state.mode = 'stopped'; state.question = null; notice('本次课堂已结束'); };
  platformSession.cookies.on('changed', (_event, cookie) => {
    if (cookie.name === 'sessionid' && state.identity) {
      rmSync(sessionFile, { force: true });
      engine.stop(); platform.disconnect(); joining = null; state.mode = 'paused'; state.identity = null; state.selected = null; state.lessons = [];
      notice('登录会话已变化，已暂停；请重新核验登录');
    }
  });

  function allowedNavigation(url: string) { try { const u = new URL(url); return u.origin === origin || u.origin === 'https://open.weixin.qq.com'; } catch { return false; } }
  async function loadPlatformPage(view: WebContentsView, url: string) {
    const contents = view.webContents, target = new URL(url);
    const lessonPath = /^\/lesson\/fullscreen\/v3\/[^/]+$/.test(target.pathname) ? target.pathname : null;
    const matchesTarget = () => {
      try {
        const current = new URL(contents.getURL());
        return lessonPath ? current.origin === target.origin && (current.pathname === lessonPath || current.pathname.startsWith(`${lessonPath}/`)) : allowedNavigation(current.href);
      } catch { return false; }
    };
    let finish: () => void, fail: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    // 页面自行跳转可能先取消 loadURL，再完成新的主框架加载。
    void completed.catch(() => {});
    const onFinish = () => { if (matchesTarget()) finish(); else fail(new Error('官方页面未进入所选课堂，请重新核验登录并选择课堂')); };
    const onFail = (_event: unknown, code: number, description: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame && code !== -3) fail(new Error(/^ERR_[A-Z_]+$/.test(description) ? description : '官方页面加载失败，请检查网络后重试'));
    };
    const onDestroyed = () => fail(new Error('官方页面已关闭，请重新打开后进入课堂'));
    const timer = setTimeout(() => fail(new Error('官方页面加载超时，请检查网络后重新进入课堂')), 20000);
    contents.on('did-finish-load', onFinish);
    contents.on('did-fail-load', onFail);
    contents.on('destroyed', onDestroyed);
    try {
      const loaded = contents.loadURL(url).catch(error => {
        const e = error as Error & { code?: string; errno?: number };
        if (e.errno !== -3 && e.code !== 'ERR_ABORTED' && !/\bERR_ABORTED\b/.test(e.message ?? '')) throw error;
        return completed;
      });
      await Promise.race([loaded, completed]);
      if (!matchesTarget()) throw new Error('官方页面未进入所选课堂，请重新核验登录并选择课堂');
    } catch (error) {
      if (!contents.isDestroyed()) contents.stop();
      throw error;
    } finally {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onFinish);
      contents.removeListener('did-fail-load', onFail);
      contents.removeListener('destroyed', onDestroyed);
    }
  }
  async function showPlatform(url?: string) {
    if (!platformWindow || platformWindow.isDestroyed()) {
      platformWindow = new BrowserWindow({ width: 1160, height: 850, minWidth: 640, minHeight: 500, title: '雨课堂官方页面 · 完成后返回工作台', autoHideMenuBar: true, backgroundColor: '#ffffff' });
      platformWindow.setMenu(null);
      const view = new WebContentsView({ webPreferences: { session: platformSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      platformView = view; platformWindow.contentView.addChildView(view);
      const resize = () => { if (platformWindow && !platformWindow.isDestroyed()) { const [width, height] = platformWindow.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); } };
      platformWindow.on('resize', resize); resize();
      platformWindow.on('close', e => { e.preventDefault(); platformWindow?.hide(); main.show(); });
      view.webContents.on('will-navigate', (e, next) => { if (!allowedNavigation(next)) e.preventDefault(); });
      view.webContents.on('will-redirect', (e, next) => { if (!allowedNavigation(next)) e.preventDefault(); });
      view.webContents.setWindowOpenHandler(({ url }) => { if (allowedNavigation(url)) void loadPlatformPage(view, url).catch(() => notice('官方页面跳转失败，请检查网络后重试')); return { action: 'deny' }; });
      view.webContents.on('did-fail-load', (_e, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) notice('官方页面加载失败，请检查网络后重试'); });
      await view.webContents.loadURL('about:blank');
      view.webContents.debugger.attach('1.3');
      const responses = new Map<string, string>();
      view.webContents.debugger.on('message', async (_event, method, p) => {
        try {
          if (method === 'Network.responseReceived' && p.response.url === `${origin}/api/v3/lesson/checkin`) {
            const entry = Object.entries(p.response.headers as Record<string, string>).find(([key]) => key.toLowerCase() === 'set-auth');
            responses.set(p.requestId, entry?.[1] ?? '');
          }
          if (method === 'Network.loadingFailed') responses.delete(p.requestId);
          if (method === 'Network.loadingFinished' && responses.has(p.requestId)) {
            const bearer = responses.get(p.requestId)!; responses.delete(p.requestId);
            const target = joining;
            if (!target) return;
            const response = await view.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: p.requestId });
            if (joining !== target) return;
            await platform.attachLesson(target, response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body, bearer);
            if (joining !== target) { platform.disconnect(); return; }
            joining = null; state.selected = target; notice('课堂会话已连接，可以选择仅预览或自动提交');
          }
        } catch { notice('课堂会话未能核验，请在官方页面完成验证，然后重新选择课堂'); }
      });
      await view.webContents.debugger.sendCommand('Network.enable');
      await view.webContents.debugger.sendCommand('Page.enable');
    }
    platformWindow.show();
    if (url) await loadPlatformPage(platformView!, url);
  }

  let commandBusy = false;
  ipcMain.handle('rain:command', async (event, command: Command) => {
    if (event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame || !event.senderFrame.url.startsWith(appUrl)) throw new Error('Untrusted IPC sender');
    if (!command || typeof command.type !== 'string') throw new Error('Invalid command');
    if (command.type === 'state') return state;
    // 暂停/停止不排在登录、模型请求后面，点击后立即生效。
    if (command.type === 'pause' || command.type === 'stop') {
      if (command.type === 'pause') { engine.pause(); state.mode = 'paused'; }
      else { engine.stop(); state.mode = 'stopped'; }
      notice(command.type === 'pause' ? '已暂停；在途提交仍会记录回执' : '已停止自动答题'); return state;
    }
    if (commandBusy) { notice('上一项操作仍在进行'); return state; }
    commandBusy = true;
    try {
      switch (command.type) {
        case 'login': await showPlatform(platformView ? undefined : `${origin}/v2/web/index`); break;
        case 'hidePlatform': platformWindow?.hide(); main.show(); break;
        case 'refresh': {
          const oldId = state.identity?.id;
          const lessons = await platform.refresh();
          if (oldId && oldId !== platform.identity?.id) { engine.stop(); platform.disconnect(); state.selected = null; state.mode = 'stopped'; }
          state.identity = platform.identity; state.lessons = lessons; await saveSession(); notice(lessons.length ? '选择一个正在上课的课堂' : '登录已核验，目前没有正在上课的课堂'); break;
        }
        case 'select': {
          if (engine.isBusy()) throw new Error('请先暂停并等待在途任务结束');
          const lesson = state.lessons.find(l => l.id === command.lessonId); if (!lesson || !state.identity) throw new Error('请刷新并选择有效课堂');
          if (state.selected?.id === lesson.id && platform.lesson?.id === lesson.id) { await showPlatform(); notice('当前课堂已选中，可以开始答题'); break; }
          engine.stop(); platform.disconnect(); state.mode = 'stopped'; state.selected = null; state.question = null; state.proposal = null; joining = lesson;
          notice('正在打开官方课堂；进入课堂可能同时完成平台签到');
          await showPlatform(`${origin}/lesson/fullscreen/v3/${encodeURIComponent(lesson.id)}?source=5`); break;
        }
        case 'logout': {
          if (engine.isBusy()) throw new Error('请暂停并等待在途任务结束后退出账号');
          engine.stop(); platform.disconnect(); joining = null; state.mode = 'stopped';
          state.identity = null;
          if (platformView) { platformView.webContents.close(); platformView = null; }
          platformWindow?.destroy(); platformWindow = null;
          await platformSession.clearStorageData(); await platformSession.clearCache(); await platformSession.cookies.flushStore();
          rmSync(sessionFile, { force: true });
          platform.identity = null; state.identity = null; state.lessons = []; state.selected = null; state.question = null; state.proposal = null; state.connection = '未连接课堂'; notice('账号已退出，平台会话已清除'); break;
        }
        case 'saveModel': {
          if (engine.isBusy() || state.mode === 'auto' || state.mode === 'preview') throw new Error('请先停止答题并等待当前任务结束，再修改模型');
          const next = command.config;
          if (!next || typeof next.baseUrl !== 'string' || typeof next.model !== 'string' || typeof next.apiKey !== 'string') throw new Error('模型配置格式不正确');
          config = validateConfig({ ...next, apiKey: next.apiKey || config.apiKey }); testedFingerprint = ''; await persistSettings();
          state.model = { baseUrl: config.baseUrl, model: config.model, hasKey: true, tested: false }; notice('模型已保存，接下来验证图片识别能力'); break;
        }
        case 'testModel': {
          if (engine.isBusy()) throw new Error('请等待当前题目处理结束');
          state.model.tested = false; testedFingerprint = ''; await persistSettings();
          notice('正在发送两张随机测试图片，验证视觉能力…');
          for (let i = 0; i < 2; i++) { const probe = visionProbe(); const answer = await solve(config, probe.question, new AbortController().signal); if (JSON.stringify(answer.answers) !== JSON.stringify(probe.expected)) throw new Error('图片测试未通过，请检查模型是否支持视觉输入'); }
          testedFingerprint = fingerprint(); await persistSettings(); state.model.tested = true; notice('图片识别测试通过，可以启动课堂答题'); break;
        }
        case 'start': {
          if (!['preview', 'auto'].includes(command.mode)) throw new Error('运行模式无效');
          if (!state.selected || !platform.lesson) throw new Error('请先选择并进入课堂');
          if (!state.model.tested || testedFingerprint !== fingerprint()) throw new Error('请先通过模型图片测试');
          if (engine.isBusy()) throw new Error('上一项任务仍在结束，请稍后开始');
          engine.start(command.mode); state.mode = command.mode; notice(command.mode === 'auto' ? '自动答题已启动，合格答案将自动提交' : '仅预览已启动，答案不会提交');
          await platform.resync(); break;
        }
        default: throw new Error('不支持的操作');
      }
    } catch (error) {
      if (command.type === 'select') joining = null;
      const message = error instanceof Error ? error.message : '';
      const operation = ({login:'打开官方页面',refresh:'刷新课堂',select:'进入课堂',start:'启动答题',saveModel:'保存模型配置',testModel:'验证图片识别'} as Record<string,string>)[command.type] ?? '操作';
      const networkCode = message.match(/ERR_[A-Z_]+/)?.[0];
      notice(/[\u4e00-\u9fff]/.test(message) ? message.slice(0, 240) : `${operation}失败${networkCode ? `（${networkCode}）` : ''}，请重新打开官方页面或重启 APP；已保存的配置仍保留`);
    } finally { commandBusy = false; emit(); }
    return state;
  });
  main.webContents.on('will-navigate', e => e.preventDefault());
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.on('close', () => { engine.stop(); platform.disconnect(); platformView?.webContents.close(); platformWindow?.destroy(); });
  app.on('before-quit', () => { engine.stop(); platform.disconnect(); });
  app.on('second-instance', () => { main.show(); main.focus(); });
  await main.loadFile(path.join(__dirname, 'renderer/index.html'));
}
app.on('window-all-closed', () => app.quit());
