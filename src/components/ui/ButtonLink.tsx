import type { ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'

import { cn } from '@/lib/utils/cn'

import { buttonStyles, type ButtonSize, type ButtonVariant } from './Button'

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

/**
 * A navigation control that looks like a button.
 *
 * Renders a real anchor, so middle-click, ctrl-click and "open in new tab" all
 * behave — which a <button> with an onClick handler quietly breaks.
 */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  leadingIcon,
  trailingIcon,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link className={cn(buttonStyles(variant, size, fullWidth), className)} {...props}>
      {leadingIcon ? <span className="shrink-0 [&_svg]:size-4">{leadingIcon}</span> : null}
      {children}
      {trailingIcon ? <span className="shrink-0 [&_svg]:size-4">{trailingIcon}</span> : null}
    </Link>
  )
}
