// Explicit future operator tool. Not imported by the application or test runner.
// Password comes only from a hidden interactive TTY, never argv or environment.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
if (
  process.argv.length !== 4 ||
  process.argv[2] !== '--output' ||
  !process.stdin.isTTY ||
  !process.stdout.isTTY
) {
  console.error(
    'Run in your own terminal: node scripts/create-invitation.mjs --output .env.invitation',
  );
  process.exit(1);
}
const output = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
try {
  process.stdout.write('Invitation password (12–256 characters; hidden): ');
  let password = await rl.question('');
  process.stdout.write('\nConfirm password (hidden): ');
  const confirmation = await rl.question('');
  process.stdout.write('\n');
  if (password.length < 12 || password.length > 256 || password !== confirmation)
    throw new Error('Invalid password');
  const salt = randomBytes(16),
    hash = scryptSync(password, salt, 64);
  password = '';
  await writeFile(
    resolve(process.argv[3]),
    'MIRA_PASSWORD_HASH=scrypt$' + salt.toString('hex') + '$' + hash.toString('hex') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    'Password hash saved privately. No plaintext password was saved. Keep the output out of Git.',
  );
} catch {
  console.error(
    'No credential created: input mismatch/length, cancellation, existing output, or file access error.',
  );
  process.exitCode = 1;
} finally {
  rl.close();
}
