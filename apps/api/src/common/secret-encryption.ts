import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM with the workspace secret encryption key. Stored values are
// "<iv>.<authTag>.<ciphertext>" and are only ever decrypted inside the API.
// Fail closed when the deployment key is missing; a public development fallback
// would make encrypted credentials recoverable from the database alone.
function encryptionKey(): Buffer {
  const secret = process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (!secret) throw new Error('SECRET_ENCRYPTION_KEY must be configured before storing secrets.');
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}
