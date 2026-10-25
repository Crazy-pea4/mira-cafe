import { modelReplySchema, replySchema, emotionSchema, actionSchema, sceneSchema, type Reply } from '../shared/protocol';
import { zodValidationIssues } from './validation-feedback';
import type { DiagnosticSink, ReplyDiagnostic, ReplyIssue } from './reply-diagnostics';
export type ReplyFailure = 'INVALID_REPLY' | 'EMPTY_REPLY' | 'TRUNCATED_REPLY' | 'INCOMPLETE_REPLY' | 'FILTERED_REPLY' | 'REPLY_TOO_LONG';
export class ReplyFormatError extends Error {
  constructor(readonly code: ReplyFailure, message: string, readonly validationIssues: string[] = []) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const kind = (value: unknown): ReplyDiagnostic['contentType'] => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : typeof value === 'object' ? 'object' : 'other';
const cleanText = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/gu,' ').trim() : '';
const usableText = (text: string) => /[\p{L}\p{N}]/u.test(text);
// Do not speak damaged JSON, markdown code or executable markup as natural dialogue.
const looksStructured = (text: string) => /[{}\[\]\u0060]/.test(text) || /^["<]/.test(text) || /"(segments|text|action|emotion)"\s*:/.test(text);
function splitText(text: string): string[] {
  const chunks: string[] = []; let chunk = '';
  for (const char of text) { if (chunk.length + char.length > 180) { chunks.push(chunk); chunk = ''; } chunk += char; }
  if (chunk) chunks.push(chunk); return chunks;
}
export function parseDeepSeekReply(envelope: unknown, sink: DiagnosticSink = () => {}, strict = false): Reply {
  const choices = object(envelope) && Array.isArray(envelope.choices) ? envelope.choices : [];
  const choice = choices[0], message = object(choice) && object(choice.message) ? choice.message : undefined;
  const content = message?.content;
  const finish = object(choice) ? choice.finish_reason : undefined;
  const knownFinish = ['stop','length','content_filter','tool_calls','insufficient_system_resource','aborted'];
  const facts: ReplyDiagnostic = {
    event:'reply-format', outcome:'rejected',
    finishReason: finish == null ? 'missing' : typeof finish === 'string' && knownFinish.includes(finish) ? finish as ReplyDiagnostic['finishReason'] : 'other',
    trimmedLength:typeof content === 'string' ? Math.min(12001,content.trim().length) : 0, contentType:kind(content), contentLength:typeof content === 'string' ? Math.min(12001,content.length) : 0, segmentCount:0, issues:[],
  };
  if (object(envelope) && object(envelope.usage)) {
    for (const [source,target] of [['prompt_tokens','promptTokens'],['completion_tokens','completionTokens']] as const) {
      const value = envelope.usage[source];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000) facts[target] = value;
    }
  }
  const issue = (value: ReplyIssue) => { if (!facts.issues.includes(value)) facts.issues.push(value); };
  const report = () => { try { sink(facts); } catch { /* Logging cannot alter reply behavior. */ } };
  const reject = (code: ReplyFailure, category: ReplyIssue, text: string, validationIssues: string[] = []): never => { issue(category); if(validationIssues.length) facts.validationIssues=validationIssues; report(); throw new ReplyFormatError(code,text,validationIssues); };
  if (!message) return reject('INVALID_REPLY','bad-envelope','服务没有返回可识别的回复，未自动重试。');
  if (finish === 'length') return reject('TRUNCATED_REPLY','truncated','这次回复达到长度上限，内容不完整，已停止演出；未自动重试。');
  if (finish === 'content_filter' || (typeof message.refusal === 'string' && message.refusal.trim())) return reject('FILTERED_REPLY','filtered','服务没有提供可展示的对白，未自动重试。可以换个话题。');
  if ((finish != null && finish !== 'stop') || (Array.isArray(message.tool_calls) && message.tool_calls.length)) return reject('INCOMPLETE_REPLY','incomplete','服务未正常完成对白，已停止演出；未自动重试。');
  if (typeof content !== 'string') return reject('EMPTY_REPLY','empty-text','这次没有收到有效对白，未自动重试。');
  let raw = content.replace(/^\uFEFF/,'').trim();
  if (!raw) return reject('EMPTY_REPLY','empty-text','这次没有收到有效对白，未自动重试。');
  if (raw.length > 12000) return reject('REPLY_TOO_LONG','too-long','回复过长，已停止演出；未自动重试。');
  const fence = raw.match(/^\u0060{3}(?:json)?\s*\n?([\s\S]*?)\n?\u0060{3}$/i);
  if (fence) { raw = fence[1].trim(); issue('fenced'); }
  let root: unknown;
  try { root = JSON.parse(raw); }
  catch {
    if (strict || fence || looksStructured(raw) || !usableText(raw)) return reject('INVALID_REPLY','invalid-json','这次回复格式不完整，未自动重试。可以换一句话继续。');
    root = { text: raw }; issue('plain-text');
  }
  if (strict) {
    const checked = modelReplySchema.safeParse(root);
    if (!checked.success) return reject('INVALID_REPLY','schema','对白未通过格式校验。',zodValidationIssues(checked.error.issues));
    facts.segmentCount = checked.data.segments.length;
    facts.outcome = facts.issues.length ? 'normalized' : 'accepted'; report();
    return checked.data;
  }
  if (typeof root === 'string') {
    const text = root.trim();
    if (looksStructured(text)) {
      try { root = JSON.parse(text); issue('wrapped'); }
      catch { return reject('INVALID_REPLY','invalid-json','这次回复格式不完整，未自动重试。'); }
    } else { root = { text }; issue('plain-text'); }
  }
  if (object(root) && !Object.hasOwn(root,'segments')) {
    const wrappers = ['reply','response','data'].filter(key => object(root) && Object.hasOwn(root,key));
    if (wrappers.length === 1 && object(root[wrappers[0]])) { root = root[wrappers[0]]; issue('wrapped'); }
  }
  let candidates: unknown[];
  if (object(root) && Object.hasOwn(root,'segments')) {
    if (!Array.isArray(root.segments)) return reject('INVALID_REPLY','bad-envelope','回复的对白列表格式不正确，未自动重试。');
    candidates = root.segments;
    if (Object.keys(root).some(key=>key!=='segments')) issue('extra-fields');
  } else if (Array.isArray(root)) { candidates = root; issue('wrapped'); }
  else if (object(root) && typeof root.text === 'string') { candidates = [root]; issue('wrapped'); }
  else {
    const fields = object(root) ? ['dialogue','content','reply','response'].filter(key=>typeof root[key] === 'string') : [];
    if (fields.length !== 1 || !object(root)) return reject('EMPTY_REPLY','empty-text','这次没有收到可用对白，未自动重试。');
    candidates = [{text:root[fields[0]]}]; issue('plain-text');
  }
  facts.segmentCount = Math.min(100,candidates.length);
  if (candidates.length > 12) return reject('REPLY_TOO_LONG','too-long','回复段落过多，已停止演出；未自动重试。');
  let textOnly = facts.issues.includes('plain-text');
  const segments: Reply['segments'] = [];
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (!object(candidate)) { issue('empty-segment'); textOnly = true; continue; }
    const text = cleanText(candidate.text);
    if (!usableText(text)) { issue('empty-segment'); textOnly = true; continue; }
    if (looksStructured(text) && /^(\{|\[|\u0060{3})/.test(text)) return reject('INVALID_REPLY','invalid-json','回复中包含未解析的结构化内容，未自动重试。');
    texts.push(text);
    const emotion = emotionSchema.safeParse(candidate.emotion), action = actionSchema.safeParse(candidate.action);
    if (!emotion.success || !action.success) { issue(candidate.emotion == null || candidate.action == null ? 'missing-directive' : 'invalid-directive'); textOnly = true; }
    const segment: Reply['segments'][number] = { text, emotion:emotion.success ? emotion.data : 'guarded', action:action.success ? action.data : 'idle' };
    if (candidate.scene != null) {
      const scene = sceneSchema.safeParse(candidate.scene);
      if (scene.success) segment.scene = scene.data; else { issue('invalid-directive'); textOnly = true; }
    } else if (Object.hasOwn(candidate,'scene')) issue('extra-fields');
    if (candidate.event != null) {
      if (candidate.event === 'reveal-photo') segment.event = 'reveal-photo'; else { issue('invalid-directive'); textOnly = true; }
    } else if (Object.hasOwn(candidate,'event')) issue('extra-fields');
    if (Object.keys(candidate).some(key=>!['text','emotion','action','scene','event'].includes(key))) issue('extra-fields');
    if (text.length > 180) { issue('split-text'); textOnly = true; }
    segments.push(segment);
  }
  if (!texts.length) return reject('EMPTY_REPLY','empty-text','这次没有收到可用对白，未自动重试。');
  const combined = texts.join('\n');
  if (texts.reduce((sum,text)=>sum+text.length,0) > 540 || (textOnly && combined.length > 540)) return reject('REPLY_TOO_LONG','too-long','对白超过可展示长度，已停止演出；未自动重试。');
  if (segments.length > 3) { issue('split-text'); textOnly = true; }
  if (textOnly && combined.length > 540) return reject('REPLY_TOO_LONG','too-long','对白超过可展示长度，已停止演出；未自动重试。');
  const output: Reply = textOnly ? { segments:splitText(combined).map(text=>({text,emotion:'guarded',action:'idle'})), notice:'REPLY_TEXT_ONLY' } : { segments };
  const checked = replySchema.safeParse(output);
  if (!checked.success) return reject('INVALID_REPLY','bad-envelope','回复未通过安全校验，已停止演出；未自动重试。');
  facts.outcome = textOnly ? 'text-only' : facts.issues.length ? 'normalized' : 'accepted'; report();
  return checked.data;
}
