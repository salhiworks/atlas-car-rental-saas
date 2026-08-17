import { AlertOctagon } from 'lucide-react'

import { toAppError } from '@/lib/supabase/errors'

import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

export interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  title?: string
  className?: string
}

/**
 * In-place failure for a panel or a page section.
 *
 * The message comes from the shared error mapper, so a permission failure reads
 * as a permission failure rather than as a Postgres policy violation.
 */
export function ErrorState({ error, onRetry, title, className }: ErrorStateProps) {
  const appError = toAppError(error)

  return (
    <EmptyState
      className={className}
      icon={AlertOctagon}
      title={title ?? 'This could not be loaded'}
      description={appError.message}
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  )
}
