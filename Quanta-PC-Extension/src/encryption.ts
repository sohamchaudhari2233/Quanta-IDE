import * as crypto from 'crypto';

export interface EncryptedPayload {
  v: number;
  alg: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function isEncryptedPayload(obj: any): obj is EncryptedPayload {
  return obj && obj.v === 1 && obj.alg === 'aes-256-gcm' && typeof obj.ciphertext === 'string';
}

export function encryptTranscript(plaintext: string, passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    v: 1,
    alg: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex')
  };

  return JSON.stringify(payload, null, 2);
}

export function decryptTranscript(rawJson: string, passphrase: string): string {
  const payload = JSON.parse(rawJson);
  if (!isEncryptedPayload(payload)) {
    // If not encrypted, return as is
    return rawJson;
  }

  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');

  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

