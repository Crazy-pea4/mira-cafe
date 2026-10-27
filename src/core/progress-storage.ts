import { appPath } from './app-path';
import { progressSchema, type SavedProgress } from '../../shared/progress';
export type { SavedProgress } from '../../shared/progress';
export interface ProgressStorage {
  load(): SavedProgress | null;
  save(progress: SavedProgress): void;
  clear(): void;
}

export class LocalProgressStorage implements ProgressStorage {
  private key = 'mira-cafe:progress:v1:' + appPath();
  constructor(private storage: () => Storage = () => window.localStorage, private initial?: SavedProgress | null) {}
  load() {
    if (this.initial !== undefined) return this.initial;
    const value = this.storage().getItem(this.key);
    if (!value) return null;
    if (value.length > 48000) throw new Error('Invalid save');
    return progressSchema.parse(JSON.parse(value));
  }
  save(progress: SavedProgress) {
    this.storage().setItem(this.key, JSON.stringify(progress));
  }
  clear() {
    this.storage().removeItem(this.key);
  }
}
