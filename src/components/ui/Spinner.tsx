import { cn } from '@/lib/utils/cn'

export interface SpinnerProps {
  className?: string
  /** Announced to assistive technology. Omit when the surrounding element already says it. */
  label?: string
}

export function Spinner({ className, label }: SpinnerProps) {
  return (
    <>
      <svg
        className={cn('animate-spin', className)}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <path
          d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
