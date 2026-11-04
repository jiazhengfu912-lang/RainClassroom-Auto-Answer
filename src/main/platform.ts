import WebSocket from 'ws';
import type { Session } from 'electron';
import { decode, id, normalize, deadlineFromInfo, receipt, SubmissionNotSentError } from '../core/protocol';
import type { Identity, Lesson, QuestionContext, AnswerProposal } from '../shared/types';
import { submitOnce } from './submit-once';

export class Yuketang {
  identity: Identity | null = null;
  lesson: Lesson | null = null;
  private auth = '';
  private lessonToken = '';
  private ws?: WebSocket;
  private alive = false;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private generation = 0;
  private questions = new Map<string, QuestionContext>();
  private loadedPresentations = new Set<string>();
  private closed = new Set<string>();
  private discovering = new Set<string>();
  private awaitingPresentation = new Set<string>();
  private pending = new Map<string, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onQuestion: (q: QuestionContext) => void = () => {};
  onCloseQuestion: (id: string) => void = () => {};
  onConnection: (s: string) => void = () => {};
  onEnd: () => void = () => {};
  constructor(private session: Session, readonly origin = 'https://www.yuketang.cn', private wsUrl = 'wss://www.yuketang.cn/wsapp/') {}
  private async request(path: string, body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Referer: `${this.origin}/` };
    if (this.auth) headers.Authorization = `Bearer ${this.auth}`;
    const cookies = await this.session.cookies.get({ url: this.origin });
    const csrf = cookies.find(c => c.name === 'csrftoken');
    if (csrf) headers['X-CSRFToken'] = csrf.value;
    const r = await this.session.fetch(`${this.origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(12000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? '雨课堂登录已失效，请重新登录' : r.status === 429 ? '雨课堂请求过于频繁，请稍后重新开始（HTTP 429）' : `雨课堂 HTTP ${r.status}`);
    const raw = await r.text();
    if (raw.length > 16000000) throw new Error('平台响应过大');
    return decode(raw);
  }
  async refresh() {
    const user = await this.request('/api/v3/user/basic-info');
    if (String(user.code) !== '0' || !user.data?.name) { this.identity = null; throw new Error('请在官方页面完成登录后再刷新'); }
    this.identity = { id: id(user.data.id), name: String(user.data.name) };
    const r = await this.request('/api/v3/classroom/on-lesson');
    if (String(r.code) !== '0' || !Array.isArray(r.data?.onLessonClassrooms)) throw new Error('当前课堂列表协议不匹配');
    return r.data.onLessonClassrooms.filter((x: any) => ![1, 2].includes(Number(x.role))).map((x: any): Lesson => ({ id: id(x.lessonId), classroomId: id(x.classroomId), name: String(x.courseName ?? '当前课堂') }));
  }
  // 只接收用户选定官方课堂页面实际发出的 checkin 回执，不再次提交签到。
  async attachLesson(lesson: Lesson, body: string, bearer: string) {
    const r = decode(body), d = r?.data;
    if (String(r.code) !== '0' || !d || id(d.lessonId) !== lesson.id || !/^[0-9]+$/.test(String(d.role)) || [1, 2].includes(Number(d.role)) || d.isGuest === true || d.guest === true || !d.lessonToken || !bearer || !this.identity) throw new Error('未取得有效学生课堂会话，请在官方页面完成进入课堂');
    this.disconnect(); this.lesson = lesson; this.auth = bearer; this.lessonToken = String(d.lessonToken); this.alive = true;
    await this.connect();
  }
  private async connect() {
    if (!this.alive || !this.lesson || !this.identity) return;
    const generation = this.generation;
    const cookies = await this.session.cookies.get({ url: this.origin });
    if (!this.alive || generation !== this.generation) return;
    this.onConnection('正在连接课堂');
    const ws = new WebSocket(this.wsUrl, { headers: { Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), Origin: this.origin, Authorization: `Bearer ${this.auth}` }, handshakeTimeout: 10000, maxPayload: 16000000 });
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'hello', userid: this.identity!.id, role: 'student', auth: this.lessonToken, lessonid: this.lesson!.id }));
      let pong = true;
      ws.on('pong', () => { pong = true; });
      this.heartbeat = setInterval(() => { if (!pong) ws.terminate(); else { pong = false; ws.ping(); } }, 20000);
    });
    ws.on('message', data => {
      if (ws !== this.ws) return;
      try { this.message(decode(data.toString())); } catch { this.onConnection('课堂消息格式已变化，请检查官方页面'); }
    });
    ws.on('error', () => this.onConnection('课堂连接异常，等待重连'));
    ws.on('close', () => {
      if (ws !== this.ws) return;
      this.clearPending();
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const q of this.questions.values()) { q.open = false; this.onCloseQuestion(q.questionId); }
      if (this.alive) { this.onConnection('连接断开，3 秒后重连'); this.timer = setTimeout(() => void this.connect().catch(() => this.onConnection('重连失败，请重新进入课堂')), 3000); }
    });
  }
  private message(d: any) {
    const op = d.op;
    if (op === 'probleminfo') {
      const key = id(d.problemid ?? d.problemId);
      const p = this.pending.get(key);
      if (p) { clearTimeout(p.timer); this.pending.delete(key); p.resolve(d); }
      return;
    }
    if (op === 'hello' || op === 'fetchtimeline') {
      if (op === 'hello') this.closed.clear();
      this.onConnection('课堂已连接');
      const timeline = Array.isArray(d.timeline) ? d.timeline : [];
      const pres = [...new Set<string>([...(timeline.filter((s: any) => (s.type === 'slide' || s.type === 'problem') && s.pres).map((s: any) => id(s.pres))), ...(d.presentation ? [id(d.presentation)] : [])])];
      const generation = this.generation;
      void (async () => {
        for (const p of pres) if (!this.loadedPresentations.has(p)) await this.loadPresentation(p);
        if (generation !== this.generation) return;
        for (const item of timeline) if (item.type === 'problem') this.awaitingPresentation.add(id(item.prob));
        for (const q of d.unlockedproblem ?? []) this.awaitingPresentation.add(id(typeof q === 'object' ? q.sid ?? q.problemId : q));
        for (const qid of [...this.awaitingPresentation]) await this.discover(qid);
      })().catch(() => this.onConnection('题目同步失败，请暂停后重新进入课堂'));
    } else if (op === 'unlockproblem') {
      const qid = id(d.problem?.sid ?? d.problemid);
      this.closed.delete(qid);
      this.awaitingPresentation.add(qid);
      void this.discover(qid).catch(() => this.onConnection('新题获取失败，请查看官方页面'));
    } else if (['lockproblem', 'problemclosed', 'problemlocked', 'problemended'].includes(op)) {
      const qid = id(d.problem?.sid ?? d.problemid ?? d.problemId);
      this.closed.add(qid); const q = this.questions.get(qid); if (q) q.open = false; this.onCloseQuestion(qid);
    } else if (['presentationupdated', 'presentationcreated'].includes(op)) {
      void this.loadPresentation(id(d.presentation)).then(async () => { for (const qid of [...this.awaitingPresentation]) await this.discover(qid); }).catch(() => this.onConnection('题图刷新失败'));
    } else if (op === 'lessonfinished') { this.disconnect(); this.onConnection('课堂已结束'); this.onEnd(); }
  }
  private async loadPresentation(presentationId: string) {
    const lesson = this.lesson, identity = this.identity, generation = this.generation;
    if (!lesson || !identity) throw new Error('尚未进入课堂');
    const r = await this.request(`/api/v3/lesson/presentation/fetch?presentation_id=${encodeURIComponent(presentationId)}`);
    if (generation !== this.generation) return;
    if (String(r.code) !== '0' || !Array.isArray(r.data?.slides)) throw new Error('课件结构不支持');
    this.loadedPresentations.add(presentationId);
    for (const slide of r.data.slides) {
      if (!slide.problem) continue;
      try {
        const q = normalize(slide.problem, slide, identity.id, lesson.id, presentationId);
        const old = this.questions.get(q.questionId);
        if (old && old.revision !== q.revision) this.onCloseQuestion(q.questionId);
        this.questions.set(q.questionId, { ...q, open: old?.open ?? false, deadline: old?.deadline ?? 0 });
      } catch { /* 未支持或结构不完整的题目不进入自动答题队列。 */ }
    }
  }
  private info(questionId: string): Promise<any> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('课堂连接不可用'));
    if (this.pending.has(questionId)) return Promise.reject(new Error('题目状态正在核验'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(questionId); reject(new Error('题目状态核验超时')); }, 5000);
      this.pending.set(questionId, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ op: 'probleminfo', lessonid: this.lesson!.id, problemid: questionId, msgid: Date.now() }));
    });
  }
  private async discover(questionId: string) {
    if (this.discovering.has(questionId)) return;
    const q = this.questions.get(questionId);
    if (!q) { this.onConnection('本题尚无完整题目结构，自动答题已跳过'); return; }
    this.discovering.add(questionId);
    try {
      const generation = this.generation;
      const info = await this.info(questionId);
      if (generation !== this.generation) return;
      const deadline = deadlineFromInfo(info);
      const open = !this.closed.has(questionId) && info.locked !== true && info.closed !== true && (deadline === null || deadline > Date.now());
      const current = { ...q, deadline, open };
      this.questions.set(questionId, current);
      this.awaitingPresentation.delete(questionId); this.onQuestion(current);
    }
    finally { this.discovering.delete(questionId); }
  }
  async resync() {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('课堂尚未连接，请等待连接成功后再开始');
    // 当前官方 hello 不一定包含 unlockedproblem；重启监听时重新请求已发布题目时间线。
    this.ws.send(JSON.stringify({op:'fetchtimeline',lessonid:this.lesson!.id,msgid:Date.now()}));
  }
  async fresh(q: QuestionContext) {
    const generation = this.generation;
    const user = await this.request('/api/v3/user/basic-info');
    if (String(user.code) !== '0' || id(user.data?.id) !== q.accountId) throw new Error('账号会话已变化，请重新核验登录');
    await this.loadPresentation(q.presentationId);
    const info = await this.info(q.questionId);
    if (generation !== this.generation || q.lessonId !== this.lesson?.id) throw new Error('课堂已切换');
    const current = this.questions.get(q.questionId);
    if (!current) throw new Error('题目已移除');
    const deadline = deadlineFromInfo(info);
    const open = !this.closed.has(q.questionId) && info.locked !== true && info.closed !== true && (deadline === null || deadline > Date.now());
    const fresh = { ...current, deadline, open };
    this.questions.set(q.questionId, fresh);
    return fresh;
  }
  async submit(q: QuestionContext, a: AnswerProposal, signal: AbortSignal) {
    const cookies = await this.session.cookies.get({ url: this.origin });
    // Cookie 读取会让出事件循环；暂停/收题必须能阻止此时尚未发送的请求。
    // 真正发送后不再用 signal 中断 HTTP，保留实际回执。
    if (signal.aborted || !this.alive || this.lesson?.id !== q.lessonId || this.identity?.id !== q.accountId || this.closed.has(q.questionId) || (q.deadline !== null && q.deadline - Date.now() <= 3000)) throw new SubmissionNotSentError('已暂停、收题或提交目标失效，本题未发送');
    const headers: Record<string,string> = { Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), Authorization: `Bearer ${this.auth}`, Referer: `${this.origin}/`, Origin: this.origin };
    const csrf = cookies.find(c => c.name === 'csrftoken'); if (csrf) headers['X-CSRFToken'] = csrf.value;
    // 官方主观题页面发送毫秒时间及文字/图片对象；纯文字作答使用空图片字段。
    const subjective = q.kind === 'subjective';
    const result = subjective ? { content: a.answers[0], pics: [{ pic: '', thumb: '' }] } : a.answers;
    const dt = subjective ? Date.now() : Math.floor(Date.now() / 1000);
    return receipt(decode(await submitOnce(`${this.origin}/api/v3/lesson/problem/answer`, headers, { problemId: q.questionId, problemType: q.platformType, dt, result })));
  }
  private clearPending() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('课堂已断开')); } this.pending.clear(); }
  disconnect() { this.alive = false; this.generation++; if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat); const old = this.ws; this.ws = undefined; old?.close(); this.clearPending(); this.questions.clear(); this.loadedPresentations.clear(); this.closed.clear(); this.awaitingPresentation.clear(); this.auth = ''; this.lessonToken = ''; this.lesson = null; }
}
