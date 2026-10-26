import type { DialogueProvider } from './providers';
import type { SpeechProvider } from './speech';
import type { RequestAudit } from './request-audit';
export function auditDialogue(provider: DialogueProvider, audit: RequestAudit): DialogueProvider {
  return {
    kind: provider.kind,
    async reply(input, signal, repair, onText) {
      audit.record('deepseek', signal);
      return provider.reply(input, signal, repair, onText);
    },
  };
}
export function auditSpeech(provider: SpeechProvider, audit: RequestAudit): SpeechProvider {
  return {
    openAsr(signal) {
      audit.record('asr', signal);
      return provider.openAsr(signal);
    },
    async synthesize(text, signal, audio) {
      audit.record('tts', signal);
      await provider.synthesize(text, signal, audio);
    },
  };
}
