// Supported Workbench file transfer carries ciphertext only. No secret is a CLI argument.
// Temporary RSA private key stays on the destination host and is removed after import.
import {
  randomBytes,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  createCipheriv,
  createDecipheriv,
  constants,
} from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  chmodSync,
  statSync,
  renameSync,
  lstatSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
const version = 'mira-runtime-v1';
const allowed = new Set([
  'NODE_ENV',
  'PORT',
  'MIRA_BASE_PATH',
  'MIRA_PUBLIC_ORIGIN',
  'MIRA_AUTH_REQUIRED',
  'MIRA_PASSWORD_HASH',
  'MIRA_STATIC_DIR',
  'MIRA_STATE_DIR',
  'MIRA_ENABLE_LIVE_APIS',
  'MIRA_PROVIDER',
  'MIRA_SPEECH_PROVIDER',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_REGION',
  'DASHSCOPE_WORKSPACE_ID',
  'QWEN_ASR_ENDPOINT',
  'QWEN_TTS_ENDPOINT',
  'QWEN_ASR_MODEL',
  'QWEN_TTS_MODEL',
  'QWEN_TTS_VOICE',
]);
export function runtimeFromValues(values) {
  const required = (name) => {
    const value = values[name]?.trim();
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('Invalid field');
    return value;
  };
  const key = required('DEEPSEEK_API_KEY'),
    dash = required('DASHSCOPE_API_KEY');
  if (values.DASHSCOPE_REGION !== 'cn-beijing') throw new Error('Region mismatch');
  const endpoint = (name) => {
    const raw = values[name] || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      url = new URL(raw);
    if (
      url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port && url.port !== '443') ||
      url.pathname !== '/api-ws/v1/realtime' ||
      !(
        url.hostname === 'dashscope.aliyuncs.com' ||
        /^[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname)
      )
    )
      throw new Error('Endpoint mismatch');
    return url.toString();
  };
  return {
    NODE_ENV: 'production',
    PORT: '3001',
    MIRA_BASE_PATH: '/mira',
    MIRA_PUBLIC_ORIGIN: 'https://iamm.xyz',
    MIRA_AUTH_REQUIRED: 'true',
    MIRA_PASSWORD_HASH: '',
    MIRA_STATIC_DIR: 'build/client',
    MIRA_STATE_DIR: '/var/lib/mira-cafe',
    MIRA_ENABLE_LIVE_APIS: 'true',
    MIRA_PROVIDER: 'deepseek',
    MIRA_SPEECH_PROVIDER: 'qwen',
    DEEPSEEK_API_KEY: key,
    DEEPSEEK_MODEL: values.DEEPSEEK_MODEL || 'deepseek-flash',
    DASHSCOPE_API_KEY: dash,
    DASHSCOPE_REGION: 'cn-beijing',
    DASHSCOPE_WORKSPACE_ID: values.DASHSCOPE_WORKSPACE_ID || '',
    QWEN_ASR_ENDPOINT: endpoint('QWEN_ASR_ENDPOINT'),
    QWEN_TTS_ENDPOINT: endpoint('QWEN_TTS_ENDPOINT'),
    QWEN_ASR_MODEL: values.QWEN_ASR_MODEL || 'qwen3-asr-flash-realtime',
    QWEN_TTS_MODEL: values.QWEN_TTS_MODEL || 'qwen3-tts-flash-realtime',
    QWEN_TTS_VOICE: values.QWEN_TTS_VOICE || 'Chelsie',
  };
}
export function serializeRuntime(values) {
  if (Object.keys(values).some((k) => !allowed.has(k))) throw new Error('Unexpected field');
  return (
    Object.entries(values)
      .map(([key, value]) => {
        if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value))
          throw new Error('Invalid value');
        return key + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      })
      .join('\n') + '\n'
  );
}
export function sealRuntime(publicKey, plaintext) {
  const key = randomBytes(32),
    iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(version));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({
      version,
      key: publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        key,
      ).toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  } finally {
    key.fill(0);
  }
}
export function openRuntime(privateKey, envelope) {
  if (Buffer.byteLength(envelope) > 32768) throw new Error('Envelope too large');
  const parsed = JSON.parse(envelope);
  if (
    parsed.version !== version ||
    Object.keys(parsed).sort().join(',') !== 'data,iv,key,tag,version' ||
    ['key', 'iv', 'tag', 'data'].some(
      (k) => typeof parsed[k] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed[k]),
    )
  )
    throw new Error('Invalid envelope');
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(parsed.key, 'base64'),
  );
  try {
    const iv = Buffer.from(parsed.iv, 'base64'),
      tag = Buffer.from(parsed.tag, 'base64');
    if (key.length !== 32 || iv.length !== 12 || tag.length !== 16)
      throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(version));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    key.fill(0);
  }
}
export function invitationFromText(text) {
  if (text.length > 512) throw new Error('Invalid invitation file');
  const values = parseEnv(text);
  if (
    Object.keys(values).join(',') !== 'MIRA_PASSWORD_HASH' ||
    !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(values.MIRA_PASSWORD_HASH ?? '')
  )
    throw new Error('Invalid invitation hash');
  return values.MIRA_PASSWORD_HASH;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, a, b, c] = process.argv.slice(2);
    if (mode === 'keygen' && a && !b) {
      const privatePath = join(a, 'transport-private.pem'),
        publicPath = join(a, 'transport-public.pem');
      if (existsSync(privatePath) || existsSync(publicPath)) throw new Error('Existing key');
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      writeFileSync(privatePath, pair.privateKey, { mode: 0o600, flag: 'wx' });
      writeFileSync(publicPath, pair.publicKey, { mode: 0o644, flag: 'wx' });
      console.log('Temporary transport key ready; private key remains on this host.');
    } else if (mode === 'seal' && a && b && c) {
      const values = runtimeFromValues(parseEnv(readFileSync(a, 'utf8')));
      writeFileSync(c, sealRuntime(readFileSync(b, 'utf8'), serializeRuntime(values)), {
        mode: 0o600,
        flag: 'wx',
      });
      console.log(
        'Allowlisted runtime configuration encrypted; no plaintext configuration file created.',
      );
    } else if (mode === 'seal-invitation' && a && b && c) {
      const hash = invitationFromText(readFileSync(a, 'utf8'));
      writeFileSync(
        c,
        sealRuntime(readFileSync(b, 'utf8'), serializeRuntime({ MIRA_PASSWORD_HASH: hash })),
        { mode: 0o600, flag: 'wx' },
      );
      console.log('Invitation hash encrypted; plaintext password was not read.');
    } else if (mode === 'import-invitation' && a && b && c) {
      if (
        process.getuid?.() !== 0 ||
        statSync(a).mode & 0o077 ||
        lstatSync(c).isSymbolicLink() ||
        statSync(c).mode & 0o077 ||
        statSync(c).uid !== 0
      )
        throw new Error('File permissions');
      const hash = invitationFromText(
        openRuntime(readFileSync(a, 'utf8'), readFileSync(b, 'utf8')),
      );
      const existing = parseEnv(readFileSync(c, 'utf8'));
      if (existing.MIRA_PASSWORD_HASH) throw new Error('Invitation already set');
      const text = serializeRuntime({ ...runtimeFromValues(existing), MIRA_PASSWORD_HASH: hash });
      writeFileSync(c + '.mira-pending', text, { mode: 0o600, flag: 'wx' });
      renameSync(c + '.mira-pending', c);
      unlinkSync(a);
      unlinkSync(b);
      console.log(
        'Invitation hash installed; service readiness remains an explicit separate step.',
      );
    } else if (mode === 'import' && a && b && c) {
      if (process.getuid?.() !== 0 || statSync(a).mode & 0o077)
        throw new Error('Private key permissions');
      if (existsSync(c)) throw new Error('Destination already exists');
      const text = openRuntime(readFileSync(a, 'utf8'), readFileSync(b, 'utf8')),
        values = parseEnv(text);
      const canonical = runtimeFromValues(values);
      if (values.MIRA_PASSWORD_HASH !== '' || serializeRuntime(canonical) !== text)
        throw new Error('Unexpected runtime');
      writeFileSync(c, text, { mode: 0o600, flag: 'wx' });
      chmodSync(c, 0o600);
      unlinkSync(a);
      unlinkSync(b);
      console.log(
        'Runtime installed with mode 600; invitation remains unset; temporary private key and envelope removed.',
      );
    } else throw new Error('Invalid operation');
  } catch {
    console.error(
      'Transport operation failed; no secret details are printed. Inspect only file existence/permissions before retrying.',
    );
    process.exitCode = 1;
  }
}
