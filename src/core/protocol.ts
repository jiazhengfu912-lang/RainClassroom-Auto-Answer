import { parse, isLosslessNumber } from 'lossless-json';
import { createHash } from 'node:crypto';
import type { AnswerProposal, QuestionContext, SubmissionReceipt } from '../shared/types';
import { imageIdentity } from '../shared/question-image';

export class SubmissionNotSentError extends Error {}

// 保留服务端 64 位标识符；只有类型、计时等小数值显式转换为 number。
export function decode(text: string): any {
  return parse(text, (_key, value) => isLosslessNumber(value) ? value.toString() : value);
}
export function id(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('标识符精度异常');
  const s = String(value ?? '');
  if (!/^[1-9]\d{0,24}$/.test(s)) throw new Error('平台标识符格式不支持');
  return s;
}
export function plain(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : '';
}
export function normalize(raw: any, slide: any, accountId: string, lessonId: string, presentationId: string): QuestionContext {
  const platformType = Number(raw.problemType);
  // 官方课堂题型：1 单选、2 多选、4 填空、5 主观题。
  const kind = platformType === 1 ? 'single' : platformType === 2 ? 'multiple' : platformType === 4 ? 'blank' : platformType === 5 ? 'subjective' : null;
  if (!kind) throw new Error('暂不支持该题型');
  const options = Array.isArray(raw.options) ? raw.options.map((o: any) => ({ key: String(o.key ?? ''), text: plain(o.value ?? o.content ?? o.text) })) : [];
  if ((kind === 'single' || kind === 'multiple') && (options.length < 2 || options.some((o: any) => !o.key) || new Set(options.map((o: any) => o.key)).size !== options.length)) throw new Error('选项标识不完整');
  const blankCount = Array.isArray(raw.blanks) ? raw.blanks.length : 0;
  if (kind === 'blank' && blankCount < 1) throw new Error('无法核实填空数量');
  const html = String(raw.body ?? '');
  const optionImages: string[] = (raw.options ?? []).flatMap((o: any) => Array.from(String(o.value ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi), m => m[1]));
  const imageUrls = [...new Set([slide.cover || slide.coverAlt, ...Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi), m => m[1]), ...optionImages].filter((s): s is string => typeof s === 'string' && /^https?:\/\//.test(s)))];
  const content = { platformType, stem: plain(html), options, blankCount, imageUrls };
  const revisionImages = imageUrls.map(imageIdentity);
  const coverUrl = imageUrls.includes(slide.cover || slide.coverAlt) ? slide.cover || slide.coverAlt : undefined;
  return { accountId, lessonId, presentationId, questionId: id(raw.problemId), kind, ...content,
    revision: createHash('sha256').update(JSON.stringify({ ...content, imageUrls: revisionImages, version: String(raw.version ?? '') })).digest('hex'), coverUrl, images: [], deadline: 0, open: false,
    answered: raw.result !== null && raw.result !== undefined };
}
export function deadlineFromInfo(info: any, now = Date.now()): number | null {
  const limit = Number(info.limit);
  if (limit === -1) return null;
  const elapsed = Number(info.now) - Number(info.dt);
  if (!Number.isFinite(limit) || !Number.isFinite(elapsed) || limit < 0 || elapsed < 0) throw new Error('题目计时信息不完整');
  return now + Math.max(0, limit - elapsed / 1000) * 1000;
}
export function parseAnswer(text: string, q: QuestionContext): AnswerProposal {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let a: any;
  try { a = JSON.parse(clean); } catch { throw new Error('模型未返回有效 JSON'); }
  if (!a || a.kind !== q.kind || !Array.isArray(a.answers) || a.answers.some((v: unknown) => typeof v !== 'string' || !v.trim())) throw new Error('模型答案结构不匹配');
  const answers: string[] = a.answers.map((s: string) => s.trim());
  if (q.kind === 'single' && answers.length !== 1) throw new Error('单选必须恰好一个答案');
  if (q.kind === 'blank' && answers.length !== q.blankCount) throw new Error('填空数量不匹配');
  if (q.kind === 'subjective' && (answers.length !== 1 || answers[0].length > 1000)) throw new Error('主观题需要一段不超过 1000 字的文字答案');
  if ((q.kind === 'single' || q.kind === 'multiple') && (!answers.length || new Set(answers).size !== answers.length || answers.some(s => !q.options.some(o => o.key === s)))) throw new Error('模型返回无效或重复选项');
  return { kind: q.kind, answers, explanation: typeof a.explanation === 'string' ? a.explanation.slice(0, 3000) : '' };
}
export function receipt(raw: any): SubmissionReceipt {
  if (raw && (raw.code === 0 || raw.code === '0')) return { status: 'ACCEPTED', message: '平台接受提交；判题结果请在官方页面核对' };
  if (raw && /^\d+$/.test(String(raw.code)) && Number(raw.code) > 0) return { status: 'REJECTED', message: `平台拒绝提交（code ${raw.code}）` };
  return { status: 'UNKNOWN', message: '回执结构未知，请核对官方记录；不会自动重发' };
}
export function questionKey(q: QuestionContext) { return `${q.accountId}:${q.lessonId}:${q.questionId}`; }
