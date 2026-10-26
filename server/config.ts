export type QwenConfig = {
  apiKey: string;
  region: string;
  asrEndpoint: string;
  ttsEndpoint: string;
  asrModel: string;
  ttsModel: string;
  voice: string;
  workspaceId?: string;
};
export type RuntimeConfig = {
  liveEnabled: boolean;
  deepseek?: { apiKey: string; model: string };
  qwen?: QwenConfig;
  configuration: 'mock' | 'partial' | 'live';
};
function endpoint(raw: string | undefined, region: string): string | undefined {
  if (!raw) return;
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'wss:' ||
      u.username ||
      u.password ||
      u.hash ||
      (u.port && u.port !== '443') ||
      u.pathname !== '/api-ws/v1/realtime'
    )
      return;
    const bj =
      u.hostname === 'dashscope.aliyuncs.com' ||
      /^[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(u.hostname);
    const sg =
      u.hostname === 'dashscope-intl.aliyuncs.com' ||
      /^[a-zA-Z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/.test(u.hostname);
    if (!((region === 'cn-beijing' && bj) || (region === 'ap-southeast-1' && sg))) return;
    u.search = '';
    return u.toString();
  } catch {
    return;
  }
}
export function resolveConfig(env: Record<string, string | undefined>): RuntimeConfig {
  // Do not inspect credentials at all without the explicit live gate.
  if (env.MIRA_ENABLE_LIVE_APIS !== 'true') return { liveEnabled: false, configuration: 'mock' };
  const config: RuntimeConfig = { liveEnabled: true, configuration: 'partial' };
  if (env.MIRA_PROVIDER === 'deepseek' && env.DEEPSEEK_API_KEY?.trim())
    config.deepseek = {
      apiKey: env.DEEPSEEK_API_KEY.trim(),
      model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    };
  if (env.MIRA_SPEECH_PROVIDER === 'qwen') {
    const region = env.DASHSCOPE_REGION ?? '',
      asrEndpoint = endpoint(env.QWEN_ASR_ENDPOINT, region),
      ttsEndpoint = endpoint(env.QWEN_TTS_ENDPOINT, region);
    if (asrEndpoint && ttsEndpoint && env.DASHSCOPE_API_KEY?.trim())
      config.qwen = {
        apiKey: env.DASHSCOPE_API_KEY.trim(),
        region,
        asrEndpoint,
        ttsEndpoint,
        asrModel: env.QWEN_ASR_MODEL?.trim() || 'qwen3-asr-flash-realtime',
        ttsModel: env.QWEN_TTS_MODEL?.trim() || 'qwen3-tts-flash-realtime',
        voice: env.QWEN_TTS_VOICE?.trim() || 'Chelsie',
        workspaceId: env.DASHSCOPE_WORKSPACE_ID?.trim() || undefined,
      };
  }
  if (config.deepseek || config.qwen) config.configuration = 'live';
  return config;
}
