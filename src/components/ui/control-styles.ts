/** Shared appearance for text-entry controls, so inputs, selects and textareas stay identical. */
export const controlBaseClasses =
  'w-full rounded-md border bg-surface text-ink text-sm transition-colors duration-150 ' +
  'placeholder:text-ink-subtle ' +
  'disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-ink-subtle ' +
  'read-only:bg-surface-inset'

export function controlStateClasses(hasError: boolean): string {
  return hasError
    ? 'border-critical-600 hover:border-critical-700'
    : 'border-line-strong hover:border-ink-subtle'
}
