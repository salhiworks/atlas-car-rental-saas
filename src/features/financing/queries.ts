import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import { useAuth } from '@/features/auth/auth-context'
import { useOrganization } from '@/features/workspace/workspace-context'
import type {
  FinancingAgreementStatus,
  FinancingDocument,
  FinancingDocumentKind,
} from '@/types/database'

import {
  type AgreementQuery,
  activateAgreement,
  closeAgreement,
  createAgreement,
  createLender,
  deleteAgreement,
  fetchAgreement,
  fetchAgreements,
  fetchChangeEvents,
  fetchDueObligations,
  fetchLenderUsage,
  fetchLenders,
  fetchOrganizationFinancingSummary,
  fetchPayments,
  fetchProjectedSchedule,
  fetchSchedule,
  fetchVehicleAgreements,
  fetchVehicleFinancingSummary,
  findDuplicateLenders,
  findDuplicatePayments,
  recordPayment,
  regenerateSchedule,
  setLenderArchived,
  updateAcquisition,
  updateAgreement,
  updateAgreementNotes,
  updateLender,
  voidPayment,
} from './api'
import type {
  AcquisitionFormValues,
  AgreementFormValues,
  FinancingPaymentFormValues,
  LenderFormValues,
} from './schemas'
import {
  deleteFinancingDocument,
  fetchFinancingDocuments,
  uploadFinancingDocument,
} from './storage'

/**
 * Query keys for financing.
 *
 * Every key starts with the organization id, so switching agency cannot serve
 * one agency's agreements from another's cache, and the workspace switcher's
 * blanket `['organization']` invalidation reaches all of them.
 */
export const financingKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'financing'] as const,
  list: (organizationId: string, query: Omit<AgreementQuery, 'organizationId'>) =>
    ['organization', organizationId, 'financing', 'list', query] as const,
  detail: (organizationId: string, agreementId: string) =>
    ['organization', organizationId, 'financing', 'detail', agreementId] as const,
  schedule: (organizationId: string, agreementId: string) =>
    ['organization', organizationId, 'financing', 'schedule', agreementId] as const,
  payments: (organizationId: string, agreementId: string) =>
    ['organization', organizationId, 'financing', 'payments', agreementId] as const,
  documents: (organizationId: string, agreementId: string) =>
    ['organization', organizationId, 'financing', 'documents', agreementId] as const,
  changes: (organizationId: string, agreementId: string) =>
    ['organization', organizationId, 'financing', 'changes', agreementId] as const,
  summary: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'financing', 'summary', from, to] as const,
  due: (organizationId: string, withinDays: number) =>
    ['organization', organizationId, 'financing', 'due', withinDays] as const,
  lenders: (organizationId: string, includeArchived: boolean, search: string) =>
    ['organization', organizationId, 'financing', 'lenders', includeArchived, search] as const,
  vehicle: (organizationId: string, vehicleId: string) =>
    ['organization', organizationId, 'financing', 'vehicle', vehicleId] as const,
  vehicleSummary: (organizationId: string, vehicleId: string, from: string, to: string) =>
    ['organization', organizationId, 'financing', 'vehicle-summary', vehicleId, from, to] as const,
}

/**
 * A financing change moves an agreement, a schedule, a vehicle's economics and
 * the dashboard's obligation context. Invalidating the whole subtree is one line
 * and cannot miss a key; a hand-written list goes stale the first time somebody
 * adds a query.
 */
async function invalidateFinancing(client: QueryClient, organizationId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: financingKeys.all(organizationId) }),
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'vehicles'] }),
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'overview'] }),
    // Reports read the same money from the same tables, so a recorded
    // payment or cost has to move them too.
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'reports'] }),
  ])
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export function useAgreementList(query: Omit<AgreementQuery, 'organizationId'>) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.list(organization.id, query),
    queryFn: () => fetchAgreements({ organizationId: organization.id, ...query }),
    // Keeps the current page on screen while the next loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}

export function useAgreement(agreementId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.detail(organization.id, agreementId ?? 'none'),
    queryFn: () => fetchAgreement(agreementId!),
    enabled: Boolean(agreementId),
    retry: false,
  })
}

/** The schedule, fetched only where somebody is looking at one. */
export function useSchedule(agreementId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.schedule(organization.id, agreementId ?? 'none'),
    queryFn: () => fetchSchedule(agreementId!),
    enabled: Boolean(agreementId),
    staleTime: 15_000,
  })
}

export function useAgreementPayments(agreementId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.payments(organization.id, agreementId ?? 'none'),
    queryFn: () => fetchPayments(agreementId!),
    enabled: Boolean(agreementId),
    staleTime: 15_000,
  })
}

export function useFinancingDocuments(agreementId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.documents(organization.id, agreementId ?? 'none'),
    queryFn: () => fetchFinancingDocuments(agreementId!),
    enabled: Boolean(agreementId),
  })
}

export function useFinancingChanges(agreementId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.changes(organization.id, agreementId ?? 'none'),
    queryFn: () => fetchChangeEvents(agreementId!),
    enabled: Boolean(agreementId),
  })
}

export function useFinancingSummary(from: string, to: string, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.summary(organization.id, from, to),
    queryFn: () => fetchOrganizationFinancingSummary(organization.id, from, to),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useDueObligations(withinDays = 30, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.due(organization.id, withinDays),
    queryFn: () => fetchDueObligations(organization.id, withinDays),
    enabled,
    staleTime: 60_000,
  })
}

export function useLenders({ includeArchived = false, search = '' } = {}, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.lenders(organization.id, includeArchived, search),
    queryFn: () => fetchLenders(organization.id, { includeArchived, search }),
    enabled,
    staleTime: 60_000,
  })
}

export function useVehicleAgreements(vehicleId: string | undefined, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.vehicle(organization.id, vehicleId ?? 'none'),
    queryFn: () => fetchVehicleAgreements(vehicleId!),
    enabled: enabled && Boolean(vehicleId),
    staleTime: 30_000,
  })
}

export function useVehicleFinancingSummary(
  vehicleId: string | undefined,
  from: string,
  to: string,
  enabled = true,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: financingKeys.vehicleSummary(organization.id, vehicleId ?? 'none', from, to),
    queryFn: () => fetchVehicleFinancingSummary(vehicleId!, from, to),
    enabled: enabled && Boolean(vehicleId),
    staleTime: 30_000,
  })
}

/** The database's own projection, used to confirm what the wizard drew. */
export function useProjectedSchedule(
  terms: Parameters<typeof fetchProjectedSchedule>[0] | null,
  enabled: boolean,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: ['organization', organization.id, 'financing', 'projection', terms] as const,
    queryFn: () => fetchProjectedSchedule(terms!),
    enabled: enabled && terms !== null,
    staleTime: 60_000,
    retry: false,
  })
}

export function useDuplicateLenders(name: string, taxIdentifier: string, enabled: boolean) {
  const organization = useOrganization()

  return useQuery({
    queryKey: [
      'organization',
      organization.id,
      'financing',
      'lender-duplicates',
      name,
      taxIdentifier,
    ] as const,
    queryFn: () =>
      findDuplicateLenders(organization.id, name, taxIdentifier === '' ? null : taxIdentifier),
    enabled: enabled && name.trim().length >= 2,
    staleTime: 10_000,
  })
}

export function useDuplicatePayments(
  probe: Parameters<typeof findDuplicatePayments>[0] | null,
  enabled: boolean,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: ['organization', organization.id, 'financing', 'payment-duplicates', probe] as const,
    queryFn: () => findDuplicatePayments(probe!),
    enabled: enabled && probe !== null,
    staleTime: 10_000,
  })
}

export function useLenderUsage(lenderId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: [...financingKeys.all(organization.id), 'lender-usage', lenderId] as const,
    queryFn: () => fetchLenderUsage(lenderId!),
    enabled: Boolean(lenderId),
    retry: false,
  })
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export function useCreateAgreement() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: AgreementFormValues) => createAgreement(organization.id, values),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useUpdateAgreement(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()
  const { user } = useAuth()

  return useMutation({
    mutationFn: (values: AgreementFormValues) =>
      updateAgreement(agreementId, values, user?.id ?? null),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useUpdateAgreementNotes(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: { reference: string | null; notes: string | null }) =>
      updateAgreementNotes(agreementId, values),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useActivateAgreement(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => activateAgreement(agreementId),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useRegenerateSchedule(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => regenerateSchedule(agreementId),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

/**
 * Ending an agreement.
 *
 * Deliberately not optimistic: it changes what the agency believes it owes, and
 * a figure that moves before the server agrees — and then moves back — is worse
 * than one that waits half a second.
 */
export function useCloseAgreement(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      status: FinancingAgreementStatus
      reason: string | null
      payoffOn: string | null
    }) => closeAgreement(agreementId, input.status, input.reason, input.payoffOn),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useDeleteAgreement() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (agreementId: string) => deleteAgreement(agreementId),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useRecordPayment(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: FinancingPaymentFormValues) => recordPayment(agreementId, values),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useVoidPayment() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string | null }) =>
      voidPayment(paymentId, reason),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useCreateLender() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: LenderFormValues) => createLender(organization.id, values),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useUpdateLender() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: LenderFormValues }) =>
      updateLender(id, values),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useSetLenderArchived() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      setLenderArchived(id, archived),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}

export function useUploadFinancingDocument(agreementId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      file: File
      kind: FinancingDocumentKind
      documentOn?: string | null
      reference?: string | null
    }) =>
      uploadFinancingDocument({
        organizationId: organization.id,
        agreementId,
        file: input.file,
        kind: input.kind,
        documentOn: input.documentOn ?? null,
        reference: input.reference ?? null,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: financingKeys.all(organization.id) }),
  })
}

export function useDeleteFinancingDocument() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (document: FinancingDocument) => deleteFinancingDocument(document),
    onSuccess: () => client.invalidateQueries({ queryKey: financingKeys.all(organization.id) }),
  })
}

export function useUpdateAcquisition(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: AcquisitionFormValues) => updateAcquisition(vehicleId, values),
    onSuccess: () => invalidateFinancing(client, organization.id),
  })
}
