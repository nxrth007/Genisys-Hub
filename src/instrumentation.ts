/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * We use this to kick off the in-process cron scheduler. Only runs
 * in the Node runtime (not Edge), which is where our middleware and
 * API routes execute.
 */
export async function register() {
  // Only start the scheduler on the Node server, not during builds or
  // in Edge workers.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initScheduler } = await import('./lib/scheduler')
    initScheduler()
  }
}
