import { withBasePath } from '../../shared/base-path';
export function appPath(path = '') { return withBasePath(import.meta.env.BASE_URL ?? '/', path); }
