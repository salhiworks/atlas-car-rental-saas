/**
 * Removing an agency's private files when the agency itself is removed.
 *
 * WHY THIS IS A SCRIPT AND NOT A FEATURE
 *
 * There is no organization-deletion workflow in the product, deliberately:
 * `public.organizations` carries SELECT and UPDATE policies for `authenticated`
 * and no DELETE policy at all, so no browser session can delete an agency by any
 * route. Deleting one is an operator act — SQL as a privileged role, or the
 * Supabase dashboard — and the cleanup belongs with the act that exists rather
 * than with a destructive endpoint invented to hang it from. Nothing here is
 * reachable from the browser bundle, and no grant, policy or RPC changes.
 *
 * WHY THE DATABASE CANNOT DO IT ALONE
 *
 * Deleting the row cascades every table that references it, but Storage is not
 * one of them: `storage.protect_delete()` refuses direct SQL deletion of
 * `storage.objects`, and the Storage API is the only supported path. So an
 * agency deleted with SQL alone leaves its objects behind — private and
 * unreachable, since every storage policy keys on a membership of an agency that
 * no longer exists, but retained and paid for.
 *
 * ORDER, AND WHAT HAPPENS WHEN IT BREAKS
 *
 * Storage first, database second. That order is not arbitrary:
 *
 *   * Storage fails, database untouched → the agency still exists, so its
 *     objects are still enumerable and still authorised. Run it again.
 *   * Storage succeeds, database fails → the agency exists with no files. Run it
 *     again: deleting objects that are already gone is a no-op.
 *   * Database first (the wrong order) → if Storage then failed, the objects
 *     would be orphaned permanently, because after the row is gone nothing can
 *     name their owner. That is the defect this module exists to prevent.
 *
 * There is no transaction across PostgreSQL and Storage and there cannot be, so
 * every step is idempotent and the whole thing is safe to re-run until it
 * reports a clean finish.
 */

/**
 * Every bucket whose objects are keyed by agency.
 *
 * Each is private, and each stores under `<organization_id>/…` — the convention
 * `app.organization_id_from_storage_path()` reads and every storage policy in
 * the schema depends on. Read off the live project rather than assumed; a new
 * bucket must be added here at the same time as its policies.
 */
export const ORGANIZATION_BUCKETS = Object.freeze([
  'organization-logos',
  'vehicle-photos',
  'vehicle-documents',
  'customer-documents',
  'rental-documents',
  'expense-receipts',
  'financing-documents',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isOrganizationId(value) {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * The one thing that must never be got wrong.
 *
 * Every path handed to a delete is checked against the agency being removed,
 * whatever produced it. A listing that returned something unexpected, a prefix
 * assembled by hand, a future caller passing a path from somewhere else — all of
 * them stop here rather than at somebody else's files.
 */
export function assertOwnedPath(organizationId, path) {
  if (!isOrganizationId(organizationId)) {
    throw new Error(`Refusing to act on a value that is not an organization id: ${organizationId}`)
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Refusing to delete an empty object path.')
  }

  const segments = path.split('/')

  /*
   * Checking the first segment is not enough on its own. Supabase Storage keys
   * are opaque strings and resolve nothing, so `<org>/../<other>` is a strangely
   * named object rather than an escape — but a delete path should not be the
   * place that depends on that staying true. Anything that reads as traversal,
   * or as a key no upload of ours could have produced, is refused.
   */
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Refusing to delete "${path}": it does not belong to ${organizationId}.`)
  }

  if (segments[0] !== organizationId) {
    throw new Error(`Refusing to delete "${path}": it does not belong to ${organizationId}.`)
  }

  return path
}

/**
 * Every object under one agency's prefix in one bucket.
 *
 * Walks rather than assuming a depth: logos sit at `<org>/logo.png` while a
 * contract sits at `<org>/<rental>/contract-v1.pdf`, and a bucket added later
 * may nest differently again. Supabase reports a folder as an entry with a null
 * id, which is what separates the two cases.
 */
export async function listPrefix(storage, bucket, prefix, pageSize = 100) {
  const found = []
  const queue = [prefix]

  while (queue.length > 0) {
    const current = queue.shift()
    let offset = 0

    for (;;) {
      const { data, error } = await storage
        .from(bucket)
        .list(current, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } })

      if (error) throw new Error(`Listing ${bucket}/${current} failed: ${error.message}`)

      const entries = data ?? []
      for (const entry of entries) {
        const path = `${current}/${entry.name}`
        // A null id is a folder; anything else is an object.
        if (entry.id === null || entry.id === undefined) queue.push(path)
        else found.push(path)
      }

      if (entries.length < pageSize) break
      offset += pageSize
    }
  }

  return found
}

/**
 * Deletes every object an agency owns, across every organization-scoped bucket.
 *
 * Returns what it removed per bucket so the caller can report it and, on a
 * second run, show zero. Never throws for "there was nothing there".
 */
export async function removeOrganizationObjects(storage, organizationId, options = {}) {
  if (!isOrganizationId(organizationId)) {
    throw new Error(`Refusing to act on a value that is not an organization id: ${organizationId}`)
  }

  const buckets = options.buckets ?? ORGANIZATION_BUCKETS
  const batchSize = options.batchSize ?? 100
  const removed = {}

  for (const bucket of buckets) {
    const paths = (await listPrefix(storage, bucket, organizationId, options.pageSize)).map((path) =>
      assertOwnedPath(organizationId, path),
    )

    for (let index = 0; index < paths.length; index += batchSize) {
      const batch = paths.slice(index, index + batchSize)
      const { error } = await storage.from(bucket).remove(batch)
      if (error) throw new Error(`Deleting from ${bucket} failed: ${error.message}`)
    }

    removed[bucket] = paths.length
  }

  return removed
}

/** Whether anything at all is still stored under this agency's prefix. */
export async function countOrganizationObjects(storage, organizationId, options = {}) {
  const buckets = options.buckets ?? ORGANIZATION_BUCKETS
  let total = 0
  for (const bucket of buckets) {
    total += (await listPrefix(storage, bucket, organizationId, options.pageSize)).length
  }
  return total
}
