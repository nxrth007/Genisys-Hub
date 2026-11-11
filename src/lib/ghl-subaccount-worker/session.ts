/**
 * The GHL browser session (Playwright storageState) and a one-time
 * verification code, encrypted with the same VAULT_MASTER_KEY as the
 * Vault. Cookies are credentials; they don't sit in plaintext in
 * AppSetting.
 */
import { decryptSecret, encryptSecret } from '@/lib/crypto'

export function sealString(plaintext: string): string {
  const { ciphertext, nonce } = encryptSecret(plaintext)
  return JSON.stringify({
    c: Buffer.from(ciphertext).toString('base64'),
    n: Buffer.from(nonce).toString('base64'),
  })
}

export function openString(sealed: string | null | undefined): string | null {
  if (!sealed?.trim()) return null
  try {
    const parsed = JSON.parse(sealed) as { c?: unknown; n?: unknown }
    if (typeof parsed.c !== 'string' || typeof parsed.n !== 'string') return null
    return decryptSecret(Buffer.from(parsed.c, 'base64'), Buffer.from(parsed.n, 'base64'))
  } catch {
    return null
  }
}
