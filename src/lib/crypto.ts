/**
 * Vault encryption — XChaCha20-Poly1305 AEAD via @noble/ciphers.
 *
 * Every vault entry gets a fresh 24-byte random nonce. The ciphertext includes
 * a 16-byte Poly1305 auth tag at the end — any tampering will fail decryption.
 *
 * The master key is read from process.env.VAULT_MASTER_KEY (base64, 32 bytes).
 * If the master key changes or is lost, existing entries become unrecoverable.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from 'crypto'

function getMasterKey(): Uint8Array {
  const raw = process.env.VAULT_MASTER_KEY
  if (!raw) {
    throw new Error(
      'VAULT_MASTER_KEY is not set. Generate a 32-byte key: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(`VAULT_MASTER_KEY must decode to 32 bytes, got ${key.length}`)
  }
  return new Uint8Array(key)
}

export function encryptSecret(plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
  const key = getMasterKey()
  const nonce = new Uint8Array(randomBytes(24))
  const cipher = xchacha20poly1305(key, nonce)
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext))
  return {
    ciphertext: Buffer.from(ciphertext),
    nonce: Buffer.from(nonce),
  }
}

export function decryptSecret(ciphertext: Buffer | Uint8Array, nonce: Buffer | Uint8Array): string {
  const key = getMasterKey()
  const cipher = xchacha20poly1305(key, new Uint8Array(nonce))
  const plaintext = cipher.decrypt(new Uint8Array(ciphertext))
  return new TextDecoder().decode(plaintext)
}
