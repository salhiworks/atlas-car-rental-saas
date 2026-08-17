import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type {
  Payment,
  PaymentDirection,
  PaymentMethod,
  PaymentPurpose,
  Rental,
  RentalBoardEntry,
  RentalConditionPhoto,
  RentalConflict,
  RentalContract,
  RentalDriver,
  RentalLineItem,
  RentalStatus,
  RentalUsageRow,
} from '@/types/database'

import type { QuoteLine } from './pricing'

/**
 * Everything the rentals module asks of the database.
 *
 * Multi-record operations go through RPCs rather than a sequence of client
 * writes. Checking a vehicle out, for instance, changes the rental, advances
 * the vehicle's odometer and records who did it: as three requests, a dropped
 * connection between them leaves a rental that is active with no reading, or a
 * vehicle whose mileage moved without a contract to explain it. One function
 * call is one transaction.
 *
 * Tenancy is never a `where` clause the caller could forget. Every table and
 * view is under RLS; the organization filters here narrow a result, they do not
 * guard it.
 */

export const RENTAL_SORTS = {
  starting: { column: 'starts_at', ascending: true, label: 'Starting soonest' },
  starting_desc: { column: 'starts_at', ascending: false, label: 'Starting latest' },
  newest: { column: 'created_at', ascending: false, label: 'Recently added' },
  returning: { column: 'ends_at', ascending: true, label: 'Returning soonest' },
  balance: { column: 'balance_due_minor', ascending: false, label: 'Largest balance' },
} as const

export type RentalSort = keyof typeof RENTAL_SORTS

export type RentalStatusFilter = RentalStatus | 'live' | 'all'
export type RentalPaymentFilter = 'any' | 'outstanding' | 'settled'

/** The four things a rental desk looks at, each a count and a list of the same rows. */
export type RentalDeskView = 'collecting' | 'returning' | 'overdue' | 'outstanding'

export const RENTAL_DESK_VIEWS: readonly RentalDeskView[] = [
  'collecting',
  'returning',
  'overdue',
  'outstanding',
]

export function isRentalDeskView(value: string): value is RentalDeskView {
  return (RENTAL_DESK_VIEWS as readonly string[]).includes(value)
}

/**
 * A predicate over the rental board, in the terms the board itself uses.
 *
 * Deliberately not the toolbar's filter shape. The toolbar asks "which status,
 * paid or not"; the desk asks "which contracts start today", which is a bound on
 * an event, not an overlap with a window.
 */
export interface RentalDeskFilter {
  readonly statuses?: readonly RentalStatus[]
  /** Inclusive lower bound on `starts_at`. */
  readonly startsFrom?: string
  /** Exclusive upper bound on `starts_at`. */
  readonly startsBefore?: string
  /** Inclusive lower bound on `ends_at`. */
  readonly endsFrom?: string
  /** Exclusive upper bound on `ends_at`. */
  readonly endsBefore?: string
  readonly overdueOnly?: boolean
  /** `balance_due_minor > 0`. */
  readonly outstandingOnly?: boolean
}

/**
 * The one definition of each desk view.
 *
 * Read by the counts on the Rentals summary and the Overview's Today card, and
 * by the list those counts link to. They were separate expressions of the same
 * idea and had drifted: the counts bounded the pick-up or return *instant*
 * inside the agency's day, while the list asked for any contract *overlapping*
 * that day — so "Due back today: 1" opened a list of every contract currently
 * out, and "contracts owing money" included drafts and cancellations the count
 * had excluded. A saved query that does not return the rows it counted is a
 * wrong answer, not a loose filter.
 *
 * `day` bounds are half-open [start, end), in the agency's own time zone,
 * resolved by the caller.
 */
export function deskViewFilter(
  view: RentalDeskView,
  day: { readonly start: string; readonly end: string },
): RentalDeskFilter {
  switch (view) {
    case 'collecting':
      return { statuses: ['reserved'], startsFrom: day.start, startsBefore: day.end }
    case 'returning':
      return { statuses: ['active'], endsFrom: day.start, endsBefore: day.end }
    case 'overdue':
      // `is_overdue` is the database's own definition: active, past its return
      // time, not yet returned. No status of our own is added to it.
      return { overdueOnly: true }
    case 'outstanding':
      return { statuses: ['reserved', 'active', 'completed'], outstandingOnly: true }
  }
}

export interface RentalQuery extends RentalDeskFilter {
  readonly organizationId: string
  readonly search?: string
  readonly status?: RentalStatusFilter
  readonly payment?: RentalPaymentFilter
  readonly vehicleId?: string
  readonly customerId?: string
  readonly sort?: RentalSort
  readonly page?: number
  readonly pageSize?: number
}

export interface RentalPage {
  readonly rows: RentalBoardEntry[]
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
 * Applies a desk predicate to a query over `rental_board`.
 *
 * Shared by the counts and the list on purpose: this function is what makes a
 * summary tile and the page it opens the same question asked twice.
 */
function applyDeskFilter<Builder extends DeskFilterable>(
  request: Builder,
  filter: RentalDeskFilter,
): Builder {
  let next = request
  if (filter.statuses) next = next.in('status', [...filter.statuses]) as Builder
  if (filter.startsFrom) next = next.gte('starts_at', filter.startsFrom) as Builder
  if (filter.startsBefore) next = next.lt('starts_at', filter.startsBefore) as Builder
  if (filter.endsFrom) next = next.gte('ends_at', filter.endsFrom) as Builder
  if (filter.endsBefore) next = next.lt('ends_at', filter.endsBefore) as Builder
  if (filter.overdueOnly) next = next.eq('is_overdue', true) as Builder
  if (filter.outstandingOnly) next = next.gt('balance_due_minor', 0) as Builder
  return next
}

/** The slice of the PostgREST builder `applyDeskFilter` needs, in either shape. */
interface DeskFilterable {
  in(column: string, values: unknown[]): unknown
  gte(column: string, value: unknown): unknown
  lt(column: string, value: unknown): unknown
  eq(column: string, value: unknown): unknown
  gt(column: string, value: unknown): unknown
}

export async function fetchRentals(query: RentalQuery): Promise<RentalPage> {
  const supabase = getSupabaseClient()
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE))
  const sort = RENTAL_SORTS[query.sort ?? 'starting']

  let request = supabase
    .from('rental_board')
    .select('*', { count: 'exact' })
    .eq('organization_id', query.organizationId)

  // A desk view states its own statuses; the toolbar's single-status filter
  // applies only when no desk view is in force.
  if (!query.statuses) {
    const status = query.status ?? 'live'
    if (status === 'live') {
      request = request.in('status', ['draft', 'reserved', 'active'])
    } else if (status !== 'all') {
      request = request.eq('status', status)
    }
  }

  request = applyDeskFilter(request, query)

  if (query.payment === 'outstanding') request = request.gt('balance_due_minor', 0)
  if (query.payment === 'settled') request = request.lte('balance_due_minor', 0)
  if (query.vehicleId) request = request.eq('vehicle_id', query.vehicleId)
  if (query.customerId) request = request.eq('customer_id', query.customerId)

  const search = escapeForOrFilter(query.search ?? '')
  if (search.length > 0) {
    const pattern = `%${search}%`
    request = request.or(
      [
        `reference.ilike.${pattern}`,
        `customer_name.ilike.${pattern}`,
        `vehicle_plate.ilike.${pattern}`,
        `vehicle_make.ilike.${pattern}`,
        `vehicle_model.ilike.${pattern}`,
      ].join(','),
    )
  }

  const fromRow = (page - 1) * pageSize
  const { data, error, count } = await request
    .order(sort.column, { ascending: sort.ascending })
    .order('reference', { ascending: false })
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

export interface RentalSummary {
  readonly collectingToday: number
  readonly returningToday: number
  readonly overdue: number
  readonly outstanding: number
}

/**
 * What the desk has to deal with today.
 *
 * Four counts rather than four lists: the strip above the table is a set of
 * filters with numbers on them, and fetching the rows behind each one would
 * mean four page-sized requests to render four integers. The day boundaries are
 * resolved in the agency's own time zone by the caller — "today" is the
 * agency's day, not the browser's.
 */
export async function fetchRentalSummary(
  organizationId: string,
  dayStart: string,
  dayEnd: string,
): Promise<RentalSummary> {
  const supabase = getSupabaseClient()
  const base = () =>
    supabase
      .from('rental_board')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)

  const day = { start: dayStart, end: dayEnd }
  // Built from the same definitions the list uses, so a tile cannot count rows
  // the page it opens would not show.
  const countOf = (view: RentalDeskView) => applyDeskFilter(base(), deskViewFilter(view, day))

  const [collecting, returning, overdue, outstanding] = await Promise.all([
    countOf('collecting'),
    countOf('returning'),
    countOf('overdue'),
    countOf('outstanding'),
  ])

  for (const result of [collecting, returning, overdue, outstanding]) {
    if (result.error) throw toAppError(result.error)
  }

  return {
    collectingToday: collecting.count ?? 0,
    returningToday: returning.count ?? 0,
    overdue: overdue.count ?? 0,
    outstanding: outstanding.count ?? 0,
  }
}

export async function fetchRental(rentalId: string): Promise<Rental> {
  const { data, error } = await getSupabaseClient()
    .from('rentals')
    .select('*')
    .eq('id', rentalId)
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function fetchRentalBoardEntry(rentalId: string): Promise<RentalBoardEntry> {
  const { data, error } = await getSupabaseClient()
    .from('rental_board')
    .select('*')
    .eq('id', rentalId)
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function fetchRentalLineItems(rentalId: string): Promise<RentalLineItem[]> {
  const { data, error } = await getSupabaseClient()
    .from('rental_line_items')
    .select('*')
    .eq('rental_id', rentalId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw toAppError(error)
  return data ?? []
}

export interface RentalDriverWithCustomer extends RentalDriver {
  readonly customer: { id: string; display_name: string } | null
}

export async function fetchRentalDrivers(rentalId: string): Promise<RentalDriverWithCustomer[]> {
  const { data, error } = await getSupabaseClient()
    .from('rental_drivers')
    .select('*, customer:customers(id, display_name)')
    .eq('rental_id', rentalId)
    .order('driver_role', { ascending: true })

  if (error) throw toAppError(error)
  return (data ?? []) as unknown as RentalDriverWithCustomer[]
}

export async function fetchRentalPayments(rentalId: string): Promise<Payment[]> {
  const { data, error } = await getSupabaseClient()
    .from('payments')
    .select('*')
    .eq('rental_id', rentalId)
    .order('paid_at', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchRentalContracts(rentalId: string): Promise<RentalContract[]> {
  const { data, error } = await getSupabaseClient()
    .from('rental_contracts')
    .select('*')
    .eq('rental_id', rentalId)
    .order('version', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchConditionPhotos(rentalId: string): Promise<RentalConditionPhoto[]> {
  const { data, error } = await getSupabaseClient()
    .from('rental_condition_photos')
    .select('*')
    .eq('rental_id', rentalId)
    .order('uploaded_at', { ascending: true })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchRentalUsage(rentalId: string): Promise<RentalUsageRow> {
  const { data, error } = await getSupabaseClient().rpc('rental_usage', { p_rental_id: rentalId })
  if (error) throw toAppError(error)
  return (
    data?.[0] ?? {
      line_item_count: 0,
      payment_count: 0,
      contract_count: 0,
      photo_count: 0,
      driver_count: 0,
      can_delete: false,
    }
  )
}

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

/**
 * The vehicles bookable for a period.
 *
 * The answer comes from the same rows the exclusion constraint protects, so it
 * agrees with what the database will accept. It is still only an answer as of
 * now: between this call and the save, someone else may take the last car. The
 * constraint is what makes that safe, and the save is what settles it.
 */
export async function fetchAvailableVehicleIds(
  organizationId: string,
  from: string,
  to: string,
  excludeRentalId?: string,
): Promise<string[]> {
  const { data, error } = await getSupabaseClient().rpc('vehicles_available_between', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
    p_exclude_rental_id: excludeRentalId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchPeriodConflicts(
  vehicleId: string,
  from: string,
  to: string,
  excludeRentalId?: string,
): Promise<RentalConflict[]> {
  const { data, error } = await getSupabaseClient().rpc('rental_period_conflicts', {
    p_vehicle_id: vehicleId,
    p_starts_at: from,
    p_ends_at: to,
    p_exclude_rental_id: excludeRentalId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Creating a rental
// -----------------------------------------------------------------------------

export interface CreateRentalInput {
  readonly organizationId: string
  readonly vehicleId: string
  readonly customerId: string
  readonly primaryDriverId: string
  readonly additionalDriverIds: readonly string[]
  readonly startsAt: string
  readonly endsAt: string
  readonly pickupLocation: string | null
  readonly returnLocation: string | null
  readonly currency: string
  readonly dailyRateMinor: number
  readonly billableDays: number
  readonly depositMinor: number
  readonly taxRateBps: number
  readonly taxLabel: string | null
  readonly notes: string | null
  readonly lines: readonly QuoteLine[]
  /** Confirm immediately, which is what a booked reservation means. */
  readonly confirm: boolean
}

/**
 * Creates a rental with its drivers and charges.
 *
 * PostgREST has no multi-table transaction, so the parts are written in
 * dependency order and the rental is removed again if a later part fails. That
 * leaves no half-built contract behind — and because a draft holds no vehicle,
 * a failure here never blocks anyone else's booking in the meantime.
 */
export async function createRental(input: CreateRentalInput): Promise<Rental> {
  const supabase = getSupabaseClient()

  const { data: rental, error } = await supabase
    .from('rentals')
    .insert({
      organization_id: input.organizationId,
      vehicle_id: input.vehicleId,
      customer_id: input.customerId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      pickup_location: input.pickupLocation,
      return_location: input.returnLocation,
      currency: input.currency,
      daily_rate_minor: input.dailyRateMinor,
      billable_days: input.billableDays,
      deposit_minor: input.depositMinor,
      tax_rate_bps: input.taxRateBps,
      tax_label: input.taxLabel,
      notes: input.notes,
      status: 'draft',
    })
    .select()
    .single()

  if (error) throw toAppError(error)

  try {
    const drivers = [
      { customer_id: input.primaryDriverId, driver_role: 'primary' as const },
      ...input.additionalDriverIds
        .filter((id) => id !== input.primaryDriverId)
        .map((id) => ({ customer_id: id, driver_role: 'additional' as const })),
    ]

    const { error: driverError } = await supabase.from('rental_drivers').insert(
      drivers.map((driver) => ({
        organization_id: input.organizationId,
        rental_id: rental.id,
        customer_id: driver.customer_id,
        driver_role: driver.driver_role,
      })),
    )
    if (driverError) throw toAppError(driverError)

    if (input.lines.length > 0) {
      const { error: lineError } = await supabase.from('rental_line_items').insert(
        input.lines.map((line, index) => ({
          organization_id: input.organizationId,
          rental_id: rental.id,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unit_amount_minor: line.unitAmountMinor,
          amount_minor: line.amountMinor,
          is_taxable: line.isTaxable,
          sort_order: index,
        })),
      )
      if (lineError) throw toAppError(lineError)
    }

    if (input.confirm) {
      return await confirmRental(rental.id)
    }

    return rental
  } catch (failure) {
    // A draft with nothing attached is noise, not history.
    await supabase.from('rentals').delete().eq('id', rental.id)
    throw toAppError(failure)
  }
}

export interface UpdateRentalInput {
  readonly rentalId: string
  readonly pickupLocation: string | null
  readonly returnLocation: string | null
  readonly notes: string | null
  readonly depositMinor: number
  readonly taxRateBps: number
  readonly taxLabel: string | null
}

export async function updateRental(input: UpdateRentalInput): Promise<Rental> {
  const { data, error } = await getSupabaseClient()
    .from('rentals')
    .update({
      pickup_location: input.pickupLocation,
      return_location: input.returnLocation,
      notes: input.notes,
      deposit_minor: input.depositMinor,
      tax_rate_bps: input.taxRateBps,
      tax_label: input.taxLabel,
    })
    .eq('id', input.rentalId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function deleteRental(rentalId: string): Promise<void> {
  const { error } = await getSupabaseClient().from('rentals').delete().eq('id', rentalId)
  if (error) throw toAppError(error)
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

function firstRow<T>(data: T | T[] | null): T {
  if (Array.isArray(data)) {
    const row = data[0]
    if (!row) throw toAppError(new Error('The database returned nothing for that operation.'))
    return row
  }
  if (data === null)
    throw toAppError(new Error('The database returned nothing for that operation.'))
  return data
}

export async function confirmRental(rentalId: string): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_confirm', { p_rental_id: rentalId })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export interface HandoverInput {
  readonly rentalId: string
  readonly odometer: number
  readonly fuelPercent: number | null
  readonly notes: string | null
  readonly at: string
}

export async function checkOutRental(input: HandoverInput): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_check_out', {
    p_rental_id: input.rentalId,
    p_odometer: input.odometer,
    p_fuel_percent: input.fuelPercent,
    p_notes: input.notes,
    p_picked_up_at: input.at,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export async function checkInRental(input: HandoverInput): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_check_in', {
    p_rental_id: input.rentalId,
    p_odometer: input.odometer,
    p_fuel_percent: input.fuelPercent,
    p_notes: input.notes,
    p_returned_at: input.at,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export async function completeRental(rentalId: string): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_complete', {
    p_rental_id: rentalId,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export async function cancelRental(rentalId: string, reason: string | null): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_cancel', {
    p_rental_id: rentalId,
    p_reason: reason,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export interface ExtendRentalInput {
  readonly rentalId: string
  readonly newEndsAt: string
  readonly chargeMinor: number
  readonly description: string | null
  readonly additionalDays: number
}

export async function extendRental(input: ExtendRentalInput): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_extend', {
    p_rental_id: input.rentalId,
    p_new_ends_at: input.newEndsAt,
    p_charge_minor: input.chargeMinor,
    p_charge_description: input.description,
    p_additional_days: input.additionalDays,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export async function substituteVehicle(rentalId: string, vehicleId: string): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_substitute_vehicle', {
    p_rental_id: rentalId,
    p_vehicle_id: vehicleId,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

// -----------------------------------------------------------------------------
// Charges
// -----------------------------------------------------------------------------

export interface AddChargeInput {
  readonly organizationId: string
  readonly rentalId: string
  readonly kind: QuoteLine['kind']
  readonly description: string
  readonly quantity: number
  readonly unitAmountMinor: number
  readonly amountMinor: number
  readonly isTaxable: boolean
  readonly sortOrder: number
}

export async function addCharge(input: AddChargeInput): Promise<RentalLineItem> {
  const { data, error } = await getSupabaseClient()
    .from('rental_line_items')
    .insert({
      organization_id: input.organizationId,
      rental_id: input.rentalId,
      kind: input.kind,
      description: input.description,
      quantity: input.quantity,
      unit_amount_minor: input.unitAmountMinor,
      amount_minor: input.amountMinor,
      is_taxable: input.isTaxable,
      sort_order: input.sortOrder,
    })
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function removeCharge(lineItemId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('rental_line_items')
    .delete()
    .eq('id', lineItemId)
  if (error) throw toAppError(error)
}

// -----------------------------------------------------------------------------
// Money
// -----------------------------------------------------------------------------

export interface RecordPaymentInput {
  readonly rentalId: string
  readonly amountMinor: number
  readonly direction: PaymentDirection
  readonly purpose: PaymentPurpose
  readonly method: PaymentMethod
  readonly paidAt: string
  readonly reference: string | null
  readonly notes: string | null
}

export async function recordPayment(input: RecordPaymentInput): Promise<Payment> {
  const { data, error } = await getSupabaseClient().rpc('rental_record_payment', {
    p_rental_id: input.rentalId,
    p_amount_minor: input.amountMinor,
    p_direction: input.direction,
    p_purpose: input.purpose,
    p_method: input.method,
    p_paid_at: input.paidAt,
    p_reference: input.reference,
    p_notes: input.notes,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export async function voidPayment(paymentId: string, reason: string | null): Promise<Payment> {
  const { data, error } = await getSupabaseClient().rpc('rental_void_payment', {
    p_payment_id: paymentId,
    p_reason: reason,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

// -----------------------------------------------------------------------------
// Contracts
// -----------------------------------------------------------------------------

export async function issueContract(
  rentalId: string,
  reason: string | null,
): Promise<RentalContract> {
  const { data, error } = await getSupabaseClient().rpc('rental_issue_contract', {
    p_rental_id: rentalId,
    p_reason: reason,
  })
  if (error) throw toAppError(error)
  return firstRow(data)
}

export interface SignContractInput {
  readonly contractId: string
  readonly renterSignatureName: string
  readonly renterSignaturePath: string | null
  readonly agencySignatureName: string | null
}

export async function signContract(input: SignContractInput): Promise<RentalContract> {
  const { data, error } = await getSupabaseClient()
    .from('rental_contracts')
    .update({
      status: 'signed',
      signed_at: new Date().toISOString(),
      renter_signature_name: input.renterSignatureName,
      renter_signature_path: input.renterSignaturePath,
      agency_signature_name: input.agencySignatureName,
    })
    .eq('id', input.contractId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}
