/**
 * SAMPLE DATA for the Office's dev-only demo mode (?demo=1). Never served
 * in production unless OFFICE_DEMO_ENABLED=1 is set explicitly; the UI
 * labels it as sample data. Times are relative to `now` so the scene is
 * always "live"-looking, and they shift a little each minute so bots move.
 */
import { deriveOffice, type OfficeInput, type OfficeState } from './mapping'

export function officeDemoAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.OFFICE_DEMO_ENABLED === '1'
}

export function demoInput(now: Date): OfficeInput {
  const m = (min: number) => new Date(now.getTime() - min * 60_000)
  // Rotate which sample client is mid-handoff every 2 minutes.
  const phase = Math.floor(now.getTime() / 120_000) % 3
  const clients = ['Sample Solar Co', 'Demo Roofing LLC', 'Example HVAC']
  const c = clients[phase]
  return {
    journeyEvents: [
      { id: `d1-${phase}`, clientId: `c${phase}`, clientName: c, stage: 'intake', fromStatus: 'in_progress', toStatus: 'done', note: 'Intake (sample)', actor: 'system', createdAt: m(3) },
      { id: `d2-${phase}`, clientId: `c${phase}`, clientName: c, stage: 'subaccount', fromStatus: 'pending', toStatus: 'in_progress', note: null, actor: 'system', createdAt: m(3) },
      { id: 'd3', clientId: 'cx', clientName: 'Sample Plumbing', stage: 'website', fromStatus: 'pending', toStatus: 'in_progress', note: null, actor: 'system', createdAt: m(6) },
      { id: 'd4', clientId: 'cy', clientName: 'Demo Electric', stage: 'signup', fromStatus: null, toStatus: 'done', note: 'Whop membership mem_sample', actor: 'whop-webhook', createdAt: m(9) },
      { id: 'd5', clientId: 'cz', clientName: 'Example Pools', stage: 'a2p', fromStatus: 'pending', toStatus: 'in_progress', note: null, actor: 'system', createdAt: m(14) },
      { id: 'd6', clientId: 'cw', clientName: 'Sample Landscaping', stage: 'qa', fromStatus: 'in_progress', toStatus: 'done', note: null, actor: 'system', createdAt: m(55) },
    ],
    openStages: [{ clientId: 'cv', clientName: 'Demo Painting', stage: 'website', status: 'blocked', note: 'Waiting on domain access (sample)', updatedAt: m(40) }],
    intakes: [{ id: 'i1', receivedAt: m(2), status: 'new', name: 'Sample Solar Co' }],
    whopClaims: [{ membershipId: 'mem_sample', source: 'webhook', claimedAt: m(9) }],
    matchSuggestions: [],
    seoRuns: [
      { id: 's1', siteName: 'sample-site.com', status: 'running', stage: 'write', error: null, startedAt: m(4), finishedAt: null, createdAt: m(4), updatedAt: m(1) },
      { id: 's2', siteName: 'demo-site.com', status: 'failed', stage: 'research', error: 'blocked: LLM key missing (sample)', startedAt: m(70), finishedAt: m(65), createdAt: m(70), updatedAt: m(65) },
    ],
    a2p: [{ id: 'a1', accountName: 'Example Pools', stage: 'brand_pending', note: null, updatedAt: m(14) }],
    render: { enabled: true, heartbeatFailures: 0, openProblems: 0, lastDigestAt: m(30) },
  }
}

export function demoState(now = new Date()): OfficeState {
  return deriveOffice(demoInput(now), now, { demo: true })
}
