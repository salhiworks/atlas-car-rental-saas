import { render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { useElementWidth } from './useElementWidth'

/**
 * The blank-chart regression.
 *
 * Every chart in this product renders a loading skeleton first and only mounts
 * its measuring container once the data arrives. The earlier hook took a
 * RefObject and measured it inside an effect keyed on that object — which is
 * stable, so the effect ran exactly once, on mount, against a ref that was still
 * null. Width stayed 0 for the life of the component and the chart never drew.
 *
 * It went unnoticed because a blank chart card and a drawn one look alike from a
 * distance: legend, axis area, and the figures correct in the hidden table
 * underneath. This test mounts the container LATE, which is the only condition
 * that reproduces it.
 */
function LateChart({ ready }: { ready: boolean }) {
  const { ref, width } = useElementWidth()
  if (!ready) return <p>loading</p>
  return (
    <div ref={ref}>
      <span data-testid="width">{width}</span>
    </div>
  )
}

function Toggler() {
  const [ready, setReady] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setReady(true)}>
        arrive
      </button>
      <LateChart ready={ready} />
    </>
  )
}

describe('useElementWidth', () => {
  it('measures a container that mounts after the first render', () => {
    const { rerender } = render(<LateChart ready={false} />)
    expect(screen.getByText('loading')).toBeInTheDocument()

    rerender(<LateChart ready={true} />)

    // The suite stubs clientWidth at 720. A zero here is the defect: the chart
    // draws nothing because it believes it has no room.
    expect(Number(screen.getByTestId('width').textContent)).toBe(720)
  })

  it('measures immediately when the container is there from the start', () => {
    render(<LateChart ready={true} />)
    expect(Number(screen.getByTestId('width').textContent)).toBe(720)
  })

  it('survives the container appearing through ordinary state', async () => {
    const { getByRole } = render(<Toggler />)
    getByRole('button', { name: 'arrive' }).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(Number(screen.getByTestId('width').textContent)).toBe(720)
  })
})
