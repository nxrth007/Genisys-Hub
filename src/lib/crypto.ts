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
  // Copy into a plain Uint8Array (not a Buffer view) so downstream consumers
  // like Prisma's Bytes field get the exact type they expect.
  return Uint8Array.from(key)
}

export function encryptSecret(plaintext: string): {
  ciphertext: Uint8Array<ArrayBuffer>
  nonce: Uint8Array<ArrayBuffer>
} {
  const key = getMasterKey()
  const nonce = new Uint8Array(randomBytes(24))
  const cipher = xchacha20poly1305(key, nonce)
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext))
  // Wrap in a fresh Uint8Array so the type is Uint8Array<ArrayBuffer> (what
  // Prisma's Bytes field expects) rather than Uint8Array<ArrayBufferLike>.
  return {
    ciphertext: new Uint8Array(encrypted),
    nonce,
  }
}

export function decryptSecret(
  ciphertext: Uint8Array | Buffer,
  nonce: Uint8Array | Buffer
): string {
  const key = getMasterKey()
  // Normalize inputs — Prisma returns Buffers for Bytes fields.
  const ct = ciphertext instanceof Uint8Array && !Buffer.isBuffer(ciphertext)
    ? ciphertext
    : Uint8Array.from(ciphertext)
  const nc = nonce instanceof Uint8Array && !Buffer.isBuffer(nonce)
    ? nonce
    : Uint8Array.from(nonce)

  const cipher = xchacha20poly1305(key, nc)
  const plaintext = cipher.decrypt(ct)
  return new TextDecoder().decode(plaintext)
}
