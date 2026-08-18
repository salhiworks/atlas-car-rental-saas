import * as Dialog from '@radix-ui/react-dialog'
import { Menu, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Wordmark } from '@/components/brand/Wordmark'

import { PrimaryCta } from './PrimaryCta'

const NAV_LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Operations', href: '#operations' },
  { label: 'Insights', href: '#insights' },
] as const

export function MarketingHeader() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  return (
    <header className="border-line bg-canvas/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-[4.5rem] max-w-[1220px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          to={paths.overview}
          className="rounded-md focus-visible:outline-offset-4"
          aria-label="Atlas home"
        >
          <Wordmark size="lg" />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-ink-muted hover:text-ink text-sm font-medium transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            to={paths.signIn}
            className="text-ink-muted hover:text-ink rounded-md px-3 py-2 text-sm font-medium transition-colors"
          >
            Sign in
          </Link>
          <PrimaryCta size="lg" className="font-semibold" />
        </div>

        <Dialog.Root open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <Dialog.Trigger
            className="text-ink-muted hover:bg-surface-inset hover:text-ink -me-2 rounded-md p-2 transition-colors lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-5" aria-hidden="true" />
          </Dialog.Trigger>

          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-[#16181a]/40 backdrop-blur-[2px]" />
            <Dialog.Content
              className="bg-canvas fixed inset-x-0 top-0 z-50 outline-none"
              aria-describedby={undefined}
            >
              <Dialog.Title className="sr-only">Menu</Dialog.Title>
              <div className="border-line flex h-[4.5rem] items-center justify-between border-b px-4 sm:px-6">
                <Wordmark size="lg" />
                <Dialog.Close
                  className="text-ink-muted hover:bg-surface-inset hover:text-ink -me-2 rounded-md p-2 transition-colors"
                  aria-label="Close menu"
                >
                  <X className="size-5" aria-hidden="true" />
                </Dialog.Close>
              </div>

              <nav aria-label="Primary" className="flex flex-col gap-1 px-4 py-4 sm:px-6">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setIsMenuOpen(false)}
                    className="text-ink hover:bg-surface-inset rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
                  >
                    {link.label}
                  </a>
                ))}
              </nav>

              <div className="border-line flex flex-col gap-2 border-t px-4 py-4 sm:px-6">
                <Link
                  to={paths.signIn}
                  onClick={() => setIsMenuOpen(false)}
                  className="border-line-strong text-ink hover:bg-surface-inset flex h-10 items-center justify-center rounded-md border text-sm font-medium transition-colors"
                >
                  Sign in
                </Link>
                <PrimaryCta size="lg" className="w-full font-semibold" />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </header>
  )
}
