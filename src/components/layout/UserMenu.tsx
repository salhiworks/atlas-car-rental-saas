import { LogOut, Settings, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { useAuth } from '@/features/auth/auth-context'
import { cn } from '@/lib/utils/cn'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu'

function initialsFrom(value: string): string {
  const parts = value.split(/[\s@.]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]!}${parts[1]![0]!}`.toUpperCase()
}

export function UserMenu({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  if (!user) return null

  const metadata = user.user_metadata as { full_name?: unknown } | undefined
  const fullName = typeof metadata?.full_name === 'string' ? metadata.full_name.trim() : ''
  const displayName = fullName || user.email || 'Your account'
  const initials = initialsFrom(fullName || user.email || '?')

  const handleSignOut = () => {
    void signOut().then(() => {
      void navigate(paths.signIn, { replace: true })
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'hover:bg-surface-inset flex w-full items-center gap-2.5 rounded-md p-1.5 text-start transition-colors',
          isCollapsed && 'justify-center',
        )}
        aria-label="Account menu"
      >
        <span
          aria-hidden="true"
          className="bg-surface border-line text-ink-muted flex size-7 shrink-0 items-center justify-center rounded-full border text-[0.625rem] font-semibold"
        >
          {initials}
        </span>
        {!isCollapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.8125rem] font-medium">{displayName}</span>
            {fullName && user.email ? (
              <span className="text-ink-subtle block truncate text-[0.6875rem]">{user.email}</span>
            ) : null}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate text-[0.8125rem] font-medium">{displayName}</span>
          {user.email ? (
            <span className="text-ink-subtle block truncate text-[0.75rem]">{user.email}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate(paths.settings)}>
          <UserRound aria-hidden="true" />
          Your profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate(paths.settings)}>
          <Settings aria-hidden="true" />
          Agency settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="critical" onSelect={handleSignOut}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
