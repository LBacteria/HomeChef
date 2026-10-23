import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
export const randomUUID = () => crypto.randomUUID();
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw Error('Unsupported digest');
  let content = '';
  return { update(value: string) { content += value; return this; }, digest(format: string) { if (format !== 'hex') throw Error('Unsupported digest format'); return bytesToHex(sha256(utf8ToBytes(content))); } };
}
