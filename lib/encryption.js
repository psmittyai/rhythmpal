'use strict';

/**
 * Token encryption service — AES-256-GCM
 * Format: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 *
 * SECURITY RULES:
 * - Never log plaintext tokens, keys, or decrypted values
 * - Never generate a fallback key; fail loudly if key is missing or wrong length
 * - Key source: process.env.WEARABLE_TOKEN_KEY (32-byte hex = 64 chars)
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV for GCM
const KEY_HEX_LENGTH = 64; // 32 bytes = 64 hex chars
const VERSION = 'v1';

/**
 * Resolve and validate the encryption key.
 * Throws if missing or wrong length — never silently falls back.
 * @returns {Buffer}
 */
function getKey() {
  const hex = process.env.WEARABLE_TOKEN_KEY;
  if (!hex || typeof hex !== 'string') {
    throw new Error(
      'WEARABLE_TOKEN_KEY is not set. Set a 64-char hex string (32 bytes) in your environment.'
    );
  }
  if (hex.length !== KEY_HEX_LENGTH) {
    throw new Error(
      `WEARABLE_TOKEN_KEY must be exactly ${KEY_HEX_LENGTH} hex characters (32 bytes). Got ${hex.length} characters.`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {string} packed — "v1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string argument');
  }
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a packed ciphertext string.
 * @param {string} packed — "v1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 * @returns {string} plaintext
 */
function decrypt(packed) {
  if (typeof packed !== 'string') {
    throw new TypeError('decrypt() requires a string argument');
  }
  const parts = packed.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted token format — expected v1:<iv>:<tag>:<ciphertext>');
  }
  const [version, ivHex, tagHex, ciphertextHex] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
