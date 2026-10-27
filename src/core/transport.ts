import { appPath } from './app-path';
import { turnResponseSchema, turnStreamEventSchema, type TurnRequest, type TurnResponse } from '../../shared/protocol';
import { sseData } from '../../shared/sse';
import {
  presentationResponseSchema,
  type Presentation,
  type PresentationResponse,
} from '../../shared/story';
import { abortError } from '../../shared/async';
import type { InteractionTiming } from './interaction-timing';
export interface Transport {
  turn(request: TurnRequest, signal: AbortSignal, onText?: (text: string) => void): Promise<TurnResponse>;
  presented?(receipt: Presentation): Promise<PresentationResponse>;
  cancel(sessionId: string, throughTurnId: number): Promise<void>;
  reset?(): Promise<void>;
}
export class HttpTransport implements Transport {
  private controls: Promise<void> = Promise.resolve();
  private unsynced = new Set<string>();
  private resetFailed = false;
  constructor(private timing?: InteractionTiming, private persistent = false) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.controls.then(work);
    this.controls = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  reset(): Promise<void> {
    if (!this.persistent) return Promise.resolve();
    return this.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(appPath('api/progress'), { method: 'DELETE', signal: controller.signal });
        if (!response.ok) throw new Error('进度暂时未能重置，请刷新后重试。');
        this.resetFailed = false;
      } catch (error) { this.resetFailed = true; throw error; }
      finally { clearTimeout(timer); }
    });
  }
  presented(receipt: Presentation): Promise<PresentationResponse> {
    return this.enqueue(async () => {
      // Receipts are idempotent and do not call a model. A short network stall
      // must not permanently invalidate an otherwise completed live reply.
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        let retryable = true;
        try {
          const response = await fetch(appPath('api/presented'), {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(receipt),
            keepalive: true,
          });
          if (!response.ok) {
            retryable = response.status === 408 || response.status >= 500;
            throw new Error('sync');
          }
          const parsed = presentationResponseSchema.safeParse(await response.json());
          if (
            !parsed.success ||
            parsed.data.turnId !== receipt.turnId ||
            parsed.data.through !== receipt.through
          ) {
            retryable = false;
            throw new Error('sync');
          }
          return parsed.data;
        } catch {
          if (retryable && attempt === 0) continue;
          this.unsynced.add(receipt.sessionId);
          throw new Error('这段对白暂时没能同步。请刷新，恢复上次保存的进度。');
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error('这段对白暂时没能同步。请刷新，恢复上次保存的进度。');
    });
  }
  async turn(request: TurnRequest, signal: AbortSignal, onText?: (text: string) => void) {
    await this.controls;
    if (signal.aborted) throw abortError();
    if (this.unsynced.has(request.sessionId) || this.resetFailed)
      throw new Error('这段对白暂时没能同步。请刷新，恢复上次保存的进度。');
    const timing = this.timing?.begin('model', request.turnId);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 21000);
    try {
      const response = await fetch(appPath('api/turn'), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(request),
      });
      if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!response.body) throw new Error('没有收到回复数据流，请重试。');
        for await (const data of sseData(response.body, controller.signal)) {
          const parsed = turnStreamEventSchema.safeParse(JSON.parse(data));
          if (!parsed.success) throw new Error('角色回复格式异常，请重试。');
          const event = parsed.data;
          const turnId = event.type === 'reply' ? event.reply.turnId : event.turnId;
          if (turnId !== request.turnId) throw new Error('收到不匹配的回复，请重试。');
          if (signal.aborted) throw abortError();
          if (event.type === 'text') {
            if (event.text) timing?.mark('firstText');
            onText?.(event.text);
          }
          if (event.type === 'error') throw new Error(event.error.message);
          if (event.type === 'reply') {
            timing?.finish('complete');
            return event.reply;
          }
        }
        throw new Error('回复传输中断，请重试这一句。');
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? '连接失败，请重试。');
      const parsed = turnResponseSchema.safeParse(data);
      if (!parsed.success) throw new Error('角色回复格式异常，请重试。');
      if (parsed.data.turnId !== request.turnId) throw new Error('收到不匹配的回复，请重试。');
      timing?.finish('complete');
      return parsed.data;
    } catch (error) {
      timing?.finish(signal.aborted ? 'cancelled' : 'error');
      if (signal.aborted) throw abortError();
      if (timedOut) throw new Error('连接超时，请重试。');
      if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认服务已启动后重试。');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }
  async cancel(sessionId: string, throughTurnId: number) {
    return this.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(appPath('api/cancel'), {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, throughTurnId }),
          keepalive: true,
        });
      } catch {
        /* Local invalidation is authoritative even if cancellation cannot reach the server. */
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
