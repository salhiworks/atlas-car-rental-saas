/**
 * Deletes one agency and everything it owns, including its private files.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
 *     node scripts/delete-organization.mjs <organization-id> --confirm "Exact Agency Name"
 *
 * WHO CAN RUN THIS
 *
 * Only somebody holding the project's service-role key, which lives in the
 * operator's shell for the length of one command and nowhere else. It is never
 * read from `.env.local` — that file holds the browser's anon key, and a script
 * that quietly accepted a VITE_ variable would be one paste away from putting a
 * privileged key somewhere it gets committed. No part of this is reachable from
 * the application: the browser has no delete path to an agency, and this adds
 * none.
 *
 * WHAT IT REFUSES
 *
 *   * A missing or malformed organization id.
 *   * An id that resolves to no agency.
 *   * A `--confirm` name that does not match the agency's own name exactly.
 *     Deleting a tenant is not a thing to get right by luck.
 *   * Any object path whose first segment is not the agency being deleted,
 *     whatever the listing returned.
 *
 * ORDER AND FAILURE SEMANTICS
 *
 * Storage first, database second, both idempotent — see the module comment in
 * `organization-teardown.mjs` for why that order is the only safe one. If any
 * step fails the command stops, says what it did, and can be run again.
 *
 * The database step is a plain delete of the row. Every referencing table
 * cascades from it, and the existing guard still refuses an agency that has a
 * live subscription — this does not bypass it.
 */
import { createClient } from '@supabase/supabase-js'

import {
  ORGANIZATION_BUCKETS,
  countOrganizationObjects,
  isOrganizationId,
  removeOrganizationObjects,
} from './organization-teardown.mjs'

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const [organizationId, ...rest] = process.argv.slice(2)
const confirmIndex = rest.indexOf('--confirm')
const confirmName = confirmIndex === -1 ? null : rest[confirmIndex + 1]

if (!isOrganizationId(organizationId)) {
  fail('Usage: node scripts/delete-organization.mjs <organization-id> --confirm "Agency Name"')
}
if (!confirmName) {
  fail('Pass --confirm "<the agency\'s exact name>". This deletes a tenant and everything in it.')
}

const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  fail(
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. ' +
      'They are deliberately not read from .env.local, which holds the browser key.',
  )
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ---------------------------------------------------------------- 1. identify
const { data: organization, error: readError } = await admin
  .from('organizations')
  .select('id, name')
  .eq('id', organizationId)
  .maybeSingle()

if (readError) fail(`Could not read the agency: ${readError.message}`)
if (!organization) fail(`No agency with id ${organizationId}.`)
if (organization.name !== confirmName) {
  fail(
    `That id is "${organization.name}", not "${confirmName}". Nothing was deleted.`,
  )
}

console.log(`Deleting "${organization.name}" (${organization.id})`)
console.log(`Buckets in scope: ${ORGANIZATION_BUCKETS.join(', ')}\n`)

// ------------------------------------------------------------ 2. private files
const removed = await removeOrganizationObjects(admin.storage, organization.id)
for (const [bucket, count] of Object.entries(removed)) {
  if (count > 0) console.log(`  ${bucket}: ${count} object${count === 1 ? '' : 's'} removed`)
}
const totalRemoved = Object.values(removed).reduce((sum, count) => sum + count, 0)
console.log(`  ${totalRemoved} object${totalRemoved === 1 ? '' : 's'} removed in total`)

const leftBehind = await countOrganizationObjects(admin.storage, organization.id)
if (leftBehind > 0) {
  fail(
    `${leftBehind} object(s) are still stored under this agency. The database row was NOT deleted, ` +
      'so nothing is orphaned — fix the cause and run this again.',
  )
}

// --------------------------------------------------------------- 3. the agency
const { error: deleteError } = await admin
  .from('organizations')
  .delete()
  .eq('id', organization.id)

if (deleteError) {
  fail(
    `The files are gone but the agency row was not deleted: ${deleteError.message}\n` +
      '  Nothing is orphaned. Resolve the cause and run this again — the storage step is a no-op now.',
  )
}

// ------------------------------------------------------------------- 4. verify
const { data: stillThere } = await admin
  .from('organizations')
  .select('id')
  .eq('id', organization.id)
  .maybeSingle()

if (stillThere) fail('The agency row is still present after the delete reported success.')

console.log(`\n✓ "${organization.name}" and its ${totalRemoved} private file(s) are gone.\n`)
