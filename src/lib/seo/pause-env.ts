/** Truthy env values, matching SUBACCOUNT_AUTOLINK_ENABLED in scheduler.ts. */
const ON = ['on', 'true', '1', 'yes', 'enabled']

/** Whether an env value (e.g. SEO_PAUSED) means "on". Unset/empty/anything else = off. */
export function envFlagOn(value: string | undefined | null): boolean {
  return ON.includes((value ?? '').trim().toLowerCase())
}

/** The SEO_PAUSED env var, read live (sync and cheap). */
export function seoPausedByEnv(): boolean {
  return envFlagOn(process.env.SEO_PAUSED)
}
