import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, id, normalize, parseAnswer, deadlineFromInfo, receipt, questionKey } from '../src/core/protocol';
import { Ledger } from '../src/core/ledger';
import { AnswerEngine, type EnginePorts } from '../src/core/engine';
import { validateConfig, solve } from '../src/core/model';
import type { QuestionContext, TaskRecord } from '../src/shared/types';
import { Yuketang } from '../src/main/platform';

function question(): QuestionContext { return { accountId: '1', lessonId: '1234567890123456789', questionId: '9876543210123456789', presentationId: '7', kind: 'single', platformType: 1, stem: '测试题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], blankCount: 0, imageUrls: [], images: ['data:image/png;base64,AA=='], revision: '1', deadline: Date.now() + 60000, open: true, answered: false }; }
async function settled(e: AnswerEngine) { for (let i = 0; i < 100 && e.isBusy(); i++) await new Promise(r => setTimeout(r, 2)); expect(e.isBusy()).toBe(false); }
function rig(overrides: Partial<EnginePorts> = {}) {
  const q = question(), records = new Map<string, TaskRecord>();
  const ports: EnginePorts = {
    ledger: { blocks: k => ['ACCEPTED', 'SUBMITTING', 'UNKNOWN', 'REJECTED'].includes(records.get(k)?.status ?? ''), put: r => { records.set(r.key, r); } },
    capture: async q => q, solve: async () => ({ kind: 'single', answers: ['A'], explanation: '' }), fresh: async () => q,
    submit: vi.fn(async () => ({ status: 'ACCEPTED' as const, message: 'ok' })), changed: vi.fn(), error: vi.fn(), ...overrides
  };
  const e = new AnswerEngine(ports); e.start('auto'); return { q, records, ports, e };
}
describe('protocol and identifiers', () => {
  it.each(['rain-pri-ups.yuketang.cn','rain-pri-ups-ali.yuketang.cn'])('keeps the question revision stable when a %s image signature rotates',host=>{
    const raw={problemId:'7',problemType:1,body:'fixture',version:4,options:[{key:'A',value:'a'},{key:'B',value:'b'}]};
    const a=normalize(raw,{cover:`https://${host}/fixture.png?auth_key=old`},'1','2','3');
    const b=normalize(raw,{cover:`https://${host}/fixture.png?auth_key=new`},'1','2','3');
    expect(a.revision).toBe(b.revision);expect(a.imageUrls).not.toEqual(b.imageUrls);
  });
  it('still detects image transformations, paths and server question-version changes',()=>{
    const raw={problemId:'7',problemType:1,body:'fixture',version:4,options:[{key:'A',value:'a'},{key:'B',value:'b'}]};
    const cover='https://rain-pri-ups.yuketang.cn/fixture.png?auth_key=old';
    const a=normalize(raw,{cover},'1','2','3');
    expect(normalize({...raw,version:5},{cover},'1','2','3').revision).not.toBe(a.revision);
    expect(normalize(raw,{cover:cover.replace('fixture.png','changed.png')},'1','2','3').revision).not.toBe(a.revision);
    expect(normalize(raw,{cover:cover+'&transform=crop'},'1','2','3').revision).not.toBe(a.revision);
  });
  it('preserves 64-bit IDs without number rounding', () => { const raw = decode('{"id":9876543210123456789,"code":0}'); expect(raw.id).toBe('9876543210123456789'); expect(id(raw.id)).toBe(raw.id); expect(() => id(9876543210123456789)).toThrow(); });
  it.each([['1','single'], ['2','multiple'], ['4','blank']])('uses official classroom type %s = %s', (type, kind) => { const q = normalize({ problemId: '8', problemType: type, body: '<p>题干</p>', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }], blanks: [{}, {}], result: null }, { cover: 'https://www.yuketang.cn/image' }, '1','2','3'); expect(q.kind).toBe(kind); expect(q.stem).toBe('题干'); });
  it.each([0,3,6,9])('rejects unsupported type %d', type => { expect(() => normalize({ problemType: type }, {}, '1','2','3')).toThrow(); });
  it('recognizes an image-only subjective question without options or blanks', () => {
    const cover = 'https://www.yuketang.cn/translation.png';
    const q = normalize({ problemId: '8', problemType: '5', body: '', result: null }, { cover }, '1','2','3');
    expect(q).toMatchObject({ kind: 'subjective', imageUrls: [cover], options: [], blankCount: 0, answered: false });
    expect(normalize({ problemId: '8', problemType: 5, result: { content: '已提交', pics: [] } }, { cover }, '1','2','3').answered).toBe(true);
  });
  it('requires explicit blanks', () => expect(() => normalize({ problemType: 4, body: '____', problemId: '7' }, {},'1','2','3')).toThrow('填空数量'));
  it('detects revision changes and preserves image-only option keys', () => { const raw = { problemType: 1, problemId: '7', body: '题干', options: [{ key:'A',value:'<img src="https://www.yuketang.cn/a.png">' },{key:'B',value:'2'}] }; const a = normalize(raw, {},'1','2','3'); const b = normalize({...raw,body:'changed'}, {},'1','2','3'); expect(a.options[0].key).toBe('A'); expect(a.imageUrls).toContain('https://www.yuketang.cn/a.png'); expect(a.revision).not.toBe(b.revision); });
  it('rejects incomplete counting information', () => expect(() => deadlineFromInfo({ limit: 10 })).toThrow());
  it('converts server timing without relying on local/server clock equality', () => { expect(deadlineFromInfo({ limit: '60', now: '120000', dt:'100000' }, 1000)).toBe(41000); expect(deadlineFromInfo({limit:'-1'}, 1000)).toBeNull(); });
  it.each([{},null,{code:'invalid'}])('classifies unrecognised response as unknown', raw => expect(receipt(raw).status).toBe('UNKNOWN'));
  it('keeps acceptance separate from correctness', () => { expect(receipt({code:0}).status).toBe('ACCEPTED'); expect(receipt({code:123}).status).toBe('REJECTED'); });
});
describe('model output', () => {
  it('accepts a single multiline translation and rejects empty, split or oversized subjective answers', () => {
    const q = { ...question(), kind: 'subjective' as const, platformType: 5, options: [] };
    const parse = (answers: string[]) => parseAnswer(JSON.stringify({ kind: 'subjective', answers }), q);
    expect(parse(['中央处理器（CPU）。\n系统存储器。']).answers).toEqual(['中央处理器（CPU）。\n系统存储器。']);
    for (const answers of [[], [' '], ['甲', '乙'], ['字'.repeat(1001)]]) expect(() => parse(answers)).toThrow();
  });
  it('accepts one valid choice and optional markdown fencing', () => expect(parseAnswer('```json\n{"kind":"single","answers":["B"]}\n```',question()).answers).toEqual(['B']));
  it.each(['not json','{"kind":"single","answers":[]}','{"kind":"single","answers":["A","B"]}','{"kind":"single","answers":["C"]}','{"kind":"single","answers":[2]}','{"kind":"blank","answers":["A"]}'])('rejects invalid output %s', text => expect(() => parseAnswer(text,question())).toThrow());
  it('retains multiple-choice selection and rejects duplicates', () => { const q = {...question(),kind:'multiple' as const,platformType:2}; expect(parseAnswer('{"kind":"multiple","answers":["B","A"]}',q).answers).toEqual(['B','A']); expect(() => parseAnswer('{"kind":"multiple","answers":["A","A"]}',q)).toThrow(); });
  it('preserves ordered blanks, punctuation and mathematical strings', () => { const q = {...question(),kind:'blank' as const,platformType:4,blankCount:2}; expect(parseAnswer('{"kind":"blank","answers":["x,y","中文 ∫x dx"]}',q).answers).toEqual(['x,y','中文 ∫x dx']); expect(() => parseAnswer('{"kind":"blank","answers":["x"]}',q)).toThrow(); });
  it.each(['http://example.com','https://user:password@example.com','https://example.com/v1?token=x','https://example.com/v1/chat/completions'])('rejects bad API root %s', baseUrl => expect(() => validateConfig({baseUrl,model:'vision',apiKey:'test'})).toThrow());
  it('allows local compatible endpoints', () => expect(validateConfig({baseUrl:'http://localhost:1234/v1/',model:'vision',apiKey:'test'}).baseUrl).toBe('http://localhost:1234/v1'));
  it.each([401,429,503])('maps model HTTP %d without leaking response body', async status => { vi.stubGlobal('fetch',vi.fn(async()=>new Response('secret response',{status}))); await expect(solve({baseUrl:'https://example.com',model:'vision',apiKey:'secret-key'},question(),new AbortController().signal)).rejects.toThrow(/模型/); vi.unstubAllGlobals(); });
});
describe('durable ledger', () => {
  it('recovers interrupted submissions as UNKNOWN and blocks resend', () => { const file = join(mkdtempSync(join(tmpdir(),'rain-ledger-')),'ledger.json'); const a = new Ledger(file); a.put({key:'1:2:3',questionId:'3',lessonId:'2',kind:'single',status:'SUBMITTING',message:'',updatedAt:1}); const b = new Ledger(file); expect(b.blocks('1:2:3')).toBe(true); expect(b.list()[0].status).toBe('UNKNOWN'); expect(readFileSync(file,'utf8')).toContain('UNKNOWN'); });
  it('fails closed on corrupt records', () => { const file = join(mkdtempSync(join(tmpdir(),'rain-corrupt-')),'ledger.json'); writeFileSync(file,'{broken'); expect(()=>new Ledger(file)).toThrow(); });
});
describe('automatic answering lifecycle', () => {
  it.each(['pause','stop','close'])('blocks network dispatch when %s arrives during Cookie lookup', async action => {
    let release!:()=>void, entered!:()=>void;
    const gate = new Promise<void>(r=>release=r), started = new Promise<void>(r=>entered=r);
    const platform = new Yuketang({cookies:{get:async()=>{entered();await gate;return [];}}} as any);
    const r = rig({submit:(q,a,signal)=>platform.submit(q,a,signal)});
    Object.assign(platform,{alive:true,identity:{id:r.q.accountId,name:'test'},lesson:{id:r.q.lessonId}});
    r.e.offer(r.q); await started;
    if(action==='pause')r.e.pause();else if(action==='stop')r.e.stop();else r.e.invalidate(r.q.questionId);
    release(); await settled(r.e);
    expect(r.records.get(questionKey(r.q))?.status).toBe('SKIPPED');
  });
  it('submits exactly once for duplicate events and restarts', async () => { const r=rig(); r.e.offer(r.q); r.e.offer(r.q); await settled(r.e); r.e.start('auto'); r.e.offer(r.q); await settled(r.e); expect(r.ports.submit).toHaveBeenCalledTimes(1); });
  it('supports preview without dispatching a submission', async () => { const r=rig(); r.e.start('preview'); r.e.offer(r.q); await settled(r.e); expect(r.ports.submit).not.toHaveBeenCalled(); expect(r.records.get(questionKey(r.q))?.status).toBe('PREVIEW'); });
  it.each(['answered','closed','expired','changed'])('does not submit when fresh state is %s', async reason => { const r=rig(); r.ports.fresh=async()=>({...r.q, ...(reason==='answered'?{answered:true}:reason==='closed'?{open:false}:reason==='expired'?{deadline:Date.now()}: {revision:'changed'})}); r.e.offer(r.q); await settled(r.e); expect(r.ports.submit).not.toHaveBeenCalled(); });
  it.each(['pause','stop','close'])('cancels pending model work on %s', async action => { let release!:()=>void; const gate=new Promise<void>(r=>release=r); const r=rig({solve:async()=>{await gate;return {kind:'single',answers:['A'],explanation:''};}}); r.e.offer(r.q); await new Promise(res=>setTimeout(res,5)); if(action==='pause')r.e.pause();else if(action==='stop')r.e.stop();else r.e.invalidate(r.q.questionId); release(); await settled(r.e); expect(r.ports.submit).not.toHaveBeenCalled(); });
  it('records UNKNOWN if a submitted request loses its response and never retries', async () => { const r=rig({submit:vi.fn(async()=>{throw new Error('timeout');})}); r.e.offer(r.q); await settled(r.e); expect(r.records.get(questionKey(r.q))?.status).toBe('UNKNOWN'); r.e.start('auto');r.e.offer(r.q);await settled(r.e);expect(r.ports.submit).toHaveBeenCalledTimes(1); });
  it('records an in-flight receipt after pause', async () => { let release!:()=>void;const gate=new Promise<void>(r=>release=r); const r=rig({submit:vi.fn(async()=>{await gate; return {status:'ACCEPTED' as const,message:'ok'};})});r.e.offer(r.q);await new Promise(res=>setTimeout(res,5));r.e.pause();release();await settled(r.e);expect(r.records.get(questionKey(r.q))?.status).toBe('ACCEPTED'); });
  it('does not dispatch if write-ahead persistence fails', async()=>{const r=rig({ledger:{blocks:()=>false,put:r=>{if(r.status==='SUBMITTING')throw new Error('disk full');}}});r.e.offer(r.q);await settled(r.e);expect(r.ports.submit).not.toHaveBeenCalled();});
  it('does not reuse a previous question answer', async()=>{const r=rig();r.e.offer(r.q);await settled(r.e);const q2={...r.q,questionId:'123'};r.ports.fresh=async()=>q2;r.e.offer(q2);await settled(r.e);expect(r.ports.submit).toHaveBeenCalledTimes(2);expect((r.ports.submit as any).mock.calls[1][0].questionId).toBe('123');});
});
