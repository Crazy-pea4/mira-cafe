import type { KeyObject } from 'node:crypto';
type TransportKey = string | Buffer | KeyObject;
export function runtimeFromValues(
  values: Record<string, string | undefined>,
): Record<string, string>;
export function serializeRuntime(values: Record<string, string>): string;
export function sealRuntime(publicKey: TransportKey, plaintext: string): string;
export function openRuntime(privateKey: TransportKey, envelope: string): string;
export function invitationFromText(text: string): string;
