import { useSyncExternalStore } from 'react'

/**
 * The current time, as something React can subscribe to.
 *
 * A component that reads `Date.now()` while rendering produces output that
 * depends on when React happened to call it, which is exactly the kind of thing
 * that behaves one way in development and another under concurrent rendering.
 * The clock is therefore an external store: one interval for the whole
 * application, a snapshot that only changes on a tick, and components that read
 * it the same way they read any other subscription.
 *
 * Used by the invitation list, where a resend cooldown has to expire on screen
 * without anybody clicking anything.
 */

let snapshot = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function tick(): void {
  const next = Date.now()
  // The snapshot must be referentially stable between real changes, or
  // useSyncExternalStore re-renders forever.
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  if (timer === null) {
    tick()
    timer = setInterval(tick, 1000)
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getSnapshot(): number {
  return snapshot
}

/**
 * Milliseconds since the epoch, updated once a second.
 *
 * Zero until the first subscription is established, which callers should read as
 * "not measured yet" rather than as 1970 — a countdown that has not started is
 * better rendered as absent than as expired.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
