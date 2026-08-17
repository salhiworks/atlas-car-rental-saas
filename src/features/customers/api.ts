import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type {
  Customer,
  CustomerDirectoryEntry,
  CustomerDocument,
  CustomerDuplicateRow,
  CustomerFinancialSummaryRow,
  CustomerRentalSummaryRow,
  CustomerUsageRow,
  TablesUpdate,
} from '@/types/database'

import { documentNumberKey } from './identity'
import type { CustomerDocumentFormValues, CustomerFormValues } from './schemas'

export const CUSTOMER_SORTS = {
  name: { column: 'display_name', ascending: true, label: 'Name (A–Z)' },
  name_desc: { column: 'display_name', ascending: false, label: 'Name (Z–A)' },
  newest: { column: 'created_at', ascending: false, label: 'Recently added' },
  oldest: { column: 'created_at', ascending: true, label: 'Oldest first' },
  last_rental: { column: 'last_rental_ends_at', ascending: false, label: 'Most recent rental' },
  most_rentals: { column: 'rental_count', ascending: false, label: 'Most rentals' },
} as const

export type CustomerSort = keyof typeof CUSTOMER_SORTS

export type LicenceFilter = 'any' | 'valid' | 'expired' | 'missing'
export type RentalFilter = 'any' | 'active' | 'outstanding' | 'never'

export interface CustomerQuery {
  readonly organizationId: string
  readonly search?: string
  readonly countries?: readonly string[]
  readonly licence?: LicenceFilter
  readonly rental?: RentalFilter
  readonly includeArchived?: boolean
  readonly sort?: CustomerSort
  readonly page?: number
  readonly pageSize?: number
}

export interface CustomerPage {
  readonly rows: CustomerDirectoryEntry[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly pageCount: number
}

export const DEFAULT_PAGE_SIZE = 25

/** PostgREST `or=` values are comma-separated, so a comma in the term would split it. */
function escapeForOrFilter(term: string): string {
  return term.replace(/[,()]/g, ' ').trim()
}

/**
 * Finds customer ids whose identification matches a search term.
 *
 * Kept as a separate, narrow query rather than folded into the directory view.
 * Putting a concatenation of every document number into a view column would make
 * it selectable by anything that can read the list, for no benefit — this way
 * the numbers stay in `customer_documents`, where reading them is already the
 * thing the policy governs.
 */
async function findCustomerIdsByDocument(organizationId: string, term: string): Promise<string[]> {
  const key = documentNumberKey(term)
  // Below four characters a document search matches most of the fleet's
  // paperwork and is not what the person meant.
  if (key.length < 4) return []

  const { data, error } = await getSupabaseClient()
    .from('customer_documents')
    .select('customer_id')
    .eq('organization_id', organizationId)
    .ilike('document_number_normalized', `%${key}%`)
    .limit(200)

  if (error) throw toAppError(error)
  return [...new Set((data ?? []).map((row) => row.customer_id))]
}

/**
 * One page of the customer list.
 *
 * Reads the `customer_directory` view, which already carries identification
 * validity, rental context and an unambiguous outstanding balance — so a page of
 * twenty-five customers is one request rather than twenty-five requests for
 * documents plus twenty-five for rentals.
 *
 * Tenancy is not a `where` clause the caller could forget: the view is SECURITY
 * INVOKER, so RLS scopes it. The organization filter narrows, it does not guard.
 */
export async function fetchCustomers(query: CustomerQuery): Promise<CustomerPage> {
  const supabase = getSupabaseClient()
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE))
  const sort = CUSTOMER_SORTS[query.sort ?? 'name']

  let request = supabase
    .from('customer_directory')
    .select('*', { count: 'exact' })
    .eq('organization_id', query.organizationId)

  if (!query.includeArchived) {
    request = request.is('archived_at', null)
  }

  const search = escapeForOrFilter(query.search ?? '')
  if (search.length > 0) {
    const pattern = `%${search}%`
    const clauses = [
      `display_name.ilike.${pattern}`,
      `email.ilike.${pattern}`,
      `phone.ilike.${pattern}`,
      `secondary_phone.ilike.${pattern}`,
    ]

    // A passport typed without spacing still has to find its customer.
    const matchedByDocument = await findCustomerIdsByDocument(query.organizationId, search)
    if (matchedByDocument.length > 0) {
      clauses.push(`customer_id.in.(${matchedByDocument.join(',')})`)
    }

    request = request.or(clauses.join(','))
  }

  if (query.countries && query.countries.length > 0) {
    request = request.in('nationality_country_code', [...query.countries])
  }

  const today = new Date().toISOString().slice(0, 10)
  if (query.licence === 'valid') {
    request = request.gte('driver_license_expires_on', today)
  } else if (query.licence === 'expired') {
    request = request.lt('driver_license_expires_on', today)
  } else if (query.licence === 'missing') {
    request = request.eq('has_driver_license', false)
  }

  if (query.rental === 'active') {
    request = request.not('active_rental_id', 'is', null)
  } else if (query.rental === 'outstanding') {
    request = request.gt('outstanding_currency_count', 0)
  } else if (query.rental === 'never') {
    request = request.eq('rental_count', 0)
  }

  const from = (page - 1) * pageSize
  const { data, error, count } = await request
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // Stable tiebreaker: without one, two customers sharing a sort value can swap
    // between pages and appear twice or not at all.
    .order('customer_id', { ascending: true })
    .range(from, from + pageSize - 1)

  if (error) throw toAppError(error)

  const total = count ?? 0
  return {
    rows: data ?? [],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** Distinct nationalities present in the agency, for the filter menu. */
export async function fetchCustomerCountries(organizationId: string): Promise<string[]> {
  const { data, error } = await getSupabaseClient()
    .from('customers')
    .select('nationality_country_code')
    .eq('organization_id', organizationId)
    .not('nationality_country_code', 'is', null)
    .order('nationality_country_code')

  if (error) throw toAppError(error)
  return [
    ...new Set(
      (data ?? []).flatMap((row) =>
        row.nationality_country_code ? [row.nationality_country_code] : [],
      ),
    ),
  ]
}

/**
 * One customer.
 *
 * An id from another agency and an id that does not exist produce the same
 * error. Distinguishing them would confirm that an identifier belongs to
 * somebody, which is exactly the leak a deep link must not have.
 */
export async function fetchCustomer(customerId: string): Promise<CustomerDirectoryEntry> {
  const { data, error } = await getSupabaseClient()
    .from('customer_directory')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (error) throw toAppError(error)
  if (!data) throw new AppError('notFound', 'This customer could not be found.')

  return data
}

interface CustomerWritePayload {
  customer_type: 'individual' | 'company'
  first_name: string | null
  last_name: string | null
  company_name: string | null
  email: string | null
  phone: string | null
  secondary_phone: string | null
  date_of_birth: string | null
  nationality_country_code: string | null
  preferred_locale: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country_code: string | null
  notes: string | null
}

function toRow(values: CustomerFormValues): CustomerWritePayload {
  return {
    customer_type: values.customerType,
    first_name: values.firstName,
    last_name: values.lastName,
    company_name: values.companyName,
    email: values.email,
    phone: values.phone,
    secondary_phone: values.secondaryPhone,
    date_of_birth: values.dateOfBirth,
    nationality_country_code: values.nationalityCountryCode,
    preferred_locale: values.preferredLocale,
    address_line1: values.addressLine1,
    address_line2: values.addressLine2,
    city: values.city,
    region: values.region,
    postal_code: values.postalCode,
    country_code: values.countryCode,
    notes: values.notes,
  }
}

export async function createCustomer(
  organizationId: string,
  values: CustomerFormValues,
): Promise<Customer> {
  const { data, error } = await getSupabaseClient()
    .from('customers')
    .insert({ organization_id: organizationId, ...toRow(values) })
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateCustomer(
  customerId: string,
  values: CustomerFormValues,
): Promise<Customer> {
  const { data, error } = await getSupabaseClient()
    .from('customers')
    .update(toRow(values))
    .eq('id', customerId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

/** Internal notes only — used by the profile's notes panel. */
export async function updateCustomerNotes(
  customerId: string,
  notes: string | null,
): Promise<Customer> {
  const { data, error } = await getSupabaseClient()
    .from('customers')
    .update({ notes })
    .eq('id', customerId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function archiveCustomer(customerId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('customers')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', customerId)

  if (error) throw toAppError(error)
}

export async function restoreCustomer(customerId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('customers')
    .update({ archived_at: null })
    .eq('id', customerId)

  if (error) throw toAppError(error)
}

/**
 * Permanent removal, possible only for a customer nothing financial refers to.
 * Rentals, rental_drivers and payments are ON DELETE RESTRICT, so this fails
 * rather than cascading through an agency's history.
 */
export async function deleteCustomer(customerId: string): Promise<void> {
  const { error } = await getSupabaseClient().from('customers').delete().eq('id', customerId)
  if (error) throw toAppError(error)
}

export async function fetchCustomerUsage(customerId: string): Promise<CustomerUsageRow> {
  const { data, error } = await getSupabaseClient().rpc('customer_usage', {
    p_customer_id: customerId,
  })

  if (error) throw toAppError(error)
  const row = data?.[0]
  if (!row) throw new AppError('notFound', 'This customer could not be found.')
  return row
}

export async function fetchRentalSummary(customerId: string): Promise<CustomerRentalSummaryRow> {
  const { data, error } = await getSupabaseClient().rpc('customer_rental_summary', {
    p_customer_id: customerId,
  })

  if (error) throw toAppError(error)
  return (
    data?.[0] ?? {
      rental_count: 0,
      completed_count: 0,
      cancelled_count: 0,
      first_rental_at: null,
      last_rental_ends_at: null,
      active_rental_id: null,
      upcoming_rental_id: null,
    }
  )
}

/** One row per currency — never a mixed-currency total. */
export async function fetchFinancialSummary(
  customerId: string,
): Promise<CustomerFinancialSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('customer_financial_summary', {
    p_customer_id: customerId,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export interface DuplicateProbe {
  readonly organizationId: string
  readonly email?: string | null
  readonly phone?: string | null
  readonly documents?: readonly {
    document_type: string
    document_number: string
    issuing_country?: string | null
  }[]
  readonly excludeCustomerId?: string | null
}

/**
 * Candidate duplicates, with the reason each one matched.
 *
 * Never merges anything and never reaches outside the caller's agency — the
 * function asserts membership and RLS scopes every table it reads, so a hint
 * about another organization is not expressible.
 */
export async function findDuplicates(probe: DuplicateProbe): Promise<CustomerDuplicateRow[]> {
  const { data, error } = await getSupabaseClient().rpc('find_customer_duplicates', {
    p_organization_id: probe.organizationId,
    p_email: probe.email ?? null,
    p_phone: probe.phone ?? null,
    p_documents: (probe.documents ?? []) as never,
    p_exclude_customer_id: probe.excludeCustomerId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

export async function fetchCustomerDocuments(customerId: string): Promise<CustomerDocument[]> {
  const { data, error } = await getSupabaseClient()
    .from('customer_documents')
    .select('*')
    .eq('customer_id', customerId)
    .order('document_type', { ascending: true })
    .order('expires_on', { ascending: false, nullsFirst: false })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function createCustomerDocument(
  organizationId: string,
  customerId: string,
  values: CustomerDocumentFormValues,
): Promise<CustomerDocument> {
  const { data, error } = await getSupabaseClient()
    .from('customer_documents')
    .insert({
      organization_id: organizationId,
      customer_id: customerId,
      document_type: values.documentType,
      document_number: values.documentNumber,
      issuing_country: values.issuingCountry,
      issued_on: values.issuedOn,
      expires_on: values.expiresOn,
      license_classes: values.licenseClasses,
      notes: values.notes,
    })
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateCustomerDocument(
  documentId: string,
  changes: TablesUpdate<'customer_documents'>,
): Promise<CustomerDocument> {
  const { data, error } = await getSupabaseClient()
    .from('customer_documents')
    .update(changes)
    .eq('id', documentId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function deleteCustomerDocumentRow(documentId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('customer_documents')
    .delete()
    .eq('id', documentId)

  if (error) throw toAppError(error)
}
