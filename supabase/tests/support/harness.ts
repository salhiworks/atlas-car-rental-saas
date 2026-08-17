/**
 * Executes the real migrations against a throwaway PostgreSQL instance so the
 * schema's security and integrity guarantees can be asserted, not assumed.
 *
 * PGlite is PostgreSQL compiled to WebAssembly — a genuine Postgres backend,
 * not a simulator — so exclusion constraints, RLS, triggers and generated
 * columns all behave exactly as they will in production.
 *
 * Two differences from a live Supabase project are worth keeping in mind when
 * reading a passing run:
 *   - `auth` and `storage` are test doubles (see supabase-doubles.sql).
 *   - PGlite tracks a newer PostgreSQL major than Supabase currently runs.
 * Neither affects the semantics exercised here.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
// Invitation tokens come from pgcrypto's CSPRNG, so the extension has to be
// genuinely present here — a stub would make the entropy of a bearer secret
// something the tests never look at.
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

const here = path.dirname(fileURLToPath(import.meta.url))
const supabaseDir = path.resolve(here, '../..')

export const MIGRATIONS_DIR = path.join(supabaseDir, 'migrations')
const DOUBLES_PATH = path.join(supabaseDir, 'tests/support/supabase-doubles.sql')

export type QueryResult<T> = { rows: T[] }

/** Every migration file, in the order the Supabase CLI would apply them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
}

export class TestDatabase {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<TestDatabase> {
    const db = await PGlite.create({ extensions: { btree_gist, pg_trgm, pgcrypto } })

    await db.exec(readFileSync(DOUBLES_PATH, 'utf8'))
    for (const file of migrationFiles()) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    }

    return new TestDatabase(db)
  }

  /** Runs SQL with the ambient superuser identity (RLS does not apply). */
  async sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(query, params)
    return result.rows
  }

  async exec(query: string): Promise<void> {
    await this.db.exec(query)
  }

  /**
   * Runs `fn` as the `authenticated` Postgres role with `auth.uid()` resolving
   * to `userId` — the same position a browser request occupies. RLS applies.
   */
  async asUser<T>(userId: string, fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    await this.db.exec(`set request.jwt.claim.sub = '${userId}'; set role authenticated;`)
    try {
      return await fn(this)
    } finally {
      await this.db.exec(`reset role; reset request.jwt.claim.sub;`)
    }
  }

  /**
   * Runs `fn` as `service_role` with auth.uid() resolving to `userId`.
   *
   * That role keeps its table grants and bypasses row-level security, so it is
   * where app.guard_membership_changes() is still the operative control now that
   * `authenticated` has no direct write path to organization_members at all. An
   * Edge Function that reached for the service key and skipped the Team
   * functions would land exactly here.
   */
  async asServiceRole<T>(userId: string, fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    await this.db.exec(`set request.jwt.claim.sub = '${userId}'; set role service_role;`)
    try {
      return await fn(this)
    } finally {
      await this.db.exec(`reset role; reset request.jwt.claim.sub;`)
    }
  }

  /** Runs `fn` as the unauthenticated `anon` role. */
  async asAnon<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    await this.db.exec(`reset request.jwt.claim.sub; set role anon;`)
    try {
      return await fn(this)
    } finally {
      await this.db.exec(`reset role;`)
    }
  }

  /** Asserts that a statement is rejected, and returns the error message. */
  async expectRejection(
    run: () => Promise<unknown>,
    matcher?: RegExp,
  ): Promise<string> {
    let message: string | null = null
    try {
      await run()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    if (message === null) {
      throw new Error('Expected the statement to be rejected, but it succeeded.')
    }
    if (matcher && !matcher.test(message)) {
      throw new Error(`Rejection message ${JSON.stringify(message)} did not match ${matcher}`)
    }
    return message
  }

  async close(): Promise<void> {
    await this.db.close()
  }
}

export interface SeededAgency {
  userId: string
  organizationId: string
}

/**
 * Simulates a Supabase sign-up: GoTrue inserts into auth.users with the sign-up
 * metadata, and the on_auth_user_created trigger does the rest.
 */
export async function signUp(
  db: TestDatabase,
  options: {
    email: string
    fullName?: string
    organizationName?: string
    currency?: string
    timeZone?: string
    countryCode?: string
  },
): Promise<{ userId: string; organizationId: string | null }> {
  const metadata: Record<string, string> = {}
  if (options.fullName) metadata.full_name = options.fullName
  if (options.organizationName) metadata.organization_name = options.organizationName
  if (options.currency) metadata.default_currency = options.currency
  if (options.timeZone) metadata.time_zone = options.timeZone
  if (options.countryCode) metadata.country_code = options.countryCode

  const [user] = await db.sql<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
    [options.email, JSON.stringify(metadata)],
  )
  if (!user) throw new Error('Sign-up did not return a user.')

  const [membership] = await db.sql<{ organization_id: string }>(
    `select organization_id from public.organization_members where user_id = $1`,
    [user.id],
  )

  return { userId: user.id, organizationId: membership?.organization_id ?? null }
}

/** Adds an existing user to an organization with a given role. */
export async function addMember(
  db: TestDatabase,
  organizationId: string,
  userId: string,
  role: 'owner' | 'admin' | 'manager' | 'staff',
): Promise<void> {
  await db.sql(
    `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)`,
    [organizationId, userId, role],
  )
}
