import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import { useOrganization } from '@/features/workspace/workspace-context'
import type { CustomerDocument } from '@/types/database'

import {
  type CustomerQuery,
  type DuplicateProbe,
  archiveCustomer,
  createCustomer,
  createCustomerDocument,
  deleteCustomer,
  fetchCustomer,
  fetchCustomerCountries,
  fetchCustomerDocuments,
  fetchCustomerUsage,
  fetchCustomers,
  fetchFinancialSummary,
  fetchRentalSummary,
  findDuplicates,
  restoreCustomer,
  updateCustomer,
  updateCustomerNotes,
} from './api'
import {
  deleteCustomerDocument,
  removeCustomerDocumentFile,
  uploadCustomerDocumentFile,
} from './documents'
import type { CustomerDocumentFormValues, CustomerFormValues } from './schemas'

/**
 * Query keys for customers.
 *
 * Prefixed with the organization id like every other module's, so switching
 * agency cannot serve a cached list from the previous one and the workspace
 * switcher's blanket `['organization']` invalidation reaches all of them.
 */
export const customerKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'customers'] as const,
  list: (organizationId: string, query: Omit<CustomerQuery, 'organizationId'>) =>
    ['organization', organizationId, 'customers', 'list', query] as const,
  countries: (organizationId: string) =>
    ['organization', organizationId, 'customers', 'countries'] as const,
  detail: (organizationId: string, customerId: string) =>
    ['organization', organizationId, 'customers', 'detail', customerId] as const,
  documents: (organizationId: string, customerId: string) =>
    ['organization', organizationId, 'customers', 'documents', customerId] as const,
  usage: (organizationId: string, customerId: string) =>
    ['organization', organizationId, 'customers', 'usage', customerId] as const,
  rentals: (organizationId: string, customerId: string) =>
    ['organization', organizationId, 'customers', 'rentals', customerId] as const,
  finance: (organizationId: string, customerId: string) =>
    ['organization', organizationId, 'customers', 'finance', customerId] as const,
  duplicates: (organizationId: string, probe: unknown) =>
    ['organization', organizationId, 'customers', 'duplicates', probe] as const,
}

/**
 * Anything that changed a customer can change the list, the filters and the
 * derived summaries. Invalidating the subtree is one line and cannot miss a key.
 */
async function invalidateCustomers(client: QueryClient, organizationId: string): Promise<void> {
  await client.invalidateQueries({ queryKey: customerKeys.all(organizationId) })
}

export function useCustomerList(query: Omit<CustomerQuery, 'organizationId'>) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.list(organization.id, query),
    queryFn: () => fetchCustomers({ organizationId: organization.id, ...query }),
    // Keeps the current page on screen while the next loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}

export function useCustomerCountries() {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.countries(organization.id),
    queryFn: () => fetchCustomerCountries(organization.id),
    staleTime: 5 * 60_000,
  })
}

export function useCustomer(customerId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.detail(organization.id, customerId ?? 'none'),
    queryFn: () => fetchCustomer(customerId!),
    enabled: Boolean(customerId),
    retry: false,
  })
}

export function useCustomerDocuments(customerId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.documents(organization.id, customerId ?? 'none'),
    queryFn: () => fetchCustomerDocuments(customerId!),
    enabled: Boolean(customerId),
  })
}

export function useCustomerUsage(customerId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.usage(organization.id, customerId ?? 'none'),
    queryFn: () => fetchCustomerUsage(customerId!),
    enabled: Boolean(customerId),
    retry: false,
  })
}

export function useCustomerRentalSummary(customerId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.rentals(organization.id, customerId ?? 'none'),
    queryFn: () => fetchRentalSummary(customerId!),
    enabled: Boolean(customerId),
    retry: false,
  })
}

export function useCustomerFinancialSummary(customerId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.finance(organization.id, customerId ?? 'none'),
    queryFn: () => fetchFinancialSummary(customerId!),
    enabled: Boolean(customerId),
    retry: false,
  })
}

/**
 * Looks for possible duplicates while a customer is being entered.
 *
 * Disabled until there is something worth matching on, so an empty form does not
 * ask the server whether nobody is somebody.
 */
export function useDuplicateCheck(probe: Omit<DuplicateProbe, 'organizationId'>, enabled: boolean) {
  const organization = useOrganization()

  return useQuery({
    queryKey: customerKeys.duplicates(organization.id, probe),
    queryFn: () => findDuplicates({ organizationId: organization.id, ...probe }),
    enabled,
    staleTime: 30_000,
    retry: false,
  })
}

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

export function useCreateCustomer() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: CustomerFormValues) => createCustomer(organization.id, values),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useUpdateCustomer(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: CustomerFormValues) => updateCustomer(customerId, values),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useUpdateCustomerNotes(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (notes: string | null) => updateCustomerNotes(customerId, notes),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useArchiveCustomer(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => archiveCustomer(customerId),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useRestoreCustomer(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => restoreCustomer(customerId),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useDeleteCustomer(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => deleteCustomer(customerId),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useCreateCustomerDocument(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: CustomerDocumentFormValues) =>
      createCustomerDocument(organization.id, customerId, values),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useUploadDocumentFile(customerId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: ({ document, file }: { document: CustomerDocument; file: File }) =>
      uploadCustomerDocumentFile({
        organizationId: organization.id,
        customerId,
        document,
        file,
      }),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useRemoveDocumentFile() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (document: CustomerDocument) => removeCustomerDocumentFile(document),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}

export function useDeleteCustomerDocument() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (document: CustomerDocument) => deleteCustomerDocument(document),
    onSuccess: () => invalidateCustomers(client, organization.id),
  })
}
