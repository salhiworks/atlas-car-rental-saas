// @vitest-environment node
/**
 * The part of agency deletion that decides which files get deleted.
 *
 * Storage is the one place in this product where a cascade does not reach:
 * deleting an agency removes every row that references it and leaves its private
 * objects in place, because `storage.protect_delete()` refuses SQL deletion and
 * the Storage API is the only way in. The helper these tests cover is what
 * closes that gap, and the thing it must never do is reach outside the tenant it
 * was given — so that is asserted from several directions, including against a
 * listing that lies.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ORGANIZATION_BUCKETS,
  assertOwnedPath,
  countOrganizationObjects,
  isOrganizationId,
  listPrefix,
  removeOrganizationObjects,
} from '../../scripts/organization-teardown.mjs'

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'

/**
 * A storage double shaped like supabase-js: `list` returns immediate children,
 * a folder is an entry with a null id, and `remove` takes full paths.
 */
function storageDouble(objects: Record<string, string[]>) {
  const state = new Map(Object.entries(objects).map(([bucket, paths]) => [bucket, [...paths]]))
  const removals: { bucket: string; paths: string[] }[] = []

  const client = {
    from(bucket: string) {
      return {
        // eslint-disable-next-line @typescript-eslint/require-await
        async list(prefix: string) {
          const paths = state.get(bucket) ?? []
          const children = new Map<string, { name: string; id: string | null }>()
          for (const path of paths) {
            if (!path.startsWith(`${prefix}/`)) continue
            const rest = path.slice(prefix.length + 1)
            const [head, ...tail] = rest.split('/')
            children.set(head!, { name: head!, id: tail.length > 0 ? null : `id-${path}` })
          }
          return { data: [...children.values()], error: null }
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async remove(paths: string[]) {
          removals.push({ bucket, paths })
          state.set(
            bucket,
            (state.get(bucket) ?? []).filter((path) => !paths.includes(path)),
          )
          return { data: null, error: null }
        },
      }
    },
  }

  return { client, state, removals }
}

describe('what counts as an organization id', () => {
  it('accepts a uuid and nothing else', () => {
    expect(isOrganizationId(ALPHA)).toBe(true)
    // The values that would be dangerous if they were ever treated as a prefix.
    for (const wrong of ['', '..', '/', '*', 'null', undefined, null, 42, `${ALPHA}/..`]) {
      expect(isOrganizationId(wrong)).toBe(false)
    }
  })
})

describe('the ownership check', () => {
  it('passes a path belonging to the agency', () => {
    expect(assertOwnedPath(ALPHA, `${ALPHA}/rental/contract.pdf`)).toBe(
      `${ALPHA}/rental/contract.pdf`,
    )
  })

  it('refuses another agency, an empty path and a prefix that merely starts the same', () => {
    expect(() => assertOwnedPath(ALPHA, `${BETA}/rental/contract.pdf`)).toThrow(/does not belong/)
    expect(() => assertOwnedPath(ALPHA, '')).toThrow(/empty/)
    // A path whose first segment is a longer string starting with the id is a
    // different folder, and string-prefix matching would have taken it.
    expect(() => assertOwnedPath(ALPHA, `${ALPHA}-old/logo.png`)).toThrow(/does not belong/)
  })

  it('refuses anything that reads as traversal, even under the right prefix', () => {
    // Storage keys resolve nothing, so these are odd names rather than escapes.
    // A delete path should not be what depends on that.
    for (const path of [`${ALPHA}/..`, `${ALPHA}/../${BETA}/logo.png`, `${ALPHA}//logo.png`, `${ALPHA}/./logo.png`]) {
      expect(() => assertOwnedPath(ALPHA, path)).toThrow(/does not belong/)
    }
  })

  it('refuses to act at all on something that is not an organization id', () => {
    expect(() => assertOwnedPath('not-a-uuid', 'anything/at/all.png')).toThrow(/not an organization id/)
  })
})

describe('finding an agency’s objects', () => {
  it('walks to whatever depth a bucket happens to use', async () => {
    const { client } = storageDouble({
      'organization-logos': [`${ALPHA}/logo-1.png`],
      'rental-documents': [
        `${ALPHA}/rental-a/contract-v1.pdf`,
        `${ALPHA}/rental-a/signature.png`,
        `${ALPHA}/rental-b/contract-v1.pdf`,
      ],
    })

    expect(await listPrefix(client, 'organization-logos', ALPHA)).toEqual([`${ALPHA}/logo-1.png`])
    expect((await listPrefix(client, 'rental-documents', ALPHA)).sort()).toEqual([
      `${ALPHA}/rental-a/contract-v1.pdf`,
      `${ALPHA}/rental-a/signature.png`,
      `${ALPHA}/rental-b/contract-v1.pdf`,
    ])
  })

  it('finds nothing under an agency that stored nothing', async () => {
    const { client } = storageDouble({ 'rental-documents': [`${BETA}/rental-a/contract-v1.pdf`] })
    expect(await listPrefix(client, 'rental-documents', ALPHA)).toEqual([])
  })
})

describe('removing an agency’s objects', () => {
  it('covers every organization-scoped bucket, not just the one with contracts in it', async () => {
    const objects: Record<string, string[]> = {}
    for (const bucket of ORGANIZATION_BUCKETS) objects[bucket] = [`${ALPHA}/${bucket}-file`]
    const { client, state } = storageDouble(objects)

    const removed = await removeOrganizationObjects(client, ALPHA)

    expect(Object.keys(removed).sort()).toEqual([...ORGANIZATION_BUCKETS].sort())
    for (const bucket of ORGANIZATION_BUCKETS) {
      expect(removed[bucket]).toBe(1)
      expect(state.get(bucket)).toEqual([])
    }
  })

  it('leaves another agency’s files exactly where they were', async () => {
    const { client, state, removals } = storageDouble({
      'rental-documents': [
        `${ALPHA}/rental-a/contract-v1.pdf`,
        `${BETA}/rental-z/contract-v1.pdf`,
        `${BETA}/rental-z/signature.png`,
      ],
    })

    await removeOrganizationObjects(client, ALPHA, { buckets: ['rental-documents'] })

    expect(state.get('rental-documents')).toEqual([
      `${BETA}/rental-z/contract-v1.pdf`,
      `${BETA}/rental-z/signature.png`,
    ])
    for (const removal of removals) {
      for (const path of removal.paths) expect(path.startsWith(`${ALPHA}/`)).toBe(true)
    }
  })

  it('refuses the whole run rather than deleting a path the listing should not have returned', async () => {
    // A compromised or buggy listing is the one way a wrong path could arrive,
    // so the guard is checked against exactly that rather than trusted.
    const lying = {
      from: () => ({
        list: vi
          .fn()
          .mockResolvedValueOnce({
            data: [{ name: '..', id: 'id-escape' }],
            error: null,
          })
          .mockResolvedValue({ data: [], error: null }),
        remove: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }

    await expect(
      removeOrganizationObjects(lying, ALPHA, { buckets: ['rental-documents'] }),
    ).rejects.toThrow(/does not belong/)
  })

  it('is safe to run twice, because the second run has nothing to do', async () => {
    const { client } = storageDouble({
      'rental-documents': [`${ALPHA}/rental-a/contract-v1.pdf`],
    })

    const first = await removeOrganizationObjects(client, ALPHA, { buckets: ['rental-documents'] })
    const second = await removeOrganizationObjects(client, ALPHA, { buckets: ['rental-documents'] })

    expect(first['rental-documents']).toBe(1)
    expect(second['rental-documents']).toBe(0)
    expect(await countOrganizationObjects(client, ALPHA, { buckets: ['rental-documents'] })).toBe(0)
  })

  it('stops on a storage failure instead of reporting a clean sweep', async () => {
    const failing = {
      from: () => ({
        list: vi
          .fn()
          .mockResolvedValueOnce({
            data: [{ name: 'contract.pdf', id: 'id-1' }],
            error: null,
          })
          .mockResolvedValue({ data: [], error: null }),
        remove: vi.fn().mockResolvedValue({ data: null, error: { message: 'network down' } }),
      }),
    }

    await expect(
      removeOrganizationObjects(failing, ALPHA, { buckets: ['rental-documents'] }),
    ).rejects.toThrow(/network down/)
  })

  it('refuses a target that is not an organization id', async () => {
    const { client } = storageDouble({})
    await expect(removeOrganizationObjects(client, 'all', {})).rejects.toThrow(
      /not an organization id/,
    )
  })
})
