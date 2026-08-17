import * as Dialog from '@radix-ui/react-dialog'
import { Menu, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'

import { useWorkspace } from '@/features/workspace/workspace-context'

import { NotificationBell } from '@/features/notifications/components/NotificationBell'

import { OrganizationAvatar } from './OrganizationAvatar'
import { Sidebar } from './Sidebar'

const COLLAPSE_STORAGE_KEY = 'atlas.sidebar.collapsed'

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * The authenticated frame every module renders inside.
 *
 * Desktop keeps a persistent sidebar — agency staff work here all day and a
 * navigation drawer that has to be summoned costs a click on every move. Below
 * `lg` the same sidebar becomes a drawer, so there is one navigation component
 * to maintain rather than two that can drift apart.
 */
export function AppShell() {
  const { organization } = useWorkspace()
  const [isCollapsed, setIsCollapsed] = useState(readCollapsedPreference)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((current) => {
      const next = !current
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next))
      } catch {
        // Preference simply is not remembered.
      }
      return next
    })
  }, [])

  // The drawer is a mobile affordance; leaving it mounted across a resize would
  // trap focus behind a sidebar that is already visible.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setIsDrawerOpen(false)
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  return (
    <div className="bg-canvas flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh shrink-0 lg:block">
        <Sidebar isCollapsed={isCollapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact bar, shown only where the sidebar is not */}
        <header className="border-line bg-canvas/85 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur lg:hidden">
          <Dialog.Root open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
            <Dialog.Trigger
              className="text-ink-muted hover:bg-surface-inset hover:text-ink -ms-2 rounded-md p-2 transition-colors"
              aria-label="Open navigation"
            >
              <Menu className="size-5" aria-hidden="true" />
            </Dialog.Trigger>

            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-[#16181a]/40 backdrop-blur-[2px]" />
              <Dialog.Content
                className="fixed inset-y-0 start-0 z-50 h-dvh outline-none"
                aria-label="Navigation"
                aria-describedby={undefined}
              >
                <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                <div className="relative h-full">
                  <Sidebar isCollapsed={false} onNavigate={() => setIsDrawerOpen(false)} />
                  <Dialog.Close
                    className="text-ink-muted hover:bg-surface-inset absolute end-3 top-3.5 rounded-md p-1.5 transition-colors"
                    aria-label="Close navigation"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Dialog.Close>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          {organization ? (
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <OrganizationAvatar organization={organization} size="sm" />
              <span className="truncate text-[0.8125rem] font-semibold">{organization.name}</span>
            </div>
          ) : null}

          {/*
            The same bell and the same drawer as the desktop, in the header that
            already exists here. One notification surface, not two: a separate
            mobile interaction model would be a second thing to keep correct.
          */}
          {organization ? <NotificationBell className="-me-1" /> : null}
        </header>

        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
