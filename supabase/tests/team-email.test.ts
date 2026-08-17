// @vitest-environment node
/**
 * The invitation delivery adapter.
 *
 * Three things are worth testing here and they are all failure modes rather than
 * features: an agency name must not be able to write markup into an email this
 * product signs its name to, an invitation link must never point anywhere but
 * the configured application, and "sent" must never be claimed for a message a
 * provider refused or never saw.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  buildAcceptUrl,
  deliverInvitation,
  escapeHtml,
  resolveAppOrigin,
  type InvitationMessage,
} from '../functions/_shared/team-email.ts'

const message: InvitationMessage = {
  to: 'recruit@example.test',
  organizationName: 'Atlas Rentals',
  inviterName: 'Sara Bennani',
  roleLabel: 'Manager',
  acceptUrl: 'https://app.example.test/accept-invite#token=abc',
  expiresAt: '2026-09-01',
  locale: 'en',
}

const configured = { provider: 'resend', apiKey: 'key', from: 'Atlas <no-reply@example.test>' }

describe('untrusted text in an email', () => {
  it('escapes every character that could open a tag or close an attribute', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">& more`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp; more',
    )
  })

  it('does not put an agency name into the message as markup', async () => {
    let sent = ''
    const send = vi.fn((_url: string, init?: RequestInit) => {
      sent = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    await deliverInvitation(
      { ...message, organizationName: '<script>steal()</script>' },
      configured,
      send as unknown as typeof fetch,
    )

    const body = JSON.parse(sent) as { html: string; text: string; subject: string }
    expect(body.html).not.toContain('<script>')
    expect(body.html).toContain('&lt;script&gt;')
    // The plain-text part is not markup, so it is not escaped — and must not be
    // fed back into the HTML part.
    expect(body.text).toContain('<script>steal()</script>')
  })

  it('escapes an inviter name and the link itself', async () => {
    let sent = ''
    const send = vi.fn((_url: string, init?: RequestInit) => {
      sent = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    await deliverInvitation(
      {
        ...message,
        inviterName: '" onmouseover="x',
        acceptUrl: 'https://app.example.test/accept-invite#token=a"b',
      },
      configured,
      send as unknown as typeof fetch,
    )

    const body = JSON.parse(sent) as { html: string }
    expect(body.html).not.toMatch(/onmouseover="x/)
    expect(body.html).not.toMatch(/href="[^"]*"[a-z]/i)
  })
})

describe('the application origin', () => {
  it('accepts a plain https origin', () => {
    expect(resolveAppOrigin('https://app.example.test')?.origin).toBe('https://app.example.test')
    expect(resolveAppOrigin('  https://app.example.test/  ')?.origin).toBe(
      'https://app.example.test',
    )
  })

  it('accepts http only on the loopback, for local development', () => {
    expect(resolveAppOrigin('http://localhost:5173')?.origin).toBe('http://localhost:5173')
    expect(resolveAppOrigin('http://127.0.0.1:4173')?.origin).toBe('http://127.0.0.1:4173')
    expect(resolveAppOrigin('http://app.example.test')).toBeNull()
  })

  it('refuses everything that could redirect somewhere else', () => {
    for (const candidate of [
      undefined,
      '',
      'not a url',
      // Credentials in the authority are the classic way to make a hostile host
      // read as a familiar one.
      'https://app.example.test:pass@evil.example',
      'https://user@evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>',
      // A configured value carrying its own query or fragment would append to,
      // or overwrite, the token this function is about to put there.
      'https://app.example.test/?next=https://evil.example',
      'https://app.example.test/#token=stolen',
    ]) {
      expect(resolveAppOrigin(candidate), String(candidate)).toBeNull()
    }
  })

  it('puts the token in the fragment, never the query string', () => {
    const url = new URL(buildAcceptUrl(new URL('https://app.example.test'), 'tok en/+='))

    expect(url.origin).toBe('https://app.example.test')
    expect(url.pathname).toBe('/accept-invite')
    expect(url.search).toBe('')
    expect(url.hash).toBe('#token=tok%20en%2F%2B%3D')
    // A fragment is never sent to a server, which is the whole point.
    expect(url.toString()).not.toContain('?')
  })

  it('ignores any path on the configured origin', () => {
    const url = new URL(buildAcceptUrl(new URL('https://app.example.test/somewhere'), 'abc'))
    expect(url.pathname).toBe('/accept-invite')
  })
})

describe('what delivery claims', () => {
  it('says not configured rather than failing when no provider is set', async () => {
    const result = await deliverInvitation(message, {
      provider: undefined,
      apiKey: undefined,
      from: undefined,
    })
    expect(result.state).toBe('not_configured')
  })

  it('fails loudly when a provider is named but not usable', async () => {
    expect(
      (await deliverInvitation(message, { provider: 'resend', apiKey: undefined, from: 'a@b.test' }))
        .state,
    ).toBe('failed')
    expect(
      (await deliverInvitation(message, { provider: 'postal-pigeon', apiKey: 'k', from: 'a@b.test' }))
        .state,
    ).toBe('failed')
  })

  it('never claims receipt when the provider merely accepted the message', async () => {
    const send = vi.fn(() => Promise.resolve(new Response('{"id":"1"}', { status: 202 })))
    const result = await deliverInvitation(message, configured, send)

    expect(result.state).toBe('accepted_by_provider')
    expect(result.detail).toMatch(/not confirmed/i)
    expect(result.detail).not.toMatch(/delivered|received/i)
  })

  it('reports a refusal as failed and repeats nothing the provider said', async () => {
    const send = vi.fn(() =>
      // A provider error body commonly echoes the request, and the request
      // contained the invitation link.
      Promise.resolve(new Response(JSON.stringify({ message: message.acceptUrl }), { status: 422 })),
    )
    const result = await deliverInvitation(message, configured, send)

    expect(result.state).toBe('failed')
    expect(result.detail).toContain('422')
    expect(result.detail).not.toContain('token=')
    expect(result.detail).not.toContain('accept-invite')
  })

  it('reports an unreachable provider without echoing the request', async () => {
    const send = vi.fn(() =>
      Promise.reject(new Error(`connect ECONNREFUSED while POSTing ${message.acceptUrl}`)),
    )
    const result = await deliverInvitation(message, configured, send)

    expect(result.state).toBe('failed')
    expect(result.detail).not.toContain('token=')
  })

  it('sends the token nowhere but the recipient', async () => {
    let captured: { url: string; body: string } = { url: '', body: '' }
    const send = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, body: typeof init?.body === 'string' ? init.body : '' }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    await deliverInvitation(message, configured, send as unknown as typeof fetch)

    expect(captured.url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(captured.body) as { to: string[] }
    expect(body.to).toEqual(['recruit@example.test'])
  })
})
