import { Spinner } from '../ui/Spinner'

/**
 * Shown while the session is being restored — a moment that is usually
 * imperceptible. Deliberately quiet: a full-screen branded splash on every
 * reload reads as slow even when it is not.
 */
export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="bg-canvas flex min-h-dvh items-center justify-center" role="status">
      <Spinner className="text-ink-subtle size-5" label={label} />
    </div>
  )
}
