import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, Command, DesktopApi, TaskRecord } from '../shared/types';
import './style.css';
declare global { interface Window { rain: DesktopApi } }
const statusName: Record<string, string> = { QUEUED: '待处理', CAPTURING: '获取题图', SOLVING: '模型分析', PREVIEW: '答案预览', SUBMITTING: '提交中', ACCEPTED: '平台已接受', REJECTED: '平台拒绝', UNKNOWN: '结果未知', SKIPPED: '已跳过' };
const kindName = { single: '单选题', multiple: '多选题', blank: '填空题' };
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    board: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12"/></>,
    list: <><path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1"/></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6"/>,
    play: <path d="m8 4 12 8-12 8Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    refresh: <><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 17 6-6 4 4 3-3 5 5"/><circle cx="16" cy="7" r="1"/></>
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.board}</svg>;
}
function Records({ records }: { records: TaskRecord[] }) {
  return records.length ? <div className="record-table"><div className="table-head"><span>题目</span><span>状态</span><span>答案 / 说明</span><span>时间</span></div>{records.slice(0, 100).map(r => <div className="table-row" key={r.key}><div><strong>{kindName[r.kind]}</strong><small>#{r.questionId}</small></div><span><b className={`tag ${r.status.toLowerCase()}`}>{statusName[r.status]}</b></span><div className="record-detail">{r.answers && <strong>{r.answers.join(' · ')}</strong>}<small>{r.message}</small>{['ACCEPTED','UNKNOWN'].includes(r.status) && <small>判题结果：尚未获取，以官方页面为准</small>}</div><time>{new Date(r.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></div>)}</div> : <div className="empty-record"><Icon name="list"/><span>课堂开始后，处理记录会显示在这里。</span></div>;
}
function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<'board' | 'records' | 'model'>('board');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [apiKey, setApiKey] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const unsubscribe = window.rain.subscribe(setState); window.rain.command({ type: 'state' }).then(setState).catch(() => setError('工作台连接失败，请重新打开应用')); const timer = setInterval(() => setNow(Date.now()), 1000); return () => { unsubscribe(); clearInterval(timer); }; }, []);
  useEffect(() => { if (state) { setBaseUrl(state.model.baseUrl); setModel(state.model.model); } }, [state?.model.baseUrl, state?.model.model]);
  const act = async (command: Command) => {
    const immediate = command.type === 'pause' || command.type === 'stop';
    if (!immediate) setBusy(true); setError('');
    try { setState(await window.rain.command(command)); } catch { setError('操作未完成，请重试'); } finally { if (!immediate) setBusy(false); }
  };
  if (!state) return <div className="loading">{error || '正在打开课堂工作台…'}</div>;
  const q = state.question;
  const running = state.mode === 'auto' || state.mode === 'preview';
  const remaining = q?.deadline ? Math.max(0, Math.ceil((q.deadline - now) / 1000)) : null;
  const accepted = state.records.filter(r => r.status === 'ACCEPTED').length;
  const waiting = state.records.filter(r => r.status === 'UNKNOWN').length;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="rain-mark"><i/><i/><i/></div><div>雨课堂 <span>AI</span><small>CLASSROOM DESKTOP</small></div></div>
      <div className="nav-caption">课堂助手</div><nav aria-label="主导航">{([{ id: 'board', icon: 'board', text: '课堂工作台' }, { id: 'records', icon: 'list', text: '处理记录' }, { id: 'model', icon: 'settings', text: '模型设置' }] as const).map(item => <button key={item.id} className={tab === item.id ? 'nav-item selected' : 'nav-item'} onClick={() => setTab(item.id)}><Icon name={item.icon}/>{item.text}{item.id === 'records' && state.records.length > 0 && <span className="nav-count">{state.records.length}</span>}</button>)}</nav>
      <div className="sidebar-note"><div className={`status-dot ${running ? 'live' : ''}`}/><strong>{state.mode === 'auto' ? '自动提交运行中' : state.mode === 'preview' ? '仅预览运行中' : state.mode === 'paused' ? '已暂停' : '等待开始'}</strong><p>{state.connection}</p></div>
      <div className="account"><div className="avatar">{state.identity?.name.slice(-1) || '人'}</div><div><strong>{state.identity?.name || '尚未登录'}</strong><small>普通雨课堂 · 单账号</small></div>{state.identity && <button className="text-button" disabled={busy} onClick={() => void act({ type: 'logout' })}>退出</button>}</div>
      <div className="version">实验版本 0.1.4 <span>本地运行</span></div>
    </aside>
    <main><header className="topbar"><span className="breadcrumb">我的课堂 <span>/</span> {tab === 'board' ? '工作台' : tab === 'records' ? '处理记录' : '模型设置'}</span><div className="topbar-actions"><span className={`connection ${state.identity ? 'connected' : ''}`}><i/>{state.identity ? '账号已核验' : '等待登录'}</span><button className="button small" disabled={busy} onClick={() => void act({ type: 'login' })}>打开官方页面 <Icon name="arrow"/></button></div></header>
      <div className="content"><div className="page-heading"><div><div className="eyebrow">{tab === 'model' ? 'MODEL CONNECTION' : tab === 'records' ? 'ACTIVITY LOG' : 'YOUR CLASSROOM, IN FOCUS'}</div><h1>{tab === 'model' ? '连接你的视觉模型' : tab === 'records' ? '每一次处理，有迹可查' : state.selected ? state.selected.name : '课堂工作台'}</h1><p>{tab === 'model' ? '使用自己的 API，将题目图片交给支持视觉输入的模型。' : tab === 'records' ? '提交回执与判题结果分别核对。未知结果不会自动重发。' : '自动获取题图、分析答案，并记录每一道题的处理结果。'}</p></div>{tab === 'board' && <span className="date-label">{new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>}</div>
      <div className={`notice ${error ? 'error' : ''}`} role="status" aria-live="polite"><span className="notice-symbol">{busy ? '◌' : 'i'}</span>{error || state.notice}</div>
      {tab === 'board' && <>
        <section className="session-panel"><div className="section-title"><div><span className="step-number">01</span><h2>连接课堂</h2></div><button className="text-button" disabled={busy || running} onClick={() => void act({ type: 'refresh' })}><Icon name="refresh"/>核验登录 / 刷新课堂</button></div><div className="session-fields"><div className="lesson-select"><label htmlFor="lesson">正在上课的课堂</label><select id="lesson" disabled={busy || running || !state.lessons.length} value={state.selected?.id ?? ''} onChange={e => e.target.value && void act({ type: 'select', lessonId: e.target.value })}><option value="">{state.lessons.length ? '选择课堂，进入官方页面' : '登录并刷新后显示课堂'}</option>{state.lessons.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div><div className="model-summary"><label>视觉模型</label><button onClick={() => setTab('model')}><span className={`model-light ${state.model.tested ? 'ready' : ''}`}/><strong>{state.model.model || '尚未配置'}</strong><span>{state.model.tested ? '已验证' : '前往设置'} ↗</span></button></div></div>
        <div className="run-bar"><span>单选 · 多选 · 填空<span className="run-sub">开始后持续监听当前课堂</span></span><div className="run-buttons"><button className="button" disabled={busy || running || !state.selected || !state.model.tested} onClick={() => void act({ type: 'start', mode: 'preview' })}>仅预览答案</button><button className="button primary" disabled={busy || running || !state.selected || !state.model.tested} onClick={() => void act({ type: 'start', mode: 'auto' })}><Icon name="play"/>开始自动提交</button><button className="button" disabled={!running && !busy} onClick={() => void act({ type: 'pause' })}>暂停</button><button className="text-button" disabled={state.mode === 'stopped'} onClick={() => void act({ type: 'stop' })}>停止</button></div></div></section>
        <div className="question-grid"><section className="question-panel"><div className="section-title"><div><span className="step-number">02</span><h2>本次题图</h2></div><span className="muted">{q?.captureSource === 'original' ? '平台原图' : q?.captureSource === 'screenshot' ? '官方页面截图' : '等待发题'}</span></div>{q ? <div className="question-content"><div className="question-meta"><span className="tag">{kindName[q.kind]}</span><span>题目 #{q.questionId}</span>{q.open && <b>{remaining === null ? '不限时' : `剩余 ${remaining}s`}</b>}</div>{q.images.map((image, i) => <img className="question-image" src={image} key={i} alt={`本次模型输入题图 ${i + 1}`}/>)}<p className="stem">{q.stem}</p>{q.options.map(o => <div className="option" key={o.key}><b>{o.key}</b><span>{o.text}</span></div>)}{q.kind === 'blank' && <div className="muted">共 {q.blankCount} 个空位，按顺序填写</div>}</div> : <div className="empty-question"><div className="paper-illustration"><span/><span/><span/><i>?</i></div><h3>等待老师发布题目</h3><p>进入课堂并开始后，题目图片会自动出现在这里。</p><div className="flow-label">获取题图 <span>→</span> 模型分析 <span>→</span> 提交回执</div></div>}</section>
        <section className="answer-panel"><div className="section-title"><div><span className="step-number">03</span><h2>模型答案</h2></div><Icon name="check"/></div>{state.proposal ? <div className="answer-content"><span className="eyebrow">ANSWER</span><div className={state.proposal.kind === 'blank' ? 'blank-answers' : 'choice-answer'}>{state.proposal.answers.map((a, i) => <span key={i}>{state.proposal!.kind === 'blank' && <small>第 {i + 1} 空</small>}{a}</span>)}</div><h4>分析说明</h4><p>{state.proposal.explanation || '模型未提供说明'}</p></div> : <div className="empty-answer"><div className="orbit">✦</div><h3>答案将在这里显示</h3><p>可先使用「仅预览答案」检查模型效果，再开启自动提交。</p></div>}<div className="answer-footnote">平台接受提交不代表答案正确，判题结果以官方页面为准。</div></section></div>
        <section className="records-panel"><div className="section-title"><div><h2>最近处理</h2><span className="muted">已接受 {accepted} · 待核对 {waiting}</span></div><button className="text-button" onClick={() => setTab('records')}>查看全部 <Icon name="arrow"/></button></div><Records records={state.records.slice(0, 5)}/></section>
      </>}
      {tab === 'records' && <section className="records-panel"><div className="section-title"><div><h2>本地处理记录</h2><span className="muted">共 {state.records.length} 条</span></div><span className="tag">仅保存在本机</span></div><Records records={state.records}/></section>}
      {tab === 'model' && <div className="settings-grid"><section className="settings-card"><div className="section-title"><div><span className="step-number">API</span><h2>模型连接</h2></div><span className={`tag ${state.model.tested ? 'accepted' : ''}`}>{state.model.tested ? '视觉测试通过' : '待验证'}</span></div><form onSubmit={e => { e.preventDefault(); void act({ type: 'saveModel', config: { baseUrl, model, apiKey } }).then(() => setApiKey('')); }}><label htmlFor="base-url">Base URL</label><input id="base-url" required value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://your-provider.example/v1" autoComplete="off"/><small>填写 API 根地址，程序会追加 /chat/completions。</small><label htmlFor="model-name">模型名称</label><input id="model-name" required value={model} onChange={e => setModel(e.target.value)} placeholder="输入支持图片的模型名" autoComplete="off"/><label htmlFor="api-key">API Key</label><input id="api-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={state.model.hasKey ? '密钥已保存；留空保留' : '仅在本机加密保存'} autoComplete="off" spellCheck={false}/><small>{state.model.hasKey ? 'API Key 已加密保存，重启后仍可使用；留空保留现有密钥。' : '输入密钥后点击保存配置。'}</small><div className="form-actions"><button className="button primary" type="submit" disabled={busy || running}>保存配置</button><button className="button" type="button" disabled={busy || running || !state.model.hasKey} onClick={() => void act({ type: 'testModel' })}>验证图片识别</button></div></form></section><aside className="settings-explainer"><span className="eyebrow">BEFORE YOU START</span><h2>一次设置，<br/>用于每道课堂题。</h2><ol><li><b>使用视觉模型</b><p>接口须支持图片输入；仅支持文字的模型不能直接分析题图。</p></li><li><b>先验证，再开始</b><p>测试会发送两张随机色块图片，产生少量 API 用量。</p></li><li><b>独立保存凭据</b><p>模型仅收到题图和必要文本，不会收到雨课堂 Cookie 或登录会话。</p></li></ol><p className="muted">需要联网访问雨课堂与所配置的模型服务。</p></aside></div>}
      <footer>RAINCLASSROOM AI <span>专注当前课堂 · 由你掌控开始与停止</span></footer></div>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
