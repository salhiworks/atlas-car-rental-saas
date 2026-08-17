import { PRODUCT_BRAND } from './brand'

/**
 * Environment resolution and validation.
 *
 * The application refuses to start on a bad configuration rather than falling
 * back to sample data. A dashboard that silently shows invented numbers is a
 * worse failure than one that says "not configured yet".
 */

export interface AppEnvironment {
  readonly supabaseUrl: string
  readonly supabaseAnonKey: string
  readonly appName: string
  /**
   * Style document for the fleet map's basemap, or null when none is configured.
   *
   * Deliberately configuration rather than a constant. Map tiles are a metered
   * commercial service: shipping somebody else's demo endpoint would put this
   * product's whole load on an account that never agreed to carry it. With no
   * style configured the map still plots the fleet — it simply says it has no
   * basemap instead of quietly borrowing one.
   */
  readonly mapStyleUrl: string | null
  /** Attribution the basemap's licence requires, shown on the map. */
  readonly mapAttribution: string | null
  /**
   * A replacement for the canonical Stripe setup guide, or null for the default.
   *
   * Public by design: a documentation address, not a credential. Optional, and
   * unset in this build — the Billing page links to the canonical guide in
   * src/lib/config/help-links.ts, so the button is never missing.
   */
  readonly stripeGuideUrl: string | null
}

export interface EnvironmentProblem {
  readonly variable: string
  readonly detail: string
}

export type EnvironmentResult =
  | { readonly status: 'ok'; readonly env: AppEnvironment }
  | { readonly status: 'invalid'; readonly problems: readonly EnvironmentProblem[] }

/*
 * The product's own name, and the fallback when a deployment does not override
 * it. Read from the brand module so the name exists in exactly one place.
 */
const DEFAULT_APP_NAME = PRODUCT_BRAND.name

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null

  const payload = segments[1]
  if (!payload) return null

  try {
    const normalised = payload.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=')
    const parsed: unknown = JSON.parse(atob(padded))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Detects a key that must never reach a browser.
 *
 * Supabase issues two key shapes: legacy JWTs, whose `role` claim states their
 * privilege, and newer prefixed keys (`sb_publishable_` / `sb_secret_`). Both are
 * checked, because pasting the service key into a VITE_ variable is a plausible
 * mistake with unlimited blast radius — it bypasses every RLS policy in the
 * schema for anyone who opens developer tools.
 */
export function isPrivilegedKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true

  const payload = decodeJwtPayload(key)
  return payload?.role === 'service_role'
}

function readVariable(source: Record<string, string | undefined>, name: string): string {
  return (source[name] ?? '').trim()
}

/**
 * An https URL with nothing clever in it.
 *
 * Parsed rather than pattern-matched: `https:/\/evil` and `https://a@b` both look
 * plausible to a regular expression, and one of them is a different host than it
 * appears to be.
 */
function isSafeHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

export function resolveEnvironment(
  source: Record<string, string | undefined> = import.meta.env,
): EnvironmentResult {
  const problems: EnvironmentProblem[] = []

  const supabaseUrl = readVariable(source, 'VITE_SUPABASE_URL')
  const supabaseAnonKey = readVariable(source, 'VITE_SUPABASE_ANON_KEY')

  if (!supabaseUrl) {
    problems.push({
      variable: 'VITE_SUPABASE_URL',
      detail: 'Missing. Copy it from Supabase → Project Settings → API → Project URL.',
    })
  } else {
    let parsed: URL | null
    try {
      parsed = new URL(supabaseUrl)
    } catch {
      parsed = null
    }

    if (!parsed) {
      problems.push({
        variable: 'VITE_SUPABASE_URL',
        detail: `Not a valid URL: ${JSON.stringify(supabaseUrl)}`,
      })
    } else if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      problems.push({
        variable: 'VITE_SUPABASE_URL',
        detail: 'Must use https (http is allowed only for a local Supabase instance).',
      })
    }
  }

  if (!supabaseAnonKey) {
    problems.push({
      variable: 'VITE_SUPABASE_ANON_KEY',
      detail: 'Missing. Copy the anon / publishable key from Supabase → Project Settings → API.',
    })
  } else if (isPrivilegedKey(supabaseAnonKey)) {
    problems.push({
      variable: 'VITE_SUPABASE_ANON_KEY',
      detail:
        'This is a service_role key. It bypasses Row Level Security and must never be exposed to a browser. Use the anon / publishable key instead.',
    })
  }

  const mapStyleUrl = readVariable(source, 'VITE_MAP_STYLE_URL')
  if (mapStyleUrl && !/^https:\/\//i.test(mapStyleUrl)) {
    problems.push({
      variable: 'VITE_MAP_STYLE_URL',
      detail: 'Must be an https URL pointing at a MapLibre style document.',
    })
  }

  /*
   * An overridden Stripe setup guide. Validated rather than trusted: the value
   * ends up in an anchor that opens in a new tab, so a `javascript:` or `data:`
   * URL here would be a scripting hole handed over by configuration. Only https
   * is accepted, and a bad value is reported at startup like any other — the
   * resolver in help-links.ts checks it a second time and falls back rather than
   * rendering it.
   */
  const stripeGuideUrl = readVariable(source, 'VITE_STRIPE_GUIDE_URL')
  if (stripeGuideUrl && !isSafeHttpsUrl(stripeGuideUrl)) {
    problems.push({
      variable: 'VITE_STRIPE_GUIDE_URL',
      detail: 'Must be an https URL pointing at your Stripe setup guide.',
    })
  }

  if (problems.length > 0) {
    return { status: 'invalid', problems }
  }

  return {
    status: 'ok',
    env: {
      supabaseUrl,
      supabaseAnonKey,
      appName: readVariable(source, 'VITE_APP_NAME') || DEFAULT_APP_NAME,
      mapStyleUrl: mapStyleUrl || null,
      mapAttribution: readVariable(source, 'VITE_MAP_ATTRIBUTION') || null,
      stripeGuideUrl: stripeGuideUrl || null,
    },
  }
}

let cached: EnvironmentResult | null = null

export function getEnvironment(): EnvironmentResult {
  cached ??= resolveEnvironment()
  return cached
}

/** For tests only: drops the memoised result. */
export function resetEnvironmentCache(): void {
  cached = null
}

export function getAppName(): string {
  const result = getEnvironment()
  return result.status === 'ok' ? result.env.appName : DEFAULT_APP_NAME
}

export interface BasemapConfiguration {
  readonly styleUrl: string | null
  readonly attribution: string | null
}

/** What the fleet map should draw underneath the vehicles, if anything. */
export function getBasemapConfiguration(): BasemapConfiguration {
  const result = getEnvironment()
  if (result.status !== 'ok') return { styleUrl: null, attribution: null }
  return { styleUrl: result.env.mapStyleUrl, attribution: result.env.mapAttribution }
}

/**
 * A deployment's own Stripe guide, when it has replaced the canonical one.
 *
 * Null is the ordinary answer. The link itself is never absent — the default
 * lives in src/lib/config/help-links.ts, because a known public address should
 * not need configuring before anybody can see it. This is only the override.
 */
export function getStripeGuideOverride(): string | null {
  const result = getEnvironment()
  return result.status === 'ok' ? result.env.stripeGuideUrl : null
}
