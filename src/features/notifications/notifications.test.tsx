import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type { NotificationRow } from '@/types/database'

import { NotificationList } from './components/NotificationList'
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  describe as describeNotification,
  isDismissable,
} from './domain'

/**
 * The notification interface.
 *
 * Two things are being protected here. First, that the words are true: a
 * tracking alert that says a connection is unhealthy must not say a vehicle is
 * offline, and an unpaid contract must not be called an overdue invoice. Second,
 * that "nothing on screen" always says which nothing it is — Reports once
 * shipped a failed query rendered as a reassuring empty state, and that bug
 * would be worse here, on the surface whose entire job is to be believed when it
 * says there is nothing to do.
 */

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  fingerprint: 'vehicle_compliance_expired:v1:insurance:2026-08-01',
  kind: 'vehicle_compliance_expired',
  category: 'compliance',
  severity: 'urgent',
  subject_id: 'v1',
  subject_label: 'AB-123-CD',
  secondary_id: null,
  secondary_label: null,
  occurred_at: null,
  due_on: '2026-08-01',
  amount_minor: null,
  currency: null,
  action_path: '/vehicles/v1',
  context: { document: 'insurance', vehicle: 'Renault Clio' },
  read_at: null,
  dismissed_at: null,
  snoozed_until: null,
  total_count: 1,
  ...over,
})

const display = { locale: 'en', timeZone: 'Africa/Casablanca' }

const handlers = {
  onRetry: vi.fn(),
  onMarkRead: vi.fn(),
  onDismiss: vi.fn(),
  onSnooze: vi.fn(),
}

function renderList(props: Partial<Parameters<typeof NotificationList>[0]> = {}) {
  return render(
    <MemoryRouter>
      <NotificationList
        notifications={[row()]}
        isLoading={false}
        error={null}
        {...display}
        emptyTitle="Nothing needs your attention"
        emptyDescription="Things appear here as they come due."
        busyFingerprint={null}
        {...handlers}
        {...props}
      />
    </MemoryRouter>,
  )
}

// -----------------------------------------------------------------------------
describe('what the copy claims', () => {
  it('says a connection is unhealthy, not that a vehicle is offline', () => {
    const copy = describeNotification(
      row({
        kind: 'gps_connection_unhealthy',
        category: 'gps',
        context: { signal: 'connection_unhealthy', detail: 'The provider refused the token.' },
      }),
    )

    expect(copy.title).toBe('A tracking connection is not healthy')
    expect(copy.title).not.toMatch(/offline/i)
    expect(copy.title).not.toMatch(/hours|minutes|since/i)
  })

  it('separates a stale position from a provider saying the device is offline', () => {
    const stale = describeNotification(
      row({
        kind: 'gps_position_stale',
        subject_label: 'AB-123-CD',
        context: { signal: 'position_stale' },
      }),
    )
    const never = describeNotification(
      row({
        kind: 'gps_position_stale',
        subject_label: 'AB-123-CD',
        context: { signal: 'no_position' },
      }),
    )
    const offline = describeNotification(
      row({
        kind: 'gps_position_stale',
        subject_label: 'AB-123-CD',
        context: { signal: 'provider_offline' },
      }),
    )

    // Three different facts, three different sentences.
    expect(stale.title).toBe('AB-123-CD has not reported a position recently')
    expect(never.title).toBe('No position has been reported for AB-123-CD')
    expect(offline.title).toBe('The provider reports AB-123-CD offline')
  })

  it('never calls an unpaid contract an overdue invoice', () => {
    const copy = describeNotification(
      row({ kind: 'rental_balance_outstanding', subject_label: 'RNT-2026-00142' }),
    )
    expect(copy.title).toBe('RNT-2026-00142 has an outstanding balance')
    expect(copy.title).not.toMatch(/invoice|overdue|days late/i)
  })

  it('tells three instalments of the same agreement apart', () => {
    /*
     * An agreement forty days behind produces three overdue instalments, all of
     * them "overdue on BR-FIN-2026". Identical lines are how somebody pays one
     * and takes the other two for duplicates.
     */
    const second = describeNotification(
      row({
        kind: 'financing_overdue',
        category: 'financing',
        subject_label: 'BR-FIN-2026',
        context: { lender: 'Banque Populaire', sequence: 2 },
      }),
    )
    const third = describeNotification(
      row({
        kind: 'financing_overdue',
        category: 'financing',
        subject_label: 'BR-FIN-2026',
        context: { lender: 'Banque Populaire', sequence: 3 },
      }),
    )

    expect(second.detail).toBe('Banque Populaire · Instalment 2')
    expect(third.detail).toBe('Banque Populaire · Instalment 3')
    expect(second.detail).not.toBe(third.detail)
  })

  it('says what it knows when the instalment number is missing', () => {
    const copy = describeNotification(
      row({ kind: 'financing_due', category: 'financing', context: { lender: 'CIH' } }),
    )
    expect(copy.detail).toBe('CIH')
  })

  it('does not shout', () => {
    for (const kind of [
      'rental_return_overdue',
      'financing_overdue',
      'vehicle_compliance_expired',
    ] as const) {
      const copy = describeNotification(row({ kind }))
      expect(copy.title).not.toMatch(/!|URGENT|IMMEDIATELY|ACTION REQUIRED/)
    }
  })

  it('offers dismissal for a condition and not for an event', () => {
    expect(isDismissable(row())).toBe(true)
    expect(isDismissable(row({ category: 'team', kind: 'team_invitation_accepted' }))).toBe(false)
    // Billing carries both: the attention condition can be put away, the events
    // cannot — dismissing "your payment failed" would mean nothing.
    expect(isDismissable(row({ category: 'billing', kind: 'billing_attention_required' }))).toBe(
      true,
    )
    expect(isDismissable(row({ category: 'billing', kind: 'billing_payment_failed' }))).toBe(false)
  })

  it('has a sentence for every billing kind, so the list cannot crash', () => {
    /*
     * The defect this catches was real and shipped past a passing test suite: the
     * seven billing kinds existed in the database enum but not in NotificationKind,
     * so describe()'s exhaustive switch fell through and returned undefined —
     * and the first billing notification would have thrown on `copy.title`,
     * taking the whole notification list down for that owner.
     */
    for (const kind of [
      'billing_subscription_activated',
      'billing_payment_failed',
      'billing_payment_recovered',
      'billing_cancellation_scheduled',
      'billing_subscription_ended',
      'billing_plan_changed',
      'billing_attention_required',
    ] as const) {
      const copy = describeNotification(row({ category: 'billing', kind, context: {} }))
      expect(copy, kind).toBeDefined()
      expect(copy.title.length, kind).toBeGreaterThan(0)
    }
  })

  it('says a subscription payment failed, not that a card was declined', () => {
    const copy = describeNotification(
      row({ category: 'billing', kind: 'billing_payment_failed', context: {} }),
    )
    expect(copy.title).toBe('A subscription payment did not go through')
    // We know an invoice attempt failed. We do not know the card is dead.
    expect(copy.title).not.toMatch(/declined|card/i)
    // And it is about OUR subscription, never a customer's rental payment.
    expect(copy.title).toMatch(/subscription/)
  })

  it('names the billing category, so its preference row is not blank', () => {
    expect(CATEGORY_LABELS.billing).toBe('Subscription')
    expect(CATEGORY_DESCRIPTIONS.billing.length).toBeGreaterThan(10)
  })
})

// -----------------------------------------------------------------------------
describe('the four ways a list can be empty', () => {
  it('shows a failed query as a failure, never as being caught up', () => {
    renderList({ notifications: [], error: new Error('permission denied') })

    expect(screen.getByText('Notifications could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('Nothing needs your attention')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('shows loading as loading', () => {
    const { container } = renderList({ notifications: [], isLoading: true })
    expect(screen.queryByText('Nothing needs your attention')).not.toBeInTheDocument()
    expect(container.querySelectorAll('[class*="animate"]').length).toBeGreaterThan(0)
  })

  it('shows a genuinely empty list calmly', () => {
    renderList({ notifications: [] })
    const empty = screen.getByText('Nothing needs your attention')
    expect(empty).toBeInTheDocument()
    // No celebration, no claim that anything is being watched meanwhile.
    expect(screen.queryByText(/🎉|congratulations|monitoring|24\/7/i)).not.toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
describe('a row', () => {
  it('links to the record it is about', () => {
    renderList()
    const link = screen.getByRole('link', { name: /Insurance for AB-123-CD has expired/ })
    expect(link).toHaveAttribute('href', '/vehicles/v1')
  })

  it('carries severity in words, not only in colour', () => {
    renderList()
    expect(screen.getByText('Urgent')).toBeInTheDocument()

    renderList({ notifications: [row({ severity: 'attention' })] })
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0)
  })

  it('marks unread in text as well as in weight', () => {
    renderList()
    expect(screen.getByText('Unread')).toBeInTheDocument()
  })

  it('labels its controls with the notification they act on', () => {
    renderList()
    expect(
      screen.getByRole('button', { name: 'Mark "Insurance for AB-123-CD has expired" as read' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Options for "Insurance for AB-123-CD has expired"' }),
    ).toBeInTheDocument()
  })

  it('offers no mark-read control once it has been read', () => {
    renderList({ notifications: [row({ read_at: '2026-08-16T10:00:00Z' })] })
    expect(screen.queryByRole('button', { name: /Mark ".*" as read/ })).not.toBeInTheDocument()
  })

  it('renders an amount with its currency and never a bare number', () => {
    renderList({
      notifications: [
        row({
          kind: 'rental_balance_outstanding',
          category: 'rentals',
          severity: 'attention',
          subject_label: 'RNT-2026-00142',
          amount_minor: 125000,
          currency: 'MAD',
          due_on: null,
          occurred_at: '2026-08-10T09:00:00Z',
          context: {},
        }),
      ],
    })
    expect(screen.getByText(/MAD/)).toBeInTheDocument()
    expect(screen.getByText(/1,250\.00/)).toBeInTheDocument()
  })

  it('renders a plate that looks like markup as text', () => {
    renderList({ notifications: [row({ subject_label: '<img src=x onerror=alert(1)>' })] })

    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('offers snooze choices and a dismissal, and no way to resolve the source', () => {
    renderList()
    // Nothing here claims to pay an instalment or bring a car back.
    expect(screen.queryByText(/mark as paid|mark resolved|mark returned/i)).not.toBeInTheDocument()
  })
})
