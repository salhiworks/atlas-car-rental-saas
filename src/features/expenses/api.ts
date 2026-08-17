import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type {
  DuplicateExpenseRow,
  DuplicateVendorRow,
  ExpenseChangeEvent,
  Expense,
  ExpenseAllocation,
  ExpenseCategoryBreakdownRow,
  ExpenseCategoryRecord,
  ExpenseLedgerEntry,
  ExpenseStatus,
  ExpenseSummaryRow,
  ExpenseUsageRow,
  ExpenseVendor,
  RentalExpenseSummaryRow,
  VehicleOperatingSummaryRow,
} from '@/types/database'

import { relationColumns } from './allocation'
import type { CategoryFormValues, ExpenseFormValues, VendorFormValues } from './schemas'

/**
 * What the Expenses module asks of the database.
 *
 * Every list reads `expense_ledger`, which has already resolved the category,
 * the supplier, the vehicle and the contract — so a page of fifty costs is one
 * request rather than two hundred. Tenancy is never a `where` clause the caller
 * could forget: the view is security_invoker, so RLS scopes it and the
 * organization filter only narrows.
 */

export const EXPENSE_SORTS = {
  date: { column: 'incurred_on', ascending: false, label: 'Most recent' },
  date_asc: { column: 'incurred_on', ascending: true, label: 'Oldest first' },
  amount: { column: 'amount_minor', ascending: false, label: 'Largest amount' },
  amount_asc: { column: 'amount_minor', ascending: true, label: 'Smallest amount' },
} as const

export type ExpenseSort = keyof typeof EXPENSE_SORTS
export type ExpenseStatusFilter = ExpenseStatus | 'all'

export interface ExpenseQuery {
  readonly organizationId: string
  readonly search?: string
  readonly from?: string
  readonly to?: string
  readonly categoryIds?: readonly string[]
  readonly allocation?: ExpenseAllocation | 'any'
  readonly vehicleId?: string
  readonly rentalId?: string
  readonly vendorId?: string
  readonly currency?: string
  readonly status?: ExpenseStatusFilter
  readonly sort?: ExpenseSort
  readonly page?: number
  readonly pageSize?: number
}

export interface ExpensePage {
  readonly rows: ExpenseLedgerEntry[]
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

export async function fetchExpenses(query: ExpenseQuery): Promise<ExpensePage> {
  const supabase = getSupabaseClient()
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE))
  const sort = EXPENSE_SORTS[query.sort ?? 'date']

  let request = supabase
    .from('expense_ledger')
    .select('*', { count: 'exact' })
    .eq('organization_id', query.organizationId)

  // Recorded by default: a voided cost is history, not the working list.
  const status = query.status ?? 'recorded'
  if (status !== 'all') request = request.eq('status', status)

  if (query.from) request = request.gte('incurred_on', query.from)
  if (query.to) request = request.lt('incurred_on', query.to)
  if (query.categoryIds && query.categoryIds.length > 0) {
    request = request.in('category_id', [...query.categoryIds])
  }
  if (query.allocation && query.allocation !== 'any') {
    request = request.eq('allocation', query.allocation)
  }
  if (query.vehicleId) request = request.eq('effective_vehicle_id', query.vehicleId)
  if (query.rentalId) request = request.eq('rental_id', query.rentalId)
  if (query.vendorId) request = request.eq('vendor_id', query.vendorId)
  if (query.currency) request = request.eq('currency', query.currency)

  const search = escapeForOrFilter(query.search ?? '')
  if (search.length > 0) {
    const pattern = `%${search}%`
    // Deliberately not the customer's name: a cost is the agency's business,
    // and the renter's identity has no place in a spend search.
    request = request.or(
      [
        `description.ilike.${pattern}`,
        `vendor_name.ilike.${pattern}`,
        `reference.ilike.${pattern}`,
        `vehicle_plate.ilike.${pattern}`,
        `rental_reference.ilike.${pattern}`,
        `category_name.ilike.${pattern}`,
      ].join(','),
    )
  }

  const fromRow = (page - 1) * pageSize
  const { data, error, count } = await request
    .order(sort.column, { ascending: sort.ascending })
    .order('created_at', { ascending: false })
    .range(fromRow, fromRow + pageSize - 1)

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

export async function fetchExpense(expenseId: string): Promise<ExpenseLedgerEntry> {
  const { data, error } = await getSupabaseClient()
    .from('expense_ledger')
    .select('*')
    .eq('id', expenseId)
    .single()

  if (error) throw toAppError(error)
  return data
}

// -----------------------------------------------------------------------------
// Summaries
// -----------------------------------------------------------------------------

export async function fetchExpenseSummary(
  organizationId: string,
  from: string,
  to: string,
): Promise<ExpenseSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('organization_expense_summary', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchCategoryBreakdown(
  organizationId: string,
  from: string,
  to: string,
): Promise<ExpenseCategoryBreakdownRow[]> {
  const { data, error } = await getSupabaseClient().rpc('expense_category_breakdown', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchVehicleOperatingSummary(
  vehicleId: string,
  from: string,
  to: string,
): Promise<VehicleOperatingSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('vehicle_operating_summary', {
    p_vehicle_id: vehicleId,
    p_from: from,
    p_to: to,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchRentalExpenseSummary(
  rentalId: string,
): Promise<RentalExpenseSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('rental_expense_summary', {
    p_rental_id: rentalId,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

export async function fetchCategories(
  organizationId: string,
  includeArchived = false,
): Promise<ExpenseCategoryRecord[]> {
  let request = getSupabaseClient()
    .from('expense_categories')
    .select('*')
    .eq('organization_id', organizationId)

  if (!includeArchived) request = request.is('archived_at', null)

  const { data, error } = await request
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function createCategory(
  organizationId: string,
  values: CategoryFormValues,
): Promise<ExpenseCategoryRecord> {
  const { data, error } = await getSupabaseClient()
    .from('expense_categories')
    .insert({
      organization_id: organizationId,
      name: values.name,
      description: values.description,
      default_allocation: (values.defaultAllocation as ExpenseAllocation | null) ?? null,
      // After the seeded set, so an agency's own categories sort below them.
      sort_order: 500,
    })
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateCategory(
  categoryId: string,
  values: CategoryFormValues,
): Promise<ExpenseCategoryRecord> {
  const { data, error } = await getSupabaseClient()
    .from('expense_categories')
    .update({
      name: values.name,
      description: values.description,
      default_allocation: (values.defaultAllocation as ExpenseAllocation | null) ?? null,
    })
    .eq('id', categoryId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

/**
 * Archiving, not deleting.
 *
 * A category with history behind it has to keep existing or every cost that
 * used it would read "Unknown". Archived means "not offered for new costs",
 * never "gone".
 */
export async function setCategoryArchived(
  categoryId: string,
  archived: boolean,
): Promise<ExpenseCategoryRecord> {
  const { data, error } = await getSupabaseClient()
    .from('expense_categories')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', categoryId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function fetchCategoryUsage(categoryId: string): Promise<ExpenseUsageRow> {
  const { data, error } = await getSupabaseClient().rpc('expense_category_usage', {
    p_category_id: categoryId,
  })

  if (error) throw toAppError(error)
  return data?.[0] ?? { expense_count: 0, can_delete: false }
}

// -----------------------------------------------------------------------------
// Vendors
// -----------------------------------------------------------------------------

export async function fetchVendors(
  organizationId: string,
  { includeArchived = false, search = '' } = {},
): Promise<ExpenseVendor[]> {
  let request = getSupabaseClient()
    .from('expense_vendors')
    .select('*')
    .eq('organization_id', organizationId)

  if (!includeArchived) request = request.is('archived_at', null)
  if (search.trim() !== '') request = request.ilike('name', `%${escapeForOrFilter(search)}%`)

  const { data, error } = await request.order('name', { ascending: true }).limit(200)

  if (error) throw toAppError(error)
  return data ?? []
}

export async function createVendor(
  organizationId: string,
  values: VendorFormValues,
): Promise<ExpenseVendor> {
  const { data, error } = await getSupabaseClient()
    .from('expense_vendors')
    .insert({
      organization_id: organizationId,
      name: values.name,
      email: values.email,
      phone: values.phone,
      tax_identifier: values.taxIdentifier,
      address: values.address,
      notes: values.notes,
    })
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateVendor(
  vendorId: string,
  values: VendorFormValues,
): Promise<ExpenseVendor> {
  const { data, error } = await getSupabaseClient()
    .from('expense_vendors')
    .update({
      name: values.name,
      email: values.email,
      phone: values.phone,
      tax_identifier: values.taxIdentifier,
      address: values.address,
      notes: values.notes,
    })
    .eq('id', vendorId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function setVendorArchived(
  vendorId: string,
  archived: boolean,
): Promise<ExpenseVendor> {
  const { data, error } = await getSupabaseClient()
    .from('expense_vendors')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', vendorId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

/**
 * Suppliers that look like the one being entered.
 *
 * Warns; never merges. Archived suppliers are included so the interface can
 * offer to restore one rather than watch somebody create its twin.
 */
export async function findDuplicateVendors(
  organizationId: string,
  name: string,
  taxIdentifier: string | null,
  excludeVendorId?: string,
): Promise<DuplicateVendorRow[]> {
  const { data, error } = await getSupabaseClient().rpc('find_duplicate_vendors', {
    p_organization_id: organizationId,
    p_name: name,
    p_tax_identifier: taxIdentifier,
    p_exclude_vendor_id: excludeVendorId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchVendorUsage(vendorId: string): Promise<ExpenseUsageRow> {
  const { data, error } = await getSupabaseClient().rpc('expense_vendor_usage', {
    p_vendor_id: vendorId,
  })

  if (error) throw toAppError(error)
  return data?.[0] ?? { expense_count: 0, can_delete: false }
}

// -----------------------------------------------------------------------------
// Pickers and lookups
// -----------------------------------------------------------------------------

/**
 * Every vehicle and every recent contract, in the two columns a picker needs.
 *
 * A paged fleet list is the wrong shape here twice over: a hundred-car agency
 * would find the car it wants missing from the selector, and an import that
 * resolves plates against a page would reject rows for cars that plainly exist.
 * These are deliberately narrow reads — an id and a label — so the whole set is
 * cheap enough to hold.
 */
export interface VehicleOption {
  readonly id: string
  readonly registration_plate: string
  readonly make: string
  readonly model: string
  readonly archived_at: string | null
}

export const VEHICLE_OPTION_LIMIT = 2000

export async function fetchVehicleOptions(organizationId: string): Promise<VehicleOption[]> {
  const { data, error } = await getSupabaseClient()
    .from('vehicles')
    .select('id, registration_plate, make, model, archived_at')
    .eq('organization_id', organizationId)
    .order('registration_plate', { ascending: true })
    .limit(VEHICLE_OPTION_LIMIT)

  if (error) throw toAppError(error)
  return data ?? []
}

export interface RentalOption {
  readonly id: string
  readonly reference: string
  readonly starts_at: string
  readonly vehicle_id: string | null
}

export const RENTAL_OPTION_LIMIT = 500

export async function fetchRentalOptions(organizationId: string): Promise<RentalOption[]> {
  const { data, error } = await getSupabaseClient()
    .from('rentals')
    .select('id, reference, starts_at, vehicle_id')
    .eq('organization_id', organizationId)
    .order('starts_at', { ascending: false })
    .limit(RENTAL_OPTION_LIMIT)

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Recording, correcting
// -----------------------------------------------------------------------------

function expenseColumns(values: ExpenseFormValues) {
  return {
    incurred_on: values.incurredOn,
    description: values.description,
    amount_minor: values.amount,
    tax_amount_minor: values.taxAmount,
    tax_rate_bps: values.taxRateBps,
    tax_label: values.taxLabel,
    currency: values.currency,
    category_id: values.categoryId,
    allocation: values.allocation,
    ...relationColumns(values.allocation, {
      vehicleId: values.vehicleId,
      rentalId: values.rentalId,
    }),
    vendor_id: values.vendorId,
    payment_method: values.paymentMethod as never,
    reference: values.reference,
    notes: values.notes,
    odometer: values.odometer,
  }
}

export async function createExpense(
  organizationId: string,
  values: ExpenseFormValues,
): Promise<Expense> {
  const { data, error } = await getSupabaseClient()
    .from('expenses')
    .insert({ organization_id: organizationId, ...expenseColumns(values) })
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

/**
 * Editing a recorded cost.
 *
 * The amount, the date and the allocation stay editable, because a mistyped
 * figure is the commonest correction there is and forcing a void-and-re-enter
 * for a transposed digit would be worse. What is not negotiable is provenance:
 * `updated_by` and `updated_at` record who changed it and when, and the detail
 * page shows both.
 */
export async function updateExpense(
  expenseId: string,
  values: ExpenseFormValues,
  userId: string | null,
): Promise<Expense> {
  const { data, error } = await getSupabaseClient()
    .from('expenses')
    .update({ ...expenseColumns(values), updated_by: userId })
    .eq('id', expenseId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function voidExpense(expenseId: string, reason: string | null): Promise<Expense> {
  const { data, error } = await getSupabaseClient().rpc('expense_void', {
    p_expense_id: expenseId,
    p_reason: reason,
  })

  if (error) throw toAppError(error)
  if (data === null) throw toAppError(new Error('The database returned nothing for that void.'))
  return Array.isArray(data) ? (data[0] as Expense) : data
}

export interface DuplicateProbe {
  readonly organizationId: string
  readonly vendorId: string | null
  readonly reference: string | null
  readonly amountMinor: number | null
  readonly currency: string | null
  readonly incurredOn: string | null
  readonly excludeExpenseId?: string
}

export async function findDuplicateExpenses(probe: DuplicateProbe): Promise<DuplicateExpenseRow[]> {
  const { data, error } = await getSupabaseClient().rpc('find_duplicate_expenses', {
    p_organization_id: probe.organizationId,
    p_vendor_id: probe.vendorId,
    p_reference: probe.reference,
    p_amount_minor: probe.amountMinor,
    p_currency: probe.currency,
    p_incurred_on: probe.incurredOn,
    p_exclude_expense_id: probe.excludeExpenseId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

/**
 * What has been corrected on this cost.
 *
 * Read-only by construction: the table has no insert, update or delete grant,
 * so this is the only way the application touches it at all.
 */
export async function fetchChangeEvents(expenseId: string): Promise<ExpenseChangeEvent[]> {
  const { data, error } = await getSupabaseClient()
    .from('expense_change_events')
    .select('*')
    .eq('expense_id', expenseId)
    .order('changed_at', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}
