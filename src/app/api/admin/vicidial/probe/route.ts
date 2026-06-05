import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/admin/vicidial/probe
 *
 * Diagnostic that fires several variant requests against
 * Vicidial's API endpoints to figure out which combination of
 * (URL, method, parameter name, function name) the BPO actually
 * accepts. The non_agent_api `version` function is the canonical
 * smoke test — it requires no special permission and returns a
 * short success body — so if any variant returns SUCCESS for
 * version, we know that variant is the working one.
 *
 * Admin-only. One-shot diagnostic; not cached.
 */

const VICIDIAL_BASE = 'https://expeditusbpo.vicitel.cc/vicidial'
const ALT_BASE = 'https://expeditusbpo.vicitel.cc/agc'

const USER_AGENT =
  'Mozilla/5.0 (Hub-Scraper) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

type Probe = {
  label: string
  url: string
  method: 'GET' | 'POST'
  params: Record<string, string>
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const username = (await getSecretByName('Vicidial Admin Username')).trim()
  const password = (await getSecretByName('Vicidial Admin Password')).trim()
  const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')

  // Six probes. Each tries the `version` function — it returns
  // "VERSION: 2.14-X" on success, doesn't require user_level, and
  // is the canonical smoke test in Vicidial docs.
  const probes: Probe[] = [
    {
      label: 'A — GET non_agent_api function=version',
      url: `${VICIDIAL_BASE}/non_agent_api.php`,
      method: 'GET',
      params: {
        source: 'hub',
        user: username,
        pass: password,
        function: 'version',
      },
    },
    {
      label: 'B — POST non_agent_api function=version',
      url: `${VICIDIAL_BASE}/non_agent_api.php`,
      method: 'POST',
      params: {
        source: 'hub',
        user: username,
        pass: password,
        function: 'version',
      },
    },
    {
      label: 'C — GET non_agent_api action=version (alt param)',
      url: `${VICIDIAL_BASE}/non_agent_api.php`,
      method: 'GET',
      params: {
        source: 'hub',
        user: username,
        pass: password,
        action: 'version',
      },
    },
    {
      label: 'D — GET agc/api.php function=version',
      url: `${ALT_BASE}/api.php`,
      method: 'GET',
      params: {
        source: 'hub',
        user: username,
        pass: password,
        function: 'version',
      },
    },
    {
      label: 'E — GET admin_api.php function=version',
      url: `${VICIDIAL_BASE}/admin_api.php`,
      method: 'GET',
      params: {
        source: 'hub',
        user: username,
        pass: password,
        function: 'version',
      },
    },
    {
      label: 'F — GET non_agent_api function=version (no basic auth)',
      url: `${VICIDIAL_BASE}/non_agent_api.php`,
      method: 'GET',
      params: {
        source: 'hub',
        user: username,
        pass: password,
        function: 'version',
      },
    },
  ]

  const results = await Promise.all(
    probes.map(async (p) => {
      try {
        const headers: Record<string, string> = {
          'User-Agent': USER_AGENT,
          Accept: 'text/plain',
        }
        // Probe F: no Authorization header — to see if the outer
        // web-server Basic auth is what's mangling the body. All
        // other probes include it.
        if (p.label !== 'F — GET non_agent_api function=version (no basic auth)') {
          headers.Authorization = `Basic ${basicAuth}`
        }

        let res: Response
        if (p.method === 'GET') {
          const qs = new URLSearchParams(p.params).toString()
          res = await fetch(`${p.url}?${qs}`, { headers })
        } else {
          headers['Content-Type'] = 'application/x-www-form-urlencoded'
          res = await fetch(p.url, {
            method: 'POST',
            headers,
            body: new URLSearchParams(p.params).toString(),
          })
        }

        const bodyText = await res.text()
        return {
          label: p.label,
          url: p.url,
          method: p.method,
          status: res.status,
          contentType: res.headers.get('content-type'),
          bodyPreview: bodyText.slice(0, 500),
          bodyLength: bodyText.length,
        }
      } catch (err) {
        return {
          label: p.label,
          url: p.url,
          method: p.method,
          status: -1,
          contentType: null,
          bodyPreview: err instanceof Error ? err.message : String(err),
          bodyLength: 0,
        }
      }
    }),
  )

  return NextResponse.json(
    { results },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
