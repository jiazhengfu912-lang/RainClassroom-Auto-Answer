import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskRecord } from '../shared/types';

export class Ledger {
  private records = new Map<string, TaskRecord>();
  constructor(private path: string) {
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      const statuses = ['QUEUED', 'CAPTURING', 'SOLVING', 'PREVIEW', 'SUBMITTING', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'SKIPPED'];
      if (value.version !== 1 || !Array.isArray(value.records) || value.records.some((r: TaskRecord) => typeof r.key !== 'string' || !r.key || !statuses.includes(r.status) || !['single','multiple','blank','subjective'].includes(r.kind) || !Number.isFinite(r.updatedAt))) throw new Error('本地提交记录损坏，请保留文件并核对官方记录');
      for (const r of value.records as TaskRecord[]) this.records.set(r.key, r.status === 'SUBMITTING' ? { ...r, status: 'UNKNOWN', message: '上次提交被中断，请核对官方记录' } : r);
      this.flush();
    }
  }
  list() { return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  blocks(key: string) { return ['SUBMITTING', 'ACCEPTED', 'UNKNOWN', 'REJECTED'].includes(this.records.get(key)?.status ?? ''); }
  put(record: TaskRecord) {
    const old = this.records.get(record.key);
    this.records.set(record.key, record);
    try { this.flush(); } catch (e) { if (old) this.records.set(record.key, old); else this.records.delete(record.key); throw e; }
  }
  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, records: [...this.records.values()] })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
  }
}
