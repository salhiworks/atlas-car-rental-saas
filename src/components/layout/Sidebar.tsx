import { Check, ChevronsUpDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { NavLink } from 'react-router-dom'

import { NotificationBell } from '@/features/notifications/components/NotificationBell'
import { useWorkspace } from '@/features/workspace/workspace-context'
import { ROLE_LABELS, can } from '@/lib/authz/permissions'
import { cn } from '@/lib/utils/cn'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu'
import { OrganizationAvatar } from './OrganizationAvatar'
import { UserMenu } from './UserMenu'
import { navigationGroups } from './navigation'

export interface SidebarProps {
  isCollapsed: boolean
  onToggleCollapsed?: () => void
  /** Called after a navigation link is followed, so the mobile drawer can close. */
  onNavigate?: () => void
  className?: string
}

export function Sidebar({ isCollapsed, onToggleCollapsed, onNavigate, className }: SidebarProps) {
  const { organization, memberships, role, switchOrganization } = useWorkspace()

  return (
    <div
      className={cn(
        'bg-canvas border-line flex h-full flex-col border-e',
        isCollapsed ? 'w-[68px]' : 'w-[264px]',
        className,
      )}
    >
      {/* Agency identity + switcher */}
      <div className="flex h-14 shrink-0 items-center gap-1 px-3">
        {organization ? (
          memberships.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-surface-inset flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1.5 text-start transition-colors',
                  isCollapsed && 'justify-center',
                )}
                aria-label="Switch agency"
              >
                <OrganizationAvatar organization={organization} />
                {!isCollapsed && (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8125rem] font-semibold">
                        {organization.name}
                      </span>
                      <span className="text-ink-subtle block truncate text-[0.6875rem]">
                        {role ? ROLE_LABELS[role] : ''}
                      </span>
                    </span>
                    <ChevronsUpDown
                      className="text-ink-subtle size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  </>
                )}
              </DropdownMenuTrigger>

              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="eyebrow">Your agencies</DropdownMenuLabel>
                {memberships.map((entry) => (
                  <DropdownMenuItem
                    key={entry.organization.id}
                    onSelect={() => switchOrganization(entry.organization.id)}
                  >
                    <OrganizationAvatar organization={entry.organization} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{entry.organization.name}</span>
                    {entry.organization.id === organization.id ? (
                      <Check className="text-brand-600 size-4" aria-hidden="true" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2.5 p-1.5',
                isCollapsed && 'justify-center',
              )}
            >
              <OrganizationAvatar organization={organization} />
              {!isCollapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-semibold">
                    {organization.name}
                  </span>
                  <span className="text-ink-subtle block truncate text-[0.6875rem]">
                    {role ? ROLE_LABELS[role] : ''}
                  </span>
                </span>
              )}
            </div>
          )
        ) : null}

        {/*
          The bell sits between the agency identity and the collapse control,
          in the row that already exists. The desktop layout has no top header
          and does not grow one for this: a full-width bar for a single icon
          would cost every page a strip of vertical space.
        */}
        {organization ? <NotificationBell isCompact={isCollapsed} /> : null}

        {onToggleCollapsed && !isCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="text-ink-subtle hover:bg-surface-inset hover:text-ink shrink-0 rounded-md p-1.5 transition-colors"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Main">
        {navigationGroups.map((group, groupIndex) => {
          const visibleItems = group.items.filter((item) => can(role, item.permission))
          if (visibleItems.length === 0) return null

          return (
            <div
              key={group.label ?? `group-${groupIndex}`}
              className={groupIndex === 0 ? '' : 'mt-5'}
            >
              {group.label && !isCollapsed ? (
                <p className="eyebrow px-2.5 pb-1.5">{group.label}</p>
              ) : null}
              {group.label && isCollapsed ? (
                <div className="bg-line mx-2 my-2.5 h-px" aria-hidden="true" />
              ) : null}

              <ul className="space-y-0.5">
                {visibleItems.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      onClick={onNavigate}
                      title={isCollapsed ? item.label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[0.8125rem] transition-colors duration-150',
                          isCollapsed && 'justify-center px-0',
                          isActive
                            ? 'bg-surface text-ink border-line border font-medium shadow-raised'
                            : 'text-ink-muted hover:bg-surface-inset hover:text-ink border border-transparent',
                        )
                      }
                    >
                      <item.icon className="size-4 shrink-0" aria-hidden="true" />
                      {!isCollapsed && <span className="flex-1 truncate">{item.label}</span>}
                      {!isCollapsed && !item.isAvailable ? (
                        // A quiet marker, not a badge: the section is reachable
                        // and explains itself on arrival.
                        <span
                          className="bg-ink-subtle/40 size-1.5 shrink-0 rounded-full"
                          aria-hidden="true"
                        />
                      ) : null}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>

      {/* Collapse control when collapsed, then the account menu */}
      <div className="border-line space-y-1 border-t p-3">
        {onToggleCollapsed && isCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="text-ink-subtle hover:bg-surface-inset hover:text-ink flex w-full items-center justify-center rounded-md p-2 transition-colors"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          </button>
        ) : null}

        <UserMenu isCollapsed={isCollapsed} />
      </div>
    </div>
  )
}
