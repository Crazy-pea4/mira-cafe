import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
export type BillableService = 'deepseek' | 'asr' | 'tts';
// Compatibility weights for the existing v1 counter file, not prices or spending limits.
const LEGACY_WEIGHTS = { deepseek: 200000, asr: 20000, tts: 40000 } as const;
const stateSchema = z
  .object({
    version: z.literal(1),
    requests: z
      .object({
        deepseek: z.number().int().min(0),
        asr: z.number().int().min(0),
        tts: z.number().int().min(0),
      })
      .strict(),
    reservedMicros: z.number().int().min(0),
  })
  .strict()
  .refine(
    (state) =>
      state.reservedMicros ===
      state.requests.deepseek * 200000 + state.requests.asr * 20000 + state.requests.tts * 40000,
    'Inconsistent budget ledger',
  );
type Ledger = z.infer<typeof stateSchema>;
const fresh = (): Ledger => ({
  version: 1,
  requests: { deepseek: 0, asr: 0, tts: 0 },
  reservedMicros: 0,
});
export class AuditStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditStoreError';
  }
}
export interface AuditStore {
  read(): Ledger;
  update(change: (state: Ledger) => Ledger): void;
}
export class MemoryAuditStore implements AuditStore {
  private state = fresh();
  read() {
    return structuredClone(this.state);
  }
  update(change: (state: Ledger) => Ledger) {
    this.state = stateSchema.parse(change(this.read()));
  }
}
export class FileAuditStore implements AuditStore {
  constructor(private path: string) {}
  read() {
    return existsSync(this.path)
      ? stateSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : fresh();
  }
  update(change: (state: Ledger) => Ledger) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = this.path + '.lock';
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      throw new AuditStoreError('Request audit write lock unavailable');
    }
    const temp = this.path + '.' + randomUUID() + '.tmp';
    try {
      const next = stateSchema.parse(change(this.read()));
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      const dataFd = openSync(temp, 'r');
      try {
        fsyncSync(dataFd);
      } finally {
        closeSync(dataFd);
      }
      renameSync(temp, this.path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}
// Best-effort statistics never authorize or block a configured provider.
// Existing counters are preserved; corrupt/locked files are not reset or overwritten.
export class RequestAudit {
  private writeAvailable = true;
  constructor(private store: AuditStore) {}
  status() {
    try {
      const state = this.store.read();
      return {
        limitsEnforced: false,
        available: this.writeAvailable,
        totalRequests: Object.values(state.requests).reduce((a, b) => a + b, 0),
        requests: state.requests,
        legacyWeightedCny: state.reservedMicros / 1_000_000,
        actualBilledCny: null,
      };
    } catch {
      return {
        limitsEnforced: false,
        available: false,
        totalRequests: null,
        requests: null,
        legacyWeightedCny: null,
        actualBilledCny: null,
      };
    }
  }
  record(service: BillableService, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      this.store.update((state) => {
        state.requests[service]++;
        state.reservedMicros += LEGACY_WEIGHTS[service];
        return state;
      });
      this.writeAvailable = true;
    } catch {
      this.writeAvailable = false;
    }
  }
}
