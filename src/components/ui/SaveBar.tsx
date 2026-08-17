import { Button } from './Button'
import { cn } from '@/lib/utils/cn'

export interface SaveBarProps {
  /** The bar exists only while there is something to save. */
  isDirty: boolean
  isSaving?: boolean
  onDiscard: () => void
  onSave: () => void
  saveLabel?: string
  discardLabel?: string
  /** What is unsaved, in the section's own words. */
  message?: string
  className?: string
}

/**
 * The unsaved-changes bar for a long settings section.
 *
 * A Save button at the foot of a form the reader has scrolled past is a button
 * they cannot see when they need it. This one follows the viewport while the
 * section is dirty and is absent otherwise, so the page carries no permanently
 * disabled control and there is never a question about which section a save
 * applies to — only one section is on screen at a time.
 */
export function SaveBar({
  isDirty,
  isSaving = false,
  onDiscard,
  onSave,
  saveLabel = 'Save changes',
  discardLabel = 'Discard',
  message = 'You have unsaved changes.',
  className,
}: SaveBarProps) {
  if (!isDirty) return null

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={cn(
        'bg-surface border-line sticky bottom-4 z-20 flex flex-wrap items-center justify-between',
        'gap-x-4 gap-y-2 rounded-lg border px-4 py-3 shadow-overlay',
        className,
      )}
    >
      <p className="text-ink-muted text-[0.8125rem]">{message}</p>

      <div className="ms-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={isSaving} onClick={onDiscard}>
          {discardLabel}
        </Button>
        <Button variant="primary" size="sm" isLoading={isSaving} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}
