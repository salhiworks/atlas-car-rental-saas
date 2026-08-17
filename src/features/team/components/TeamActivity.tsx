import { History } from 'lucide-react'

import { Button, EmptyState, Skeleton } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import type { TeamEventRow } from '@/types/database'

import { describeEvent } from '../domain'

/**
 * Recent membership activity.
 *
 * Every sentence is assembled from typed columns — an actor name, a verb, a
 * subject, a trailer — and rendered as React text nodes. Nothing here
 * concatenates a stored string into markup, which matters because the names and
 * addresses in these rows are text somebody typed into a sign-up form.
 *
 * Restrained on purpose: this is the last twenty things that happened to the
 * team, not a compliance ledger. Administrators only, because half the entries
 * name people who are not members any more.
 */

export interface TeamActivityProps {
  events: readonly TeamEventRow[]
  locale: string
  timeZone: string
  isLoading?: boolean
  page: number
  pageSize: number
  total: number
  isFetchingMore: boolean
  onPageChange: (page: number) => void
}

export function TeamActivity({
  events,
  locale,
  timeZone,
  isLoading = false,
  page,
  pageSize,
  total,
  isFetchingMore,
  onPageChange,
}: TeamActivityProps) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nothing has happened yet"
        description="Invitations, role changes and departures appear here as they occur."
      />
    )
  }

  return (
    <div>
      <ol className="divide-line divide-y">
        {events.map((event) => {
          const sentence = describeEvent(event)
          return (
            <li key={event.id} className="min-w-0 px-4 py-2.5">
              <p className="text-[0.8125rem] leading-5 break-words">
                <span className="font-medium">{sentence.actor}</span> {sentence.verb}
                {sentence.subject ? (
                  <>
                    {' '}
                    <span className="font-medium">{sentence.subject}</span>
                  </>
                ) : null}
                {sentence.trailer ? (
                  <span className="text-ink-muted"> {sentence.trailer}</span>
                ) : null}
              </p>
              <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                {formatDateTime(new Date(event.occurred_at), { locale, timeZone })}
              </p>
            </li>
          )
        })}
      </ol>

      {/*
        Pages, not an ever-growing "show more" that replaced what it was asked
        to extend. The old control swapped events 1-12 for 13-24 with no way
        back to the newest ones, on a card still headed "Recent activity".
      */}
      {total > pageSize ? (
        <div className="border-line flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
          <p className="text-ink-subtle text-[0.75rem]">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0 || isFetchingMore}
              onClick={() => onPageChange(page - 1)}
            >
              Newer
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={(page + 1) * pageSize >= total || isFetchingMore}
              onClick={() => onPageChange(page + 1)}
            >
              Earlier
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
