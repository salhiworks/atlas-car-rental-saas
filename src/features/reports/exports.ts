import type {
  ReportBusinessSummaryRow,
  ReportCustomerBalanceRow,
  ReportExpenseRow,
  ReportFinancingRow,
  ReportFleetRow,
  ReportPositionSummaryRow,
} from '@/types/database'

import { toIsoDateInTimeZone } from '@/lib/datetime/timezone'

import {
  type ReportCsvContext,
  buildReportCsv,
  csvDate,
  csvMoney,
  csvNumber,
  csvPercent,
  csvText,
} from './csv'

/**
 * The exportable tables, one builder each.
 *
 * Every builder takes the SAME rows the screen is showing. An export that
 * re-queries or re-filters is an export that can disagree with what the person
 * was looking at when they pressed the button, and the disagreement is only
 * discovered in a meeting.
 *
 * Money is written as a plain decimal with the currency in its own column. No
 * builder ever adds two currencies, and none emits a customer's contact details,
 * an identity document, a device identifier or a coordinate.
 */

export interface ReportExport {
  readonly filename: string
  readonly contents: string
}

function fileFor(context: ReportCsvContext, key: string): string {
  const safe = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `atlas-${safe}-${csvDate(context.from)}-to-${csvDate(context.to)}.csv`
}

export function exportBusinessSummary(
  context: ReportCsvContext,
  rows: readonly ReportBusinessSummaryRow[],
  positions: readonly ReportPositionSummaryRow[],
): ReportExport {
  const headers = [
    'Currency',
    'Rental revenue',
    'Charges received',
    'Refunds paid',
    'Deposits taken',
    'Deposits returned',
    'Operating cost',
    'Tax within cost',
    'Operating result',
    'Financing cash paid',
    'Financing principal repaid',
    'Financing interest and fees',
    'Financing cost complete',
    'Unallocated financing',
    'Owed by customers (now)',
    'Deposits held (now)',
    'Remaining principal (now)',
  ]

  const positionsByCurrency = new Map(positions.map((row) => [row.currency, row]))

  const body = rows.map((row) => {
    const position = positionsByCurrency.get(row.currency)
    return [
      csvText(row.currency),
      csvMoney(row.rental_revenue_minor, row.currency),
      csvMoney(row.rental_charges_in_minor, row.currency),
      csvMoney(row.rental_refunds_out_minor, row.currency),
      csvMoney(row.deposit_in_minor, row.currency),
      csvMoney(row.deposit_out_minor, row.currency),
      csvMoney(row.operating_expense_minor, row.currency),
      csvMoney(row.operating_expense_tax_minor, row.currency),
      csvMoney(row.operating_result_minor, row.currency),
      csvMoney(row.financing_cash_paid_minor, row.currency),
      csvMoney(row.financing_principal_minor, row.currency),
      csvMoney(row.financing_cost_minor, row.currency),
      row.financing_cost_complete ? 'yes' : 'no',
      csvMoney(row.financing_unallocated_minor, row.currency),
      position ? csvMoney(position.outstanding_minor, row.currency) : '',
      position ? csvMoney(position.deposits_held_minor, row.currency) : '',
      // Not derivable is written as text, never as an empty cell that a
      // spreadsheet would sum as zero.
      position
        ? position.remaining_principal_minor === null
          ? 'not derivable'
          : csvMoney(position.remaining_principal_minor, row.currency)
        : '',
    ]
  })

  return {
    filename: fileFor(context, 'business-summary'),
    contents: buildReportCsv(
      {
        ...context,
        /*
         * This is the one export that deliberately writes every currency, so
         * stamping it with the selected one would invite a reader to total the
         * revenue column across rows — the exact cross-currency sum the whole
         * module refuses to compute.
         */
        currency: null,
        filters: [
          ...(context.filters ?? []).filter((line) => !line.startsWith('Currency filter')),
          'One row per currency — these rows are never added together',
        ],
      },
      headers,
      body,
    ),
  }
}

export function exportFleetPerformance(
  context: ReportCsvContext,
  rows: readonly ReportFleetRow[],
): ReportExport {
  const headers = [
    'Registration',
    'Make',
    'Model',
    'Archived',
    'Currency',
    'Hires started',
    'Hires completed',
    'Days on hire',
    'Days in service',
    'Utilisation %',
    'Rental revenue',
    'Vehicle-direct cost',
    'Rental-direct cost',
    'Direct cost total',
    'Operating contribution',
    'Financing cash paid',
    'Financing cost',
    'Financing cost complete',
    'After financing (cash)',
    'Distance',
  ]

  const body = rows.map((row) => [
    csvText(row.registration_plate),
    csvText(row.make),
    csvText(row.model),
    row.archived_at ? 'yes' : 'no',
    csvText(row.currency),
    csvNumber(row.hires_started),
    csvNumber(row.hires_completed),
    csvNumber(Number(row.rented_days), 2),
    csvNumber(Number(row.in_service_days), 2),
    csvPercent(row.utilisation_bps),
    csvMoney(row.rental_revenue_minor, row.currency),
    csvMoney(row.vehicle_expense_minor, row.currency),
    csvMoney(row.rental_expense_minor, row.currency),
    csvMoney(row.direct_expense_minor, row.currency),
    csvMoney(row.operating_contribution_minor, row.currency),
    csvMoney(row.financing_cash_minor, row.currency),
    csvMoney(row.financing_cost_minor, row.currency),
    row.financing_cost_complete ? 'yes' : 'no',
    csvMoney(row.after_financing_minor, row.currency),
    csvNumber(row.distance_units),
  ])

  return {
    filename: fileFor(context, 'fleet-performance'),
    contents: buildReportCsv(
      {
        ...context,
        filters: [
          ...(context.filters ?? []),
          'Contribution excludes agency overhead, financing and depreciation',
          'Utilisation is calendar availability; maintenance downtime is not recorded historically',
        ],
      },
      headers,
      body,
    ),
  }
}

export function exportExpenseBreakdown(
  context: ReportCsvContext,
  rows: readonly ReportExpenseRow[],
  dimensionLabel: string,
): ReportExport {
  const headers = [
    dimensionLabel,
    'Archived',
    'Currency',
    'Gross',
    'Tax within gross',
    'Net',
    'Entries',
    'Last incurred on',
  ]

  const body = rows.map((row) => [
    csvText(row.dimension_label),
    row.dimension_archived ? 'yes' : 'no',
    csvText(row.currency),
    csvMoney(row.gross_minor, row.currency),
    csvMoney(row.tax_minor, row.currency),
    csvMoney(row.net_minor, row.currency),
    csvNumber(row.expense_count),
    csvDate(row.last_incurred_on),
  ])

  return {
    filename: fileFor(context, `costs-by-${dimensionLabel}`),
    contents: buildReportCsv(
      {
        ...context,
        filters: [
          ...(context.filters ?? []),
          'Voided costs excluded',
          'Financing instalments excluded — they are not operating cost',
        ],
      },
      headers,
      body,
    ),
  }
}

export function exportCustomerBalances(
  context: ReportCsvContext,
  rows: readonly ReportCustomerBalanceRow[],
  options: { timeZone: string; page?: number; pageCount?: number } = { timeZone: 'UTC' },
): ReportExport {
  /*
   * A name, a count and money. No email, no telephone, no address, no date of
   * birth and no identity document — a spreadsheet leaves the product and lands
   * in a folder that is shared, indexed and backed up, and a balances report
   * does not need to carry a person's papers to be useful.
   */
  const headers = [
    'Customer',
    'Type',
    'Archived',
    'Currency',
    'Contracts',
    'Charged',
    'Paid',
    'Outstanding',
    'Deposit held',
    'Last hire started',
  ]

  const body = rows.map((row) => [
    csvText(row.display_name),
    csvText(row.customer_type),
    row.archived_at ? 'yes' : 'no',
    csvText(row.currency),
    csvNumber(row.rental_count),
    csvMoney(row.charged_minor, row.currency),
    csvMoney(row.paid_minor, row.currency),
    csvMoney(row.outstanding_minor, row.currency),
    csvMoney(row.deposits_held_minor, row.currency),
    // A timestamp, not a date column: sliced in UTC it would report a hire that
    // began at 00:30 local as the previous day.
    row.last_rental_starts_at
      ? toIsoDateInTimeZone(new Date(row.last_rental_starts_at), options.timeZone)
      : '',
  ])

  return {
    filename: fileFor(context, 'outstanding-balances'),
    contents: buildReportCsv(
      {
        ...context,
        filters: [
          ...(context.filters ?? []),
          'Balances are as at generation time, not filtered by the period',
          ...(options.pageCount && options.pageCount > 1
            ? [`Page ${options.page ?? 1} of ${options.pageCount} — this file is one page`]
            : []),
        ],
      },
      headers,
      body,
    ),
  }
}

export function exportFinancingPosition(
  context: ReportCsvContext,
  rows: readonly ReportFinancingRow[],
): ReportExport {
  const headers = [
    'Registration',
    'Vehicle archived',
    'Lender',
    'Agreement',
    'Reference',
    'Currency',
    'Cash paid',
    'Principal repaid',
    'Interest and fees',
    'Cost complete',
    'Unallocated',
    'Remaining principal',
    'Overdue',
    'Overdue instalments',
    'Next due on',
    'Next due amount',
  ]

  const body = rows.map((row) => [
    csvText(row.registration_plate),
    row.vehicle_archived ? 'yes' : 'no',
    csvText(row.lender_name),
    csvText(row.agreement_type),
    csvText(row.reference),
    csvText(row.currency),
    csvMoney(row.cash_paid_minor, row.currency),
    csvMoney(row.principal_paid_minor, row.currency),
    csvMoney(row.financing_cost_minor, row.currency),
    row.cost_complete ? 'yes' : 'no',
    csvMoney(row.unallocated_minor, row.currency),
    row.principal_known && row.remaining_principal_minor !== null
      ? csvMoney(row.remaining_principal_minor, row.currency)
      : 'not derivable',
    csvMoney(row.overdue_minor, row.currency),
    csvNumber(row.overdue_count),
    csvDate(row.next_due_on),
    row.next_due_minor === null ? '' : csvMoney(row.next_due_minor, row.currency),
  ])

  return {
    filename: fileFor(context, 'financing-position'),
    contents: buildReportCsv(
      {
        ...context,
        filters: [
          ...(context.filters ?? []),
          'Active agreements only, one row per agreement',
          'Money columns are lifetime, not period-scoped',
        ],
      },
      headers,
      body,
    ),
  }
}
