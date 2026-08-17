import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'

import { useOrganization } from '@/features/workspace/workspace-context'
import type { RentalConditionPhoto } from '@/types/database'

import {
  type AddChargeInput,
  type CreateRentalInput,
  type ExtendRentalInput,
  type HandoverInput,
  type RecordPaymentInput,
  type RentalQuery,
  type SignContractInput,
  type UpdateRentalInput,
  addCharge,
  cancelRental,
  checkInRental,
  checkOutRental,
  completeRental,
  confirmRental,
  createRental,
  deleteRental,
  extendRental,
  fetchAvailableVehicleIds,
  fetchConditionPhotos,
  fetchPeriodConflicts,
  fetchRental,
  fetchRentalBoardEntry,
  fetchRentalContracts,
  fetchRentalDrivers,
  fetchRentalLineItems,
  fetchRentalPayments,
  fetchRentalUsage,
  fetchRentalSummary,
  fetchRentals,
  issueContract,
  recordPayment,
  removeCharge,
  signContract,
  substituteVehicle,
  updateRental,
  voidPayment,
} from './api'
import { deleteConditionPhoto, signRentalUrls, uploadConditionPhoto } from './storage'

/**
 * Query keys for rentals.
 *
 * Every key starts with the organization id, so switching agency cannot serve a
 * cached list from the previous one, and the workspace switcher's blanket
 * `['organization']` invalidation reaches all of them.
 */
export const rentalKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'rentals'] as const,
  list: (organizationId: string, query: Omit<RentalQuery, 'organizationId'>) =>
    ['organization', organizationId, 'rentals', 'list', query] as const,
  detail: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'detail', rentalId] as const,
  board: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'board', rentalId] as const,
  lines: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'lines', rentalId] as const,
  drivers: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'drivers', rentalId] as const,
  payments: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'payments', rentalId] as const,
  contracts: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'contracts', rentalId] as const,
  photos: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'photos', rentalId] as const,
  summary: (organizationId: string, day: string) =>
    ['organization', organizationId, 'rentals', 'summary', day] as const,
  usage: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'rentals', 'usage', rentalId] as const,
  availability: (organizationId: string, from: string, to: string, exclude: string | null) =>
    ['organization', organizationId, 'rentals', 'availability', from, to, exclude] as const,
  conflicts: (organizationId: string, vehicleId: string, from: string, to: string) =>
    ['organization', organizationId, 'rentals', 'conflicts', vehicleId, from, to] as const,
  photoUrls: (organizationId: string, paths: readonly string[]) =>
    ['organization', organizationId, 'rentals', 'photo-urls', paths] as const,
}

/**
 * Anything that changes a rental can change the list, the fleet's occupancy and
 * the dashboard. Invalidating those three subtrees is one line each and cannot
 * miss a key; a hand-written list of individual invalidations goes stale the
 * first time somebody adds a query.
 */
async function invalidateRentals(client: QueryClient, organizationId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: rentalKeys.all(organizationId) }),
    // A rental holds a vehicle, so occupancy and the overview move with it.
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'vehicles'] }),
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'overview'] }),
    // And the scheduling board draws the same contracts. Without this, checking
    // a vehicle out from the rental page left the Calendar showing it as still
    // reserved until something else happened to refetch.
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'calendar'] }),
    // Reports read the same money from the same tables, so a recorded
    // payment or cost has to move them too.
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'reports'] }),
  ])
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export function useRentalList(query: Omit<RentalQuery, 'organizationId'>) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.list(organization.id, query),
    queryFn: () => fetchRentals({ organizationId: organization.id, ...query }),
    // Keeps the current page on screen while the next loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}

/** Today's collections, returns, overdue vehicles and unpaid balances. */
export function useRentalSummary(dayStart: string, dayEnd: string) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.summary(organization.id, dayStart),
    queryFn: () => fetchRentalSummary(organization.id, dayStart, dayEnd),
    staleTime: 30_000,
  })
}

export function useRental(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.detail(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRental(rentalId!),
    enabled: Boolean(rentalId),
    retry: false,
  })
}

export function useRentalBoardEntry(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.board(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalBoardEntry(rentalId!),
    enabled: Boolean(rentalId),
    retry: false,
  })
}

export function useRentalLineItems(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.lines(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalLineItems(rentalId!),
    enabled: Boolean(rentalId),
  })
}

export function useRentalDrivers(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.drivers(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalDrivers(rentalId!),
    enabled: Boolean(rentalId),
  })
}

export function useRentalPayments(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.payments(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalPayments(rentalId!),
    enabled: Boolean(rentalId),
  })
}

export function useRentalContracts(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.contracts(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalContracts(rentalId!),
    enabled: Boolean(rentalId),
  })
}

export function useConditionPhotos(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.photos(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchConditionPhotos(rentalId!),
    enabled: Boolean(rentalId),
  })
}

export function useRentalUsage(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.usage(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalUsage(rentalId!),
    enabled: Boolean(rentalId),
    retry: false,
  })
}

/** Signed URLs for a rental's condition photographs, keyed by photo id. */
export function useConditionPhotoUrls(photos: readonly RentalConditionPhoto[]) {
  const organization = useOrganization()
  const paths = useMemo(() => photos.map((photo) => photo.storage_path), [photos])

  const query = useQuery({
    queryKey: rentalKeys.photoUrls(organization.id, paths),
    queryFn: () => signRentalUrls(paths),
    enabled: paths.length > 0,
    // Comfortably inside the signature's lifetime so a rendered URL never lapses.
    staleTime: 45 * 60_000,
  })

  return useMemo(() => {
    const byPhoto = new Map<string, string>()
    if (query.data) {
      for (const photo of photos) {
        const url = query.data.get(photo.storage_path)
        if (url) byPhoto.set(photo.id, url)
      }
    }
    return byPhoto
  }, [photos, query.data])
}

/**
 * Which vehicles are free for a period.
 *
 * Only asked once both ends of the period are known; an availability answer for
 * half a period would be meaningless.
 */
export function useAvailableVehicles(
  from: string | null,
  to: string | null,
  excludeRentalId?: string,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.availability(
      organization.id,
      from ?? '',
      to ?? '',
      excludeRentalId ?? null,
    ),
    queryFn: () => fetchAvailableVehicleIds(organization.id, from!, to!, excludeRentalId),
    enabled: Boolean(from && to && from < to),
    staleTime: 10_000,
  })
}

export function usePeriodConflicts(
  vehicleId: string | null,
  from: string | null,
  to: string | null,
  excludeRentalId?: string,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: rentalKeys.conflicts(organization.id, vehicleId ?? '', from ?? '', to ?? ''),
    queryFn: () => fetchPeriodConflicts(vehicleId!, from!, to!, excludeRentalId),
    enabled: Boolean(vehicleId && from && to && from < to),
  })
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export function useCreateRental() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<CreateRentalInput, 'organizationId'>) =>
      createRental({ ...input, organizationId: organization.id }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useUpdateRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<UpdateRentalInput, 'rentalId'>) =>
      updateRental({ ...input, rentalId }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useDeleteRental() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (rentalId: string) => deleteRental(rentalId),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

/**
 * The lifecycle steps.
 *
 * None of these is applied optimistically. Every one of them can be refused by
 * the database for a reason the screen cannot know — a vehicle taken in the
 * meantime, an odometer that would go backwards — and showing a rental as
 * confirmed before the server agrees would be showing a booking that does not
 * exist.
 */
export function useConfirmRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => confirmRental(rentalId),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useCheckOutRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<HandoverInput, 'rentalId'>) => checkOutRental({ ...input, rentalId }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useCheckInRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<HandoverInput, 'rentalId'>) => checkInRental({ ...input, rentalId }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useCompleteRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => completeRental(rentalId),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useCancelRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (reason: string | null) => cancelRental(rentalId, reason),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useExtendRental(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<ExtendRentalInput, 'rentalId'>) =>
      extendRental({ ...input, rentalId }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useSubstituteVehicle(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (vehicleId: string) => substituteVehicle(rentalId, vehicleId),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useAddCharge(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<AddChargeInput, 'organizationId' | 'rentalId'>) =>
      addCharge({ ...input, organizationId: organization.id, rentalId }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useRemoveCharge() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (lineItemId: string) => removeCharge(lineItemId),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useRecordPayment(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: Omit<RecordPaymentInput, 'rentalId'>) =>
      recordPayment({ ...input, rentalId }),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useVoidPayment() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string | null }) =>
      voidPayment(paymentId, reason),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useIssueContract(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (reason: string | null) => issueContract(rentalId, reason),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useSignContract() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: SignContractInput) => signContract(input),
    onSuccess: () => invalidateRentals(client, organization.id),
  })
}

export function useUploadConditionPhoto(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { file: File; phase: 'pickup' | 'return'; caption: string | null }) =>
      uploadConditionPhoto({ ...input, organizationId: organization.id, rentalId }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: rentalKeys.photos(organization.id, rentalId) }),
  })
}

export function useDeleteConditionPhoto(rentalId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (photo: RentalConditionPhoto) => deleteConditionPhoto(photo),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: rentalKeys.photos(organization.id, rentalId) }),
  })
}
