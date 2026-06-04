/**
 * Daily cron job: delete chat attachments older than
 * CHAT_PHOTO_EXPIRY_DAYS (30 days). Text messages are kept
 * forever — only the bytea bloat gets pruned.
 *
 * Called from scheduler.ts once per UTC day during a fixed hour
 * (same pattern as the PPA invoicing tick). Safe to fire multiple
 * times in the same window — the WHERE clause makes the second
 * run a no-op after the first deletes the cutoff window.
 */

import { prisma } from './prisma'
import { CHAT_PHOTO_EXPIRY_DAYS } from './team-chat'

export async function expireOldChatAttachments(): Promise<{
  deleted: number
}> {
  const cutoff = new Date(
    Date.now() - CHAT_PHOTO_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  )
  const result = await prisma.chatAttachment.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })
  if (result.count > 0) {
    console.log(
      `[chat-attachment-expiry] deleted ${result.count} chat attachments older than ${CHAT_PHOTO_EXPIRY_DAYS} days`,
    )
  }
  return { deleted: result.count }
}
