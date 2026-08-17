import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useOrganization } from '@/features/workspace/workspace-context'
import type { RentalStatus } from '@/types/database'

import {
  type RescheduleInput,
  fetchAvailableVehicles,
  fetchFleetRows,
  fetchSchedule,
  rescheduleRental,
} from './api'

/**
 * Query keys for the Calendar.
 *
 * Every key starts with the organization id, so switching agency cannot serve a
 * cached board from the previous one, and the workspace switcher's blanket
 * `['organization']` invalidation reaches all of them.
 */
export const calendarKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'calendar'] as const,
  schedule: (organizationId: string, from: string, to: string, statuses: readonly RentalStatus[]) =>
    [
      'organization',
      organizationId,
      'calendar',
      'schedule',
      from,
      to,
      [...statuses].sort(),
    ] as const,
  fleet: (organizationId: string, includeArchived: boolean, makes: readonly string[]) =>
    [
      'organization',
      organizationId,
      'calendar',
      'fleet',
      includeArchived,
      [...makes].sort(),
    ] as const,
  availability: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'calendar', 'availability', from, to] as const,
}

/**
 * Keeps the previous result on screen while the next one loads — but only when
 * it belongs to the same agency.
 *
 * Holding the old window is what stops the board blanking every time somebody
 * steps a week forward; a scheduler that flashes empty on every arrow press is
 * unusable at a counter. Carrying it across a workspace switch is a different
 * matter entirely: it would draw the previous agency's bookings on the new
 * agency's board until the fetch landed. Every key starts with the organization
 * id, so the two cases are told apart by comparing it.
 */
function keepWithinSameAgency<T>(organizationId: string) {
  return (previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined) =>
    previousQuery?.queryKey[1] === organizationId ? previous : undefined
}

/**
 * The bookings on screen.
 */
export function useSchedule(from: string, to: string, statuses: readonly RentalStatus[]) {
  const organization = useOrganization()

  return useQuery({
    queryKey: calendarKeys.schedule(organization.id, from, to, statuses),
    queryFn: () => fetchSchedule({ organizationId: organization.id, from, to, statuses }),
    placeholderData: keepWithinSameAgency(organization.id),
    staleTime: 15_000,
  })
}

export function useFleetRows(includeArchived: boolean, makes: readonly string[] = []) {
  const organization = useOrganization()

  return useQuery({
    queryKey: calendarKeys.fleet(organization.id, includeArchived, makes),
    queryFn: () => fetchFleetRows({ organizationId: organization.id, includeArchived, makes }),
    placeholderData: keepWithinSameAgency(organization.id),
    staleTime: 60_000,
  })
}

/** Vehicles free for a period. Only asked once both ends of it are known. */
export function useAvailability(from: string | null, to: string | null) {
  const organization = useOrganization()

  return useQuery({
    queryKey: calendarKeys.availability(organization.id, from ?? '', to ?? ''),
    queryFn: () => fetchAvailableVehicles(organization.id, from!, to!),
    enabled: Boolean(from && to && from < to),
    staleTime: 10_000,
  })
}

/**
 * Moving a booking.
 *
 * Deliberately not optimistic. A move can be refused by the database for a
 * reason the board cannot know — somebody took the slot a second ago — and a
 * block that slides into place and then jumps back is worse than one that waits.
 * On success every calendar, rental, fleet and overview query is invalidated,
 * because a move changes all four.
 */
export function useRescheduleRental() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: RescheduleInput) => rescheduleRental(input),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: calendarKeys.all(organization.id) }),
        client.invalidateQueries({ queryKey: ['organization', organization.id, 'rentals'] }),
        client.invalidateQueries({ queryKey: ['organization', organization.id, 'vehicles'] }),
        client.invalidateQueries({ queryKey: ['organization', organization.id, 'overview'] }),
        // Reports read the same contracts, so a rescheduled hire moves them.
        client.invalidateQueries({ queryKey: ['organization', organization.id, 'reports'] }),
      ])
    },
    // A refused move leaves the board showing stale truth about who holds the
    // slot, so the authoritative state is refetched either way.
    onError: async () => {
      await client.invalidateQueries({ queryKey: calendarKeys.all(organization.id) })
    },
  })
}
