import { cn } from '@/lib/utils/cn'

export interface SkeletonProps {
  className?: string
}

/**
 * Placeholder for content that is loading. Always sized to match the real
 * content it stands in for, so the layout does not jump when data lands.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn('bg-surface-inset animate-pulse rounded-md', className)}
      aria-hidden="true"
    />
  )
}

/** Loading stand-in for a table: header row plus `rows` body rows. */
export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-3 p-5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-4', columnIndex === 0 ? 'w-1/4' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
