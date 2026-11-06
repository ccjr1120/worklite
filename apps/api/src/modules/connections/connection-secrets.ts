import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const WECHAT_OFFICIAL_ACCOUNT_ID = 'wechat_official_account_personal' as const;

// Keep the existing encryption format so channel and account credentials survive migration.
export function encryptSecret(value: string): string {
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}
