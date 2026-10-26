import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { parseEnv } from 'node:util';
import {
  runtimeFromValues,
  serializeRuntime,
  sealRuntime,
  openRuntime,
  invitationFromText,
} from '../scripts/deploy-transport.mjs';
const pair = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
describe('deployment envelope with fake credentials only', () => {
  it('allowlists settings, leaves the invitation unset and round-trips through authenticated encryption', () => {
    const values = runtimeFromValues({
      DEEPSEEK_API_KEY: 'test-only-deepseek',
      DASHSCOPE_API_KEY: 'test-only-qwen',
      DASHSCOPE_REGION: 'cn-beijing',
      UNRELATED_SECRET: 'excluded',
    });
    const text = serializeRuntime(values),
      sealed = sealRuntime(pair.publicKey, text);
    expect(sealed).not.toContain('test-only');
    expect(sealed).not.toContain(Buffer.from(text).toString('base64'));
    expect(openRuntime(pair.privateKey, sealed)).toBe(text);
    expect(parseEnv(text)).toMatchObject({
      MIRA_AUTH_REQUIRED: 'true',
      MIRA_PASSWORD_HASH: '',
      MIRA_PUBLIC_ORIGIN: 'https://iamm.xyz',
    });
    expect(text).not.toContain('UNRELATED_SECRET');
  });
  it('rejects tampered content, changed protocol version and an unrelated recipient key', () => {
    const sealed = sealRuntime(pair.publicKey, 'test-only'),
      payload = JSON.parse(sealed);
    const data = Buffer.from(payload.data, 'base64');
    data[0] ^= 1;
    payload.data = data.toString('base64');
    expect(() => openRuntime(pair.privateKey, JSON.stringify(payload))).toThrow();
    expect(() =>
      openRuntime(pair.privateKey, sealed.replace('mira-runtime-v1', 'mira-runtime-v2')),
    ).toThrow();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => openRuntime(other.privateKey, sealed)).toThrow();
  });
  it('accepts only a hash file for later invitation setup and encrypts that hash separately', () => {
    const hash = 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(128),
      text = serializeRuntime({ MIRA_PASSWORD_HASH: hash });
    expect(invitationFromText(text)).toBe(hash);
    expect(() => invitationFromText('PASSWORD=plaintext')).toThrow();
    expect(() => invitationFromText(text + 'DEEPSEEK_API_KEY=test-only')).toThrow();
    const sealed = sealRuntime(pair.publicKey, text);
    expect(sealed).not.toContain(hash);
    expect(invitationFromText(openRuntime(pair.privateKey, sealed))).toBe(hash);
  });
  it('rejects wrong region, credential-bearing endpoints and multiline values', () => {
    const values = {
      DEEPSEEK_API_KEY: 'test-only',
      DASHSCOPE_API_KEY: 'test-only',
      DASHSCOPE_REGION: 'cn-beijing',
    };
    expect(() => runtimeFromValues({ ...values, DASHSCOPE_REGION: 'ap-southeast-1' })).toThrow();
    expect(() =>
      runtimeFromValues({ ...values, QWEN_ASR_ENDPOINT: 'wss://bad.example/api-ws/v1/realtime' }),
    ).toThrow();
    expect(() => serializeRuntime({ DEEPSEEK_API_KEY: 'line1\nline2' })).toThrow();
    expect(() => serializeRuntime({ UNEXPECTED: 'value' })).toThrow();
  });
});
