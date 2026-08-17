import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Composes class names, letting a later Tailwind utility win over an earlier one
 * in the same group. Without the merge step, `cn('p-4', props.className)` would
 * leave both `p-4` and an overriding `p-6` in the output and the winner would
 * depend on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
