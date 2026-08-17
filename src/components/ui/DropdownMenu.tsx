import * as Primitive from '@radix-ui/react-dropdown-menu'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { forwardRef } from 'react'

import { cn } from '@/lib/utils/cn'

/**
 * Thin styling layer over Radix's menu primitive.
 *
 * Menus are one of the few places where getting keyboard interaction, focus
 * return and typeahead right is genuinely hard, so the behaviour is delegated
 * and only the appearance is ours.
 */
export const DropdownMenu = Primitive.Root
export const DropdownMenuTrigger = Primitive.Trigger
export const DropdownMenuGroup = Primitive.Group

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof Primitive.Content>,
  ComponentPropsWithoutRef<typeof Primitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'bg-surface border-line z-50 min-w-52 overflow-hidden rounded-lg border p-1 shadow-overlay',
          'overlay-enter',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
})

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof Primitive.Item>,
  ComponentPropsWithoutRef<typeof Primitive.Item> & { tone?: 'default' | 'critical' }
>(function DropdownMenuItem({ className, tone = 'default', ...props }, ref) {
  return (
    <Primitive.Item
      ref={ref}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[0.8125rem] outline-none select-none',
        'transition-colors duration-100',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        tone === 'critical'
          ? 'text-critical-600 data-highlighted:bg-critical-50'
          : 'text-ink data-highlighted:bg-surface-inset',
        className,
      )}
      {...props}
    />
  )
})

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof Primitive.Label>,
  ComponentPropsWithoutRef<typeof Primitive.Label>
>(function DropdownMenuLabel({ className, ...props }, ref) {
  return <Primitive.Label ref={ref} className={cn('px-2.5 py-1.5', className)} {...props} />
})

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof Primitive.Separator>,
  ComponentPropsWithoutRef<typeof Primitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <Primitive.Separator
      ref={ref}
      className={cn('bg-line -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
})
