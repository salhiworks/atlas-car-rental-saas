/**
 * Types for the agency teardown helper.
 *
 * Hand-written because `scripts/` is plain ESM run by node and sits outside the
 * application tsconfig — but the part that decides which files get deleted is
 * worth testing, and a test needs a shape to check against.
 */

export declare const ORGANIZATION_BUCKETS: readonly string[]

export interface StorageEntry {
  name: string
  /** Null for a folder; a value for an object. */
  id?: string | null
}

export interface StorageListResult {
  data: StorageEntry[] | null
  error: { message: string } | null
}

export interface StorageRemoveResult {
  data?: unknown
  error: { message: string } | null
}

export interface StorageBucketClient {
  list(
    prefix: string,
    options?: {
      limit?: number
      offset?: number
      sortBy?: { column: string; order: string }
    },
  ): Promise<StorageListResult>
  remove(paths: string[]): Promise<StorageRemoveResult>
}

export interface StorageClient {
  from(bucket: string): StorageBucketClient
}

export interface TeardownOptions {
  buckets?: readonly string[]
  batchSize?: number
  pageSize?: number
}

export declare function isOrganizationId(value: unknown): boolean

export declare function assertOwnedPath(organizationId: string, path: string): string

export declare function listPrefix(
  storage: StorageClient,
  bucket: string,
  prefix: string,
  pageSize?: number,
): Promise<string[]>

export declare function removeOrganizationObjects(
  storage: StorageClient,
  organizationId: string,
  options?: TeardownOptions,
): Promise<Record<string, number>>

export declare function countOrganizationObjects(
  storage: StorageClient,
  organizationId: string,
  options?: TeardownOptions,
): Promise<number>
