// Historical one-shot test limits only. Never imported by the application.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
export type BillableService = 'deepseek' | 'asr' | 'tts';
export const BUDGET_POLICY = {
  capCny: 10, stopCny: 8, maxRequests: 60,
  reserveCny: { deepseek: 0.20, asr: 0.02, tts: 0.04 },
  rateVersion: 'beijing-2026-10-25', validThrough: '2026-10-28T07:32:00Z',
} as const;
const stateSchema = z.object({
  version: z.literal(1),
  requests: z.object({ deepseek: z.number().int().min(0), asr: z.number().int().min(0), tts: z.number().int().min(0) }).strict(),
  reservedMicros: z.number().int().min(0),
}).strict().refine(state => state.reservedMicros === state.requests.deepseek * 200000 + state.requests.asr * 20000 + state.requests.tts * 40000, 'Inconsistent budget ledger');
type Ledger = z.infer<typeof stateSchema>;
const fresh = (): Ledger => ({ version: 1, requests: { deepseek: 0, asr: 0, tts: 0 }, reservedMicros: 0 });
export class BudgetError extends Error { constructor(message: string) { super(message); this.name = 'BudgetError'; } }
export interface BudgetStore { read(): Ledger; update(change: (state: Ledger) => Ledger): void; }
export class MemoryBudgetStore implements BudgetStore {
  private state = fresh();
  read() { return structuredClone(this.state); }
  update(change: (state: Ledger) => Ledger) { this.state = stateSchema.parse(change(this.read())); }
}
export class FileBudgetStore implements BudgetStore {
  constructor(private path: string) {}
  read() { return existsSync(this.path) ? stateSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))) : fresh(); }
  update(change: (state: Ledger) => Ledger) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = this.path + '.lock';
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new BudgetError('预算记录正在使用或存在未完成写入，已暂停收费请求。'); }
    const temp = this.path + '.' + randomUUID() + '.tmp';
    try {
      const next = stateSchema.parse(change(this.read()));
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      const dataFd = openSync(temp, 'r'); try { fsyncSync(dataFd); } finally { closeSync(dataFd); }
      renameSync(temp, this.path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      closeSync(fd); unlinkSync(lock);
    }
  }
}
export interface BudgetOptions {
  confirmed: boolean; modelSupported: boolean;
  maxRequests?: number; now?: () => number;
}
export class BudgetGuard {
  private active = 0;
  private blocked = false;
  private readonly maxRequests: number;
  private readonly invalidLimit: boolean;
  constructor(private store: BudgetStore, private options: BudgetOptions) {
    const requested = options.maxRequests ?? BUDGET_POLICY.maxRequests;
    this.invalidLimit = !Number.isFinite(requested) || requested < 1 || !Number.isInteger(requested);
    this.maxRequests = Number.isFinite(requested) && requested >= 1 ? Math.min(60, Math.floor(requested)) : 60;
  }
  private reason() {
    if (this.invalidLimit) return '请求上限配置无效，收费请求保持关闭。';
    if (!this.options.confirmed) return '计费与用量核对未确认，收费请求保持关闭。';
    if (!this.options.modelSupported) return '模型或地域不匹配已核对费率，收费请求保持关闭。';
    if ((this.options.now?.() ?? Date.now()) > Date.parse(BUDGET_POLICY.validThrough)) return '费率核对期限已过，请重新核对后再开放测试。';
    if (this.blocked) return '预算记录不可读或不可写，收费请求已暂停。';
    return '';
  }
  status() {
    let state = fresh();
    try { state = this.store.read(); } catch { this.blocked = true; }
    const totalRequests = Object.values(state.requests).reduce((a,b) => a+b, 0);
    const reservedCny = state.reservedMicros / 1_000_000;
    const reason = this.reason() || (totalRequests >= this.maxRequests ? '测试请求次数已用完。' : reservedCny >= BUDGET_POLICY.stopCny ? '已到本地预算停止线。' : '');
    return { capCny: 10, stopCny: 8, maxRequests: this.maxRequests, totalRequests, requests: state.requests,
      reservedCny, actualBilledCny: null, enabled: !reason, reason, rateVersion: BUDGET_POLICY.rateVersion };
  }
  reserve(service: BillableService, signal: AbortSignal): () => void {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const reason = this.status().reason; if (reason) throw new BudgetError(reason);
    if (this.active) throw new BudgetError('上一项收费请求尚未结束，请稍后再试。');
    const amount = Math.ceil(BUDGET_POLICY.reserveCny[service] * 1_000_000);
    try {
      // Read/check/reserve/write under one lock, including across local processes.
      this.store.update(state => {
        const count = Object.values(state.requests).reduce((a,b)=>a+b,0);
        if (count >= this.maxRequests || state.reservedMicros + amount > 8_000_000) throw new BudgetError('已到合计预算或请求上限，请先核对账单。');
        state.requests[service]++; state.reservedMicros += amount; return state;
      });
    } catch (error) {
      if (!(error instanceof BudgetError)) this.blocked = true;
      throw error instanceof BudgetError ? error : new BudgetError('预算记录写入失败，未发送收费请求。');
    }
    this.active++;
    let released = false;
    const release = () => { if (released) return; released = true; this.active--; signal.removeEventListener('abort', release); };
    signal.addEventListener('abort', release, { once: true });
    // No refund on cancel, errors or timeout: upstream may already have billed.
    return release;
  }
}
