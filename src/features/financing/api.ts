import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type {
  DuplicateFinancingPaymentRow,
  DuplicateLenderRow,
  FinancingAgreement,
  FinancingAgreementOverview,
  FinancingAgreementStatus,
  FinancingAgreementType,
  FinancingChangeEvent,
  FinancingDueObligationRow,
  FinancingInstallmentStatus,
  FinancingPayment,
  FinancingProjectedInstallment,
  FinancingUsageRow,
  Lender,
  OrganizationFinancingSummaryRow,
  VehicleFinancingSummaryRow,
} from '@/types/database'

import type {
  AcquisitionFormValues,
  AgreementFormValues,
  FinancingPaymentFormValues,
  LenderFormValues,
} from './schemas'

/**
 * What the Financing module asks of the database.
 *
 * The list reads `financing_agreement_overview`, which has already resolved the
 * vehicle, the lender, the cash position and the derived obligations — so a
 * page of agreements is one request rather than one per agreement plus one per
 * schedule. Schedules and payments are fetched only on the detail page, where
 * somebody is actually looking at them.
 *
 * Anything that has to be atomic — writing a schedule, allocating a payment,
 * ending an agreement — goes through an RPC rather than a sequence of browser
 * writes that can half-succeed.
 */

export const AGREEMENT_SORTS = {
  next_due: { column: 'next_due_on', ascending: true, label: 'Next payment' },
  overdue: { column: 'overdue_minor', ascending: false, label: 'Most overdue' },
  newest: { column: 'starts_on', ascending: false, label: 'Newest' },
  outstanding: { column: 'remaining_scheduled_minor', ascending: false, label: 'Most outstanding' },
} as const

export type AgreementSort = keyof typeof AGREEMENT_SORTS
export type AgreementStatusFilter = FinancingAgreementStatus | 'live' | 'all'

export interface AgreementQuery {
  readonly organizationId: string
  readonly search?: string
  readonly status?: AgreementStatusFilter
  readonly lenderId?: string
  readonly vehicleId?: string
  readonly agreementType?: FinancingAgreementType | 'any'
  readonly currency?: string
  readonly dueState?: 'any' | 'overdue' | 'due_soon'
  readonly sort?: AgreementSort
  readonly page?: number
  readonly pageSize?: number
}

export interface AgreementPage {
  readonly rows: FinancingAgreementOverview[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly pageCount: number
}

export const DEFAULT_PAGE_SIZE = 20

/** PostgREST `or=` values are comma-separated, so a comma would split the term. */
function escapeForOrFilter(term: string): string {
  return term.replace(/[,()]/g, ' ').trim()
}

export async function fetchAgreements(query: AgreementQuery): Promise<AgreementPage> {
  const supabase = getSupabaseClient()
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE))
  const sort = AGREEMENT_SORTS[query.sort ?? 'next_due']

  let request = supabase
    .from('financing_agreement_overview')
    .select('*', { count: 'exact' })
    .eq('organization_id', query.organizationId)

  const status = query.status ?? 'live'
  if (status === 'live') {
    request = request.in('agreement_status', ['draft', 'active'])
  } else if (status !== 'all') {
    request = request.eq('agreement_status', status)
  }

  if (query.lenderId) request = request.eq('lender_id', query.lenderId)
  if (query.vehicleId) request = request.eq('vehicle_id', query.vehicleId)
  if (query.currency) request = request.eq('currency', query.currency)
  if (query.agreementType && query.agreementType !== 'any') {
    request = request.eq('agreement_type', query.agreementType)
  }
  if (query.dueState === 'overdue') request = request.gt('overdue_minor', 0)
  if (query.dueState === 'due_soon') {
    const horizon = new Date()
    horizon.setUTCDate(horizon.getUTCDate() + 30)
    request = request
      .not('next_due_on', 'is', null)
      .lte('next_due_on', horizon.toISOString().slice(0, 10))
  }

  const search = escapeForOrFilter(query.search ?? '')
  if (search.length > 0) {
    const pattern = `%${search}%`
    request = request.or(
      [
        `vehicle_plate.ilike.${pattern}`,
        `vehicle_make.ilike.${pattern}`,
        `vehicle_model.ilike.${pattern}`,
        `lender_name.ilike.${pattern}`,
        `reference.ilike.${pattern}`,
      ].join(','),
    )
  }

  const fromRow = (page - 1) * pageSize
  const { data, error, count } = await request
    // Nulls last on the ascending sort, so an agreement with nothing due does
    // not sit above one that is due tomorrow.
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
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

export async function fetchAgreement(agreementId: string): Promise<FinancingAgreementOverview> {
  const { data, error } = await getSupabaseClient()
    .from('financing_agreement_overview')
    .select('*')
    .eq('id', agreementId)
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function fetchVehicleAgreements(
  vehicleId: string,
): Promise<FinancingAgreementOverview[]> {
  const { data, error } = await getSupabaseClient()
    .from('financing_agreement_overview')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('starts_on', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchSchedule(agreementId: string): Promise<FinancingInstallmentStatus[]> {
  const { data, error } = await getSupabaseClient()
    .from('financing_installment_status')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('sequence', { ascending: true })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchPayments(agreementId: string): Promise<FinancingPayment[]> {
  const { data, error } = await getSupabaseClient()
    .from('financing_payments')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('paid_on', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchChangeEvents(agreementId: string): Promise<FinancingChangeEvent[]> {
  const { data, error } = await getSupabaseClient()
    .from('financing_change_events')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('changed_at', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Summaries
// -----------------------------------------------------------------------------

export async function fetchOrganizationFinancingSummary(
  organizationId: string,
  from: string,
  to: string,
): Promise<OrganizationFinancingSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('organization_financing_summary', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchVehicleFinancingSummary(
  vehicleId: string,
  from: string,
  to: string,
): Promise<VehicleFinancingSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('vehicle_financing_summary', {
    p_vehicle_id: vehicleId,
    p_from: from,
    p_to: to,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchDueObligations(
  organizationId: string,
  withinDays = 30,
): Promise<FinancingDueObligationRow[]> {
  const { data, error } = await getSupabaseClient().rpc('financing_due_obligations', {
    p_organization_id: organizationId,
    p_within_days: withinDays,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

/**
 * The schedule a set of terms would produce, computed by the database.
 *
 * The wizard draws its preview locally so it can keep up with typing; this is
 * the confirmation step's cross-check, and the test suite asserts the two agree
 * row for row.
 */
export async function fetchProjectedSchedule(terms: {
  mode: 'simple' | 'amortizing'
  financedMinor: number | null
  rateBps: number | null
  installments: number | null
  installmentMinor: number | null
  firstPaymentOn: string
  anchorDay: number
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
  balloonMinor: number | null
}): Promise<FinancingProjectedInstallment[]> {
  const { data, error } = await getSupabaseClient().rpc('financing_projected_schedule', {
    p_mode: terms.mode,
    p_financed_minor: terms.financedMinor,
    p_rate_bps: terms.rateBps,
    p_installments: terms.installments,
    p_installment_minor: terms.installmentMinor,
    p_first_payment_on: terms.firstPaymentOn,
    p_anchor_day: terms.anchorDay,
    p_frequency: terms.frequency,
    p_balloon_minor: terms.balloonMinor ?? 0,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Lenders
// -----------------------------------------------------------------------------

export async function fetchLenders(
  organizationId: string,
  { includeArchived = false, search = '' } = {},
): Promise<Lender[]> {
  let request = getSupabaseClient()
    .from('lenders')
    .select('*')
    .eq('organization_id', organizationId)

  if (!includeArchived) request = request.is('archived_at', null)
  if (search.trim() !== '') request = request.ilike('name', `%${escapeForOrFilter(search)}%`)

  const { data, error } = await request.order('name', { ascending: true }).limit(200)

  if (error) throw toAppError(error)
  return data ?? []
}

function lenderColumns(values: LenderFormValues) {
  return {
    name: values.name,
    kind: values.kind,
    email: values.email,
    phone: values.phone,
    tax_identifier: values.taxIdentifier,
    account_reference: values.accountReference,
    address: values.address,
    notes: values.notes,
  }
}

export async function createLender(
  organizationId: string,
  values: LenderFormValues,
): Promise<Lender> {
  const { data, error } = await getSupabaseClient()
    .from('lenders')
    .insert({ organization_id: organizationId, ...lenderColumns(values) })
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateLender(lenderId: string, values: LenderFormValues): Promise<Lender> {
  const { data, error } = await getSupabaseClient()
    .from('lenders')
    .update(lenderColumns(values))
    .eq('id', lenderId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

/**
 * Archiving, not deleting.
 *
 * An agreement keeps its lender relationship after the lender is retired, so
 * the history of who the money went to survives. Archived means "not offered
 * for new agreements", never "gone".
 */
export async function setLenderArchived(lenderId: string, archived: boolean): Promise<Lender> {
  const { data, error } = await getSupabaseClient()
    .from('lenders')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', lenderId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function findDuplicateLenders(
  organizationId: string,
  name: string,
  taxIdentifier: string | null,
  excludeLenderId?: string,
): Promise<DuplicateLenderRow[]> {
  const { data, error } = await getSupabaseClient().rpc('find_duplicate_lenders', {
    p_organization_id: organizationId,
    p_name: name,
    p_tax_identifier: taxIdentifier,
    p_exclude_lender_id: excludeLenderId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchLenderUsage(lenderId: string): Promise<FinancingUsageRow> {
  const { data, error } = await getSupabaseClient().rpc('lender_usage', { p_lender_id: lenderId })

  if (error) throw toAppError(error)
  return data?.[0] ?? { agreement_count: 0, can_delete: false }
}

// -----------------------------------------------------------------------------
// Agreements
// -----------------------------------------------------------------------------

function agreementColumns(values: AgreementFormValues) {
  return {
    vehicle_id: values.vehicleId,
    lender_id: values.lenderId,
    agreement_type: values.agreementType,
    mode: values.mode,
    currency: values.currency,
    reference: values.reference,
    starts_on: values.startsOn,
    first_payment_on: values.firstPaymentOn,
    // The anchor is the day of the month the first payment falls on. Everything
    // downstream clamps it to the length of the month it lands in.
    schedule_anchor_day: Number(values.firstPaymentOn.slice(8, 10)),
    payment_frequency: values.paymentFrequency,
    financed_amount_minor: values.financedAmount,
    down_payment_amount_minor: values.downPayment,
    installment_amount_minor: values.installmentAmount,
    balloon_minor: values.balloon,
    rate_bps: values.rateBps,
    installments_count: values.installmentsCount,
    notes: values.notes,
  }
}

export async function createAgreement(
  organizationId: string,
  values: AgreementFormValues,
): Promise<FinancingAgreement> {
  const { data, error } = await getSupabaseClient()
    .from('financing_agreements')
    .insert({ organization_id: organizationId, ...agreementColumns(values) })
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateAgreement(
  agreementId: string,
  values: AgreementFormValues,
  userId: string | null,
): Promise<FinancingAgreement> {
  const { data, error } = await getSupabaseClient()
    .from('financing_agreements')
    .update({ ...agreementColumns(values), updated_by: userId })
    .eq('id', agreementId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

/** Descriptive changes only — allowed even once the terms have frozen. */
export async function updateAgreementNotes(
  agreementId: string,
  values: { reference: string | null; notes: string | null },
): Promise<FinancingAgreement> {
  const { data, error } = await getSupabaseClient()
    .from('financing_agreements')
    .update({ reference: values.reference, notes: values.notes })
    .eq('id', agreementId)
    .select()
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function activateAgreement(agreementId: string): Promise<FinancingAgreement> {
  const { data, error } = await getSupabaseClient().rpc('financing_activate_agreement', {
    p_agreement_id: agreementId,
  })

  if (error) throw toAppError(error)
  if (data === null)
    throw toAppError(new Error('The database returned nothing for that activation.'))
  return Array.isArray(data) ? (data[0] as FinancingAgreement) : data
}

export async function regenerateSchedule(agreementId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('financing_generate_schedule', {
    p_agreement_id: agreementId,
  })

  if (error) throw toAppError(error)
  return Number(data ?? 0)
}

export async function closeAgreement(
  agreementId: string,
  status: FinancingAgreementStatus,
  reason: string | null,
  payoffOn: string | null,
): Promise<FinancingAgreement> {
  const { data, error } = await getSupabaseClient().rpc('financing_close_agreement', {
    p_agreement_id: agreementId,
    p_status: status,
    p_reason: reason,
    p_payoff_on: payoffOn,
  })

  if (error) throw toAppError(error)
  if (data === null) throw toAppError(new Error('The database returned nothing for that change.'))
  return Array.isArray(data) ? (data[0] as FinancingAgreement) : data
}

export async function deleteAgreement(agreementId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('financing_agreements')
    .delete()
    .eq('id', agreementId)

  if (error) throw toAppError(error)
}

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------

export async function recordPayment(
  agreementId: string,
  values: FinancingPaymentFormValues,
): Promise<FinancingPayment> {
  const { data, error } = await getSupabaseClient().rpc('financing_record_payment', {
    p_agreement_id: agreementId,
    p_paid_on: values.paidOn,
    p_amount_minor: values.amount,
    p_installment_id: values.installmentId,
    p_principal_minor: values.principal,
    p_interest_minor: values.interest,
    p_fees_minor: values.fees,
    p_purpose: values.purpose,
    p_method: values.method as never,
    p_reference: values.reference,
    p_notes: values.notes,
  })

  if (error) throw toAppError(error)
  if (data === null) throw toAppError(new Error('The database returned nothing for that payment.'))
  return Array.isArray(data) ? (data[0] as FinancingPayment) : data
}

export async function voidPayment(
  paymentId: string,
  reason: string | null,
): Promise<FinancingPayment> {
  const { data, error } = await getSupabaseClient().rpc('financing_void_payment', {
    p_payment_id: paymentId,
    p_reason: reason,
  })

  if (error) throw toAppError(error)
  if (data === null) throw toAppError(new Error('The database returned nothing for that void.'))
  return Array.isArray(data) ? (data[0] as FinancingPayment) : data
}

export async function findDuplicatePayments(probe: {
  agreementId: string
  paidOn: string
  amountMinor: number
  reference: string | null
  excludePaymentId?: string
}): Promise<DuplicateFinancingPaymentRow[]> {
  const { data, error } = await getSupabaseClient().rpc('find_duplicate_financing_payments', {
    p_agreement_id: probe.agreementId,
    p_paid_on: probe.paidOn,
    p_amount_minor: probe.amountMinor,
    p_reference: probe.reference,
    p_exclude_payment_id: probe.excludePaymentId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Acquisition, which belongs to the vehicle
// -----------------------------------------------------------------------------

export async function updateAcquisition(
  vehicleId: string,
  values: AcquisitionFormValues,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('vehicles')
    .update({
      acquisition_method: values.acquisitionMethod as never,
      acquired_on: values.acquiredOn,
      acquisition_price_minor: values.acquisitionPrice,
      acquisition_currency: values.acquisitionCurrency,
      acquisition_supplier: values.acquisitionSupplier,
      acquisition_notes: values.acquisitionNotes,
    })
    .eq('id', vehicleId)

  if (error) throw toAppError(error)
}
