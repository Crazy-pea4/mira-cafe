import { appPath } from './app-path';
import { turnResponseSchema, type TurnRequest, type TurnResponse } from '../../shared/protocol';
import {
  presentationResponseSchema,
  type Presentation,
  type PresentationResponse,
} from '../../shared/story';
import { abortError } from '../../shared/async';
export interface Transport {
  turn(request: TurnRequest, signal: AbortSignal): Promise<TurnResponse>;
  presented?(receipt: Presentation): Promise<PresentationResponse>;
  cancel(sessionId: string, throughTurnId: number): Promise<void>;
}
export class HttpTransport implements Transport {
  private controls: Promise<void> = Promise.resolve();
  private unsynced = false;
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.controls.then(work);
    this.controls = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  presented(receipt: Presentation): Promise<PresentationResponse> {
    return this.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(appPath('api/presented'), {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(receipt),
          keepalive: true,
        });
        const parsed = presentationResponseSchema.safeParse(await response.json());
        if (
          !response.ok ||
          !parsed.success ||
          parsed.data.turnId !== receipt.turnId ||
          parsed.data.through !== receipt.through
        )
          throw new Error('sync');
        return parsed.data;
      } catch {
        this.unsynced = true;
        throw new Error('这段对白暂时没能同步。请刷新，从这一晚重新开始。');
      } finally {
        clearTimeout(timer);
      }
    });
  }
  async turn(request: TurnRequest, signal: AbortSignal) {
    await this.controls;
    if (signal.aborted) throw abortError();
    if (this.unsynced) throw new Error('这段对白暂时没能同步。请刷新，从这一晚重新开始。');
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? '连接失败，请重试。');
      const parsed = turnResponseSchema.safeParse(data);
      if (!parsed.success) throw new Error('角色回复格式异常，请重试。');
      return parsed.data;
    } catch (error) {
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
