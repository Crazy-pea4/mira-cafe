import type { DialogueProvider } from './providers';
import { ProviderError } from './providers';
import type { SpeechProvider, AsrSession } from './speech';
import { SpeechError } from './speech';
import { BudgetGuard, BudgetError } from './budget';
export function budgetDialogue(provider: DialogueProvider, budget: BudgetGuard): DialogueProvider {
  return { kind: provider.kind, reply: async (input, signal, repair) => {
    let release = () => {};
    try { release = budget.reserve('deepseek', signal); return await provider.reply(input, signal, repair); }
    catch (error) { if (error instanceof BudgetError) throw new ProviderError('BUDGET_LIMIT', error.message); throw error; }
    finally { release(); }
  } };
}
export function budgetSpeech(provider: SpeechProvider, budget: BudgetGuard): SpeechProvider {
  function reserve(kind: 'asr' | 'tts', signal: AbortSignal) {
    try { return budget.reserve(kind, signal); }
    catch (error) { if (error instanceof BudgetError) throw new SpeechError('BUDGET_LIMIT', error.message); throw error; }
  }
  return {
    openAsr(signal): AsrSession {
      const release = reserve('asr', signal);
      try {
        const session = provider.openAsr(signal);
        const ready = session.ready.catch(error => { release(); throw error; });
        return { ready, append: pcm => { try { session.append(pcm); } catch(error) { release(); throw error; } },
          commit: async () => { try { return await session.commit(); } finally { release(); } },
          cancel: () => { try { session.cancel(); } finally { release(); } } };
      } catch(error) { release(); throw error; }
    },
    async synthesize(text, signal, audio) {
      const release = reserve('tts', signal);
      try { await provider.synthesize(text, signal, audio); } finally { release(); }
    },
  };
}
