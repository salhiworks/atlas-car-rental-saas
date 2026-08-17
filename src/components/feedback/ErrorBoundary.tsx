import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '../ui/Button'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last line of defence for a rendering failure.
 *
 * Catches what React cannot recover from and offers a reload rather than
 * leaving a blank page. Data-fetching failures are handled much closer to where
 * they happen, so reaching this boundary means a genuine defect.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled rendering error', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="bg-canvas flex min-h-dvh items-center justify-center px-4">
        <div className="bg-surface border-line w-full max-w-md rounded-lg border p-8 text-center shadow-raised">
          <h1 className="text-lg font-semibold">This page stopped responding</h1>
          <p className="text-ink-muted mt-2 text-[0.8125rem] leading-6">
            Reloading usually clears it. If it keeps happening, note what you were doing and let
            support know.
          </p>
          <Button
            variant="primary"
            className="mt-6"
            onClick={() => {
              window.location.reload()
            }}
          >
            Reload the page
          </Button>
        </div>
      </div>
    )
  }
}
