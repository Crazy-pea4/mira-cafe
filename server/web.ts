import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { withBasePath } from '../shared/base-path';
export async function registerWeb(app: FastifyInstance, root: string, basePath = '') {
  const manifest = JSON.parse(readFileSync(resolve(root, 'mira-build.json'), 'utf8'));
  if (manifest.basePath !== basePath) throw new Error('Client and server base paths do not match');
  await app.register(staticPlugin, {
    root: resolve(root),
    prefix: withBasePath(basePath, ''),
    index: 'index.html',
    dotfiles: 'deny',
    cacheControl: false,
  });
}
