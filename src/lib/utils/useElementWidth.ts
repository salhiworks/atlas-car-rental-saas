import { useCallback, useRef, useState } from 'react'

/**
 * Tracks an element's rendered width.
 *
 * Charts are drawn at real pixel dimensions rather than scaled through a
 * viewBox, so axis labels keep their intended size instead of stretching with
 * the container.
 *
 * A CALLBACK REF, not a RefObject. The earlier version took a ref and measured
 * it inside an effect keyed on the ref object — which is stable, so the effect
 * ran exactly once, on mount. Every chart in this product renders a loading
 * skeleton first and only mounts its container when the data arrives, by which
 * time that single run had already happened against a null ref and returned.
 * The width stayed 0 for the life of the component and the chart never drew:
 * the dashboard's revenue chart was a blank rectangle above a correct hidden
 * table, and it was not noticed because the empty state and the drawn state
 * both look like a card with a legend in it.
 *
 * React calls a callback ref when the element attaches and again when it
 * detaches, so measurement cannot be missed however late the element appears.
 */
export function useElementWidth(): {
  ref: (node: HTMLElement | null) => void
  width: number
} {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null

    if (!node) {
      setWidth(0)
      return
    }

    setWidth(node.clientWidth)

    // Guarded: an environment without ResizeObserver still gets the width the
    // element had when it attached, which is what a static render needs.
    if (typeof ResizeObserver === 'undefined') return

    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.current.observe(node)
  }, [])

  return { ref, width }
}
