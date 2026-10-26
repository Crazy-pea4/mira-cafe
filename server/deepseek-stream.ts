import { sseData } from '../shared/sse';
import { streamedText } from './streamed-text';
import { ProviderError } from './providers';
import { isAbort } from '../shared/async';

export async function readDeepSeekStream(
  response: Response,
  signal: AbortSignal,
  onText?: (text: string) => void,
) {
  if (!response.body) throw new ProviderError('UNAVAILABLE', '没有收到文字数据流，请重试。');
  let content = '';
  let preview = '';
  let finish: unknown;
  let usage: unknown;
  let refusal = '';
  let tools = false;
  let done = false;
  try {
    for await (const data of sseData(response.body, signal)) {
      if (data === '[DONE]') { done = true; break; }
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error('Upstream stream error');
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string') {
        content += delta.content;
        if (content.length > 12000)
          throw new ProviderError('REPLY_TOO_LONG', '回复过长，已停止接收。');
        const text = streamedText(content);
        if (text !== preview) { preview = text; onText?.(text); }
      }
      if (typeof delta?.refusal === 'string') refusal += delta.refusal;
      if (delta?.tool_calls?.length) tools = true;
      if (choice?.finish_reason != null) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    if (!done || finish == null) throw new Error('Incomplete stream');
    return {
      choices: [{ finish_reason: finish, message: { content, refusal, ...(tools ? { tool_calls: [{}] } : {}) } }],
      usage,
    };
  } catch (error) {
    if (signal.aborted || isAbort(error) || error instanceof ProviderError) throw error;
    throw new ProviderError('UNAVAILABLE', '回复传输中断，请重试这一句。');
  }
}
