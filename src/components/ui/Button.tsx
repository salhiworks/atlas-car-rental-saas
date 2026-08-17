import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react'

import { cn } from '@/lib/utils/cn'

import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-700 text-ink-inverse border border-brand-800 hover:bg-brand-600 active:bg-brand-800 shadow-raised',
  secondary:
    'bg-surface text-ink border border-line-strong hover:bg-surface-muted active:bg-surface-inset shadow-raised',
  ghost:
    'bg-transparent text-ink-muted border border-transparent hover:bg-surface-inset hover:text-ink',
  danger:
    'bg-critical-600 text-ink-inverse border border-critical-700 hover:bg-critical-700 active:bg-critical-700 shadow-raised',
  link: 'bg-transparent text-brand-700 border border-transparent hover:text-brand-500 underline underline-offset-4 decoration-brand-200 hover:decoration-brand-400',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.8125rem] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-md',
}

/**
 * The visual recipe, shared with ButtonLink.
 *
 * A control that navigates must be an <a>, and a control that acts must be a
 * <button> — so the appearance is factored out rather than making Button
 * masquerade as a link.
 */
export function buttonStyles(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  fullWidth = false,
): string {
  return cn(
    'relative inline-flex items-center justify-center font-medium whitespace-nowrap',
    'transition-colors duration-150',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth && 'w-full',
  )
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks interaction. The label stays visible so the button does not resize. */
  isLoading?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  fullWidth?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    isLoading = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(buttonStyles(variant, size, fullWidth), className)}
      {...props}
    >
      {isLoading ? (
        <Spinner className="size-4 shrink-0" />
      ) : (
        leadingIcon && <span className="shrink-0 [&_svg]:size-4">{leadingIcon}</span>
      )}
      {children}
      {!isLoading && trailingIcon && (
        <span className="shrink-0 [&_svg]:size-4">{trailingIcon}</span>
      )}
    </button>
  )
})
