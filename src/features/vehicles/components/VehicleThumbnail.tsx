import { Car } from 'lucide-react'

import { cn } from '@/lib/utils/cn'

export interface VehicleThumbnailProps {
  url?: string | undefined
  make: string
  model: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: 'h-9 w-14',
  md: 'h-12 w-[72px]',
  lg: 'h-full w-full',
} as const

/**
 * A vehicle's photo, or a restrained placeholder.
 *
 * The fallback is a mark, not a stock photograph of a car: a fleet of forty
 * identical generic images reads as fake data and makes the rows that do have
 * real photos harder to pick out.
 */
export function VehicleThumbnail({
  url,
  make,
  model,
  size = 'md',
  className,
}: VehicleThumbnailProps) {
  const shared = cn(
    'border-line bg-surface-inset shrink-0 overflow-hidden rounded-md border',
    SIZES[size],
    className,
  )

  if (url) {
    return (
      <img
        src={url}
        alt={`${make} ${model}`}
        loading="lazy"
        decoding="async"
        className={cn(shared, 'object-cover')}
      />
    )
  }

  return (
    <div
      className={cn(shared, 'text-ink-subtle flex items-center justify-center')}
      aria-hidden="true"
    >
      <Car className={size === 'sm' ? 'size-4' : 'size-5'} />
    </div>
  )
}
