import { abortError } from './async';

// Both upstream model SSE and the browser turn stream can split UTF-8, CRLF,
// JSON and event boundaries at arbitrary network byte offsets.
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let eventSize = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const chunk = await reader.read();
      if (signal.aborted) throw abortError();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          eventSize = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          eventSize += value.length;
          if (eventSize > 32768) throw new Error('流式消息过长。');
          data.push(value);
        }
      }
      if (pending.length > 32768) throw new Error('流式消息过长。');
      if (chunk.done) break;
    }
    // An event without its terminating blank line is incomplete, never a reply.
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
