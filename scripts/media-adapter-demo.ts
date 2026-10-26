import { createMediaProvider } from '../server/media-config';
import { waitForMedia } from '../server/media';

// Default invocation is offline even if the shell contains live credentials.
// --live additionally requires the explicit media gate and a configured service.
const live = process.argv.includes('--live');
const provider = createMediaProvider(live ? process.env : { MIRA_MEDIA_PROVIDER: 'mock' });
if (!provider) throw new Error('媒体适配层未启用。');
const signal = AbortSignal.timeout(130000);
const id = await provider.submit({ prompt: 'a mountain lodge after rain, mist, warm porch lights', seed: 1 }, signal);
const job = await waitForMedia(provider, id, signal, {
  pollMs: live ? 1000 : 1,
  onState: (job) => console.log(JSON.stringify({ provider: provider.kind, state: job.state })),
});
const images = await Promise.all(job.images.map((image) => provider.download(image, signal)));
console.log(JSON.stringify({ provider: provider.kind, state: job.state, imageBytes: images.map((image) => image.bytes.length), mode: live ? 'external-service' : 'offline-fixture' }));
