import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import { useAuth } from '@/features/auth/auth-context'
import { useOrganization } from '@/features/workspace/workspace-context'
import type { ExpenseAttachment, ExpenseDocumentKind } from '@/types/database'

import {
  type DuplicateProbe,
  type ExpenseQuery,
  createCategory,
  createExpense,
  createVendor,
  fetchCategories,
  fetchCategoryBreakdown,
  fetchCategoryUsage,
  fetchChangeEvents,
  fetchExpense,
  fetchExpenseSummary,
  fetchExpenses,
  fetchRentalExpenseSummary,
  fetchRentalOptions,
  fetchVehicleOperatingSummary,
  fetchVehicleOptions,
  fetchVendorUsage,
  fetchVendors,
  findDuplicateExpenses,
  findDuplicateVendors,
  setCategoryArchived,
  setVendorArchived,
  updateCategory,
  updateExpense,
  updateVendor,
  voidExpense,
} from './api'
import type { CategoryFormValues, ExpenseFormValues, VendorFormValues } from './schemas'
import { deleteAttachment, fetchAttachments, uploadReceipt } from './storage'

/**
 * Query keys for costs.
 *
 * Every key starts with the organization id, so switching agency cannot serve a
 * cached ledger from the previous one, and the workspace switcher's blanket
 * `['organization']` invalidation reaches all of them.
 */
export const expenseKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'expenses'] as const,
  list: (organizationId: string, query: Omit<ExpenseQuery, 'organizationId'>) =>
    ['organization', organizationId, 'expenses', 'list', query] as const,
  detail: (organizationId: string, expenseId: string) =>
    ['organization', organizationId, 'expenses', 'detail', expenseId] as const,
  summary: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'expenses', 'summary', from, to] as const,
  breakdown: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'expenses', 'breakdown', from, to] as const,
  categories: (organizationId: string, includeArchived: boolean) =>
    ['organization', organizationId, 'expenses', 'categories', includeArchived] as const,
  vendors: (organizationId: string, includeArchived: boolean, search: string) =>
    ['organization', organizationId, 'expenses', 'vendors', includeArchived, search] as const,
  attachments: (organizationId: string, expenseId: string) =>
    ['organization', organizationId, 'expenses', 'attachments', expenseId] as const,
  duplicates: (organizationId: string, probe: Omit<DuplicateProbe, 'organizationId'>) =>
    ['organization', organizationId, 'expenses', 'duplicates', probe] as const,
  vendorDuplicates: (organizationId: string, name: string, taxIdentifier: string) =>
    ['organization', organizationId, 'expenses', 'vendor-duplicates', name, taxIdentifier] as const,
  changes: (organizationId: string, expenseId: string) =>
    ['organization', organizationId, 'expenses', 'changes', expenseId] as const,
  vehicleOperating: (organizationId: string, vehicleId: string, from: string, to: string) =>
    ['organization', organizationId, 'expenses', 'vehicle-operating', vehicleId, from, to] as const,
  rentalCosts: (organizationId: string, rentalId: string) =>
    ['organization', organizationId, 'expenses', 'rental-costs', rentalId] as const,
}

/**
 * A cost changes the ledger, the period summary, the category breakdown, the
 * vehicle's economics and the dashboard. Invalidating the whole subtree is one
 * line and cannot miss a key; a hand-written list goes stale the first time
 * somebody adds a query.
 */
async function invalidateExpenses(client: QueryClient, organizationId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: expenseKeys.all(organizationId) }),
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'overview'] }),
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'vehicles'] }),
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'rentals'] }),
    // Reports read the same money from the same tables, so a recorded
    // payment or cost has to move them too.
    client.invalidateQueries({ queryKey: ['organization', organizationId, 'reports'] }),
  ])
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export function useExpenseList(query: Omit<ExpenseQuery, 'organizationId'>) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.list(organization.id, query),
    queryFn: () => fetchExpenses({ organizationId: organization.id, ...query }),
    // Keeps the current page on screen while the next loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}

export function useExpense(expenseId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.detail(organization.id, expenseId ?? 'none'),
    queryFn: () => fetchExpense(expenseId!),
    enabled: Boolean(expenseId),
    retry: false,
  })
}

export function useExpenseSummary(from: string, to: string) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.summary(organization.id, from, to),
    queryFn: () => fetchExpenseSummary(organization.id, from, to),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useCategoryBreakdown(from: string, to: string) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.breakdown(organization.id, from, to),
    queryFn: () => fetchCategoryBreakdown(organization.id, from, to),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useExpenseCategories(includeArchived = false) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.categories(organization.id, includeArchived),
    queryFn: () => fetchCategories(organization.id, includeArchived),
    staleTime: 5 * 60_000,
  })
}

export function useExpenseVendors({ includeArchived = false, search = '' } = {}) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.vendors(organization.id, includeArchived, search),
    queryFn: () => fetchVendors(organization.id, { includeArchived, search }),
    staleTime: 60_000,
  })
}

export function useExpenseAttachments(expenseId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.attachments(organization.id, expenseId ?? 'none'),
    queryFn: () => fetchAttachments(expenseId!),
    enabled: Boolean(expenseId),
  })
}

/**
 * Costs that look like this one.
 *
 * Only asked once there is enough to ask about — a supplier plus either a
 * document number or an amount and a date. Firing on every keystroke would
 * produce a stream of meaningless answers.
 */
export function useDuplicateExpenses(
  probe: Omit<DuplicateProbe, 'organizationId'>,
  enabled: boolean,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.duplicates(organization.id, probe),
    queryFn: () => findDuplicateExpenses({ organizationId: organization.id, ...probe }),
    enabled,
    staleTime: 10_000,
  })
}

/** Suppliers resembling the one being typed, once there is enough to match on. */
export function useDuplicateVendors(name: string, taxIdentifier: string, enabled: boolean) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.vendorDuplicates(organization.id, name, taxIdentifier),
    queryFn: () =>
      findDuplicateVendors(organization.id, name, taxIdentifier === '' ? null : taxIdentifier),
    enabled: enabled && name.trim().length >= 2,
    staleTime: 10_000,
  })
}

export function useExpenseChanges(expenseId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.changes(organization.id, expenseId ?? 'none'),
    queryFn: () => fetchChangeEvents(expenseId!),
    enabled: Boolean(expenseId),
  })
}

export function useVehicleOperatingSummary(
  vehicleId: string | undefined,
  from: string,
  to: string,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.vehicleOperating(organization.id, vehicleId ?? 'none', from, to),
    queryFn: () => fetchVehicleOperatingSummary(vehicleId!, from, to),
    enabled: Boolean(vehicleId),
    staleTime: 30_000,
  })
}

export function useRentalExpenseSummary(rentalId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: expenseKeys.rentalCosts(organization.id, rentalId ?? 'none'),
    queryFn: () => fetchRentalExpenseSummary(rentalId!),
    enabled: Boolean(rentalId),
    staleTime: 30_000,
  })
}

/**
 * Pickers.
 *
 * Cached for the session rather than per screen: the fleet does not change
 * while somebody fills in a form, and re-fetching it for every cost recorded
 * would be a request nobody asked for.
 */
export function useVehicleOptions(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: ['organization', organization.id, 'vehicle-options'] as const,
    queryFn: () => fetchVehicleOptions(organization.id),
    enabled,
    staleTime: 5 * 60_000,
  })
}

export function useRentalOptions(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: ['organization', organization.id, 'rental-options'] as const,
    queryFn: () => fetchRentalOptions(organization.id),
    enabled,
    staleTime: 60_000,
  })
}

export function useCategoryUsage(categoryId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: [...expenseKeys.all(organization.id), 'category-usage', categoryId] as const,
    queryFn: () => fetchCategoryUsage(categoryId!),
    enabled: Boolean(categoryId),
    retry: false,
  })
}

export function useVendorUsage(vendorId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: [...expenseKeys.all(organization.id), 'vendor-usage', vendorId] as const,
    queryFn: () => fetchVendorUsage(vendorId!),
    enabled: Boolean(vendorId),
    retry: false,
  })
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export function useCreateExpense() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: ExpenseFormValues) => createExpense(organization.id, values),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useUpdateExpense(expenseId: string) {
  const organization = useOrganization()
  const client = useQueryClient()
  const { user } = useAuth()

  return useMutation({
    mutationFn: (values: ExpenseFormValues) => updateExpense(expenseId, values, user?.id ?? null),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

/**
 * Voiding.
 *
 * Deliberately not optimistic: this changes what the dashboard says the agency
 * earned, and a figure that moves before the server has agreed — and then moves
 * back — is worse than one that waits half a second.
 */
export function useVoidExpense(expenseId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (reason: string | null) => voidExpense(expenseId, reason),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useCreateCategory() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: CategoryFormValues) => createCategory(organization.id, values),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useUpdateCategory() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: CategoryFormValues }) =>
      updateCategory(id, values),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useSetCategoryArchived() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      setCategoryArchived(id, archived),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useCreateVendor() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: VendorFormValues) => createVendor(organization.id, values),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useUpdateVendor() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: VendorFormValues }) =>
      updateVendor(id, values),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useSetVendorArchived() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      setVendorArchived(id, archived),
    onSuccess: () => invalidateExpenses(client, organization.id),
  })
}

export function useUploadReceipt(expenseId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ file, kind }: { file: File; kind: ExpenseDocumentKind }) =>
      uploadReceipt({ organizationId: organization.id, expenseId, file, kind }),
    onSuccess: () => client.invalidateQueries({ queryKey: expenseKeys.all(organization.id) }),
  })
}

export function useDeleteAttachment() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (attachment: ExpenseAttachment) => deleteAttachment(attachment),
    onSuccess: () => client.invalidateQueries({ queryKey: expenseKeys.all(organization.id) }),
  })
}
