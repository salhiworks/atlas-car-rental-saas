import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from './Button'

export interface ListPaginationProps {
  page: number
  pageCount: number
  /** Rows matching the current query, across every page. */
  total: number
  /** Singular name for what is being counted, e.g. "contract". */
  noun: string
  /** Supplied only where an -s is wrong, e.g. "entries". */
  pluralNoun?: string
  onPageChange: (page: number) => void
}

/**
 * The footer under a paged list.
 *
 * One component rather than the five hand-written copies this replaces: the
 * count sentence, the button order and the border rhythm were drifting apart
 * page by page, and a list footer is exactly the kind of furniture a product
 * should render identically everywhere.
 *
 * Renders nothing when there is only one page, so callers need no guard.
 */
export function ListPagination({
  page,
  pageCount,
  total,
  noun,
  pluralNoun,
  onPageChange,
}: ListPaginationProps) {
  if (pageCount <= 1) return null

  const label = total === 1 ? noun : (pluralNoun ?? `${noun}s`)

  return (
    <div className="border-line flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-5 py-3">
      <p className="text-ink-subtle text-[0.75rem]">
        Page {page} of {pageCount} · {total} {label}
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<ChevronLeft />}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="secondary"
          trailingIcon={<ChevronRight />}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
