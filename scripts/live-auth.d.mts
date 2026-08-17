/**
 * Types for the live suite's sign-in helper.
 *
 * Hand-written because `scripts/` is plain ESM run by node and is outside every
 * tsconfig — but the helper is worth testing, and a test that imports it needs a
 * shape to check against.
 */

export declare const MAX_ATTEMPTS: number
export declare const BACKOFF_MS: readonly number[]

export declare class AuthTransportError extends Error {
  readonly name: 'AuthTransportError'
  readonly category: 'auth_transport_failure'
  readonly attempts: number
  readonly lastDetail: string
  constructor(message: string, attempts: number, lastDetail: string)
}

export interface AuthLikeError {
  name?: string
  status?: number
  code?: string
  message?: string
}

export declare function isAuthTransportFailure(error: unknown): boolean
export declare function describeAuthFailure(error: unknown): string

export interface SignInResult<TClient> {
  readonly client: TClient
  readonly session: { access_token: string }
  readonly user: { id: string }
  readonly attempts: number
}

export interface SignInOptions {
  maxAttempts?: number
  backoffMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

export declare function signInTestUser<TClient>(
  makeClient: () => TClient,
  credentials: { email: string; password: string },
  options?: SignInOptions,
): Promise<SignInResult<TClient>>
