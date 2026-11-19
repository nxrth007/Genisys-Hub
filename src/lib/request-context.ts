import { AsyncLocalStorage } from 'node:async_hooks'

/** IP and user agent for the HTTP request currently handling a sign-in. */
export const requestContext = new AsyncLocalStorage<{ ip: string; userAgent: string | null }>()
