import { buildCsv } from '@/lib/import/csv'
import { minorToDecimalString } from '@/lib/money/money'

/**
 * Exporting a report.
 *
 * A CSV is not "just text". It is a program that a spreadsheet will run, and
 * three things have to be right or the file is either dangerous or wrong.
 *
 * 1. FORMULA INJECTION. A cell whose first character is `=`, `+`, `-`, `@`, or
 *    one of the two control characters Excel also honours, is evaluated when
 *    the file is opened. Every free-text field in this product reaches a report:
 *    customer names, supplier names, vehicle plates, category names, notes. A
 *    supplier recorded as `=HYPERLINK("http://…","Click")` becomes a live link
 *    in the accountant's spreadsheet; `=cmd|'/c calc'!A0` is worse. The value is
 *    preserved exactly and neutralised with a leading apostrophe, which every
 *    spreadsheet reads as "this is text".
 *
 * 2. ENCODING. Excel on Windows assumes the system code page unless the file
 *    opens with a byte order mark, and an agency in Casablanca exporting
 *    `Peugeot Citroën` gets mojibake without one.
 *
 * 3. NUMBERS AND DATES. Money is written as a plain decimal with the currency in
 *    its own column, never through a locale formatter — `1.234,56` and
 *    `1,234.56` are the same amount and different files. Dates are ISO.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Tab and carriage return are in the list because Excel strips leading
 * whitespace before deciding, so `\t=1+1` is a formula too.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * Neutralises a cell without changing what it says.
 *
 * A leading apostrophe is the documented way to force text in Excel, LibreOffice
 * and Google Sheets, and it is not displayed. The original characters survive —
 * a supplier really called `-Bureau` still reads `-Bureau` in the cell.
 */
export function guardCsvCell(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value
}

/** Anything that reaches a text cell goes through here. */
export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return guardCsvCell(String(value))
}

/** Money as a plain decimal. The currency travels in its own column. */
export function csvMoney(amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor === null || amountMinor === undefined) return ''
  return minorToDecimalString(amountMinor, currency)
}

/** A ratio in basis points as a plain decimal percentage. */
export function csvPercent(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return ''
  return (bps / 100).toFixed(2)
}

export function csvNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return ''
  return Number(value).toFixed(digits)
}

/** A `date` column, already ISO from Postgres. Never re-formatted for a locale. */
export function csvDate(value: string | null | undefined): string {
  if (!value) return ''
  return value.slice(0, 10)
}

export interface ReportCsvContext {
  readonly agencyName: string
  readonly reportName: string
  readonly periodLabel: string
  readonly from: string
  readonly to: string
  readonly currency: string | null
  readonly generatedAt: string
  readonly filters?: readonly string[]
}

/**
 * The provenance block every export carries.
 *
 * A spreadsheet that outlives the screen it came from has to say what it is: a
 * figure with no period and no currency beside it is a number somebody will
 * later misremember. These lines sit above the table so the first thing read is
 * what was asked for.
 */
function provenance(context: ReportCsvContext): string[][] {
  const lines: string[][] = [
    ['Agency', csvText(context.agencyName)],
    ['Report', csvText(context.reportName)],
    ['Period', csvText(context.periodLabel)],
    ['From (inclusive)', csvDate(context.from)],
    ['To (exclusive)', csvDate(context.to)],
    ['Currency', context.currency ? csvText(context.currency) : 'Not applicable'],
    ['Generated', csvText(context.generatedAt)],
  ]
  for (const filter of context.filters ?? []) lines.push(['Filter', csvText(filter)])
  lines.push([])
  return lines
}

/**
 * A complete report file: provenance, then a blank line, then the table.
 *
 * `buildCsv` handles quoting; this adds the byte order mark and the header
 * block. The rows arriving here must already have been through the cell helpers
 * above — the escaper quotes a comma, it does not defuse a formula.
 */
export function buildReportCsv(
  context: ReportCsvContext,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const width = Math.max(headers.length, 2)
  const padded = provenance(context).map((line) => {
    const row = [...line]
    while (row.length < width) row.push('')
    return row
  })

  // The header row goes through the same guard as every other cell. One header
  // is not a constant — the cost breakdown names its first column after the
  // dimension the user chose, which arrives from the URL.
  const body = buildCsv(headers.map(guardCsvCell), rows)
  const head = padded.map((line) => line.map(escapeForCsv).join(',')).join('\n')

  // The byte order mark is what stops Excel guessing the code page.
  return `${BOM}${head}\n${body}`
}

/**
 * The UTF-8 byte order mark, written as an escape rather than as a literal.
 *
 * A bare U+FEFF in source is invisible, survives copy-paste into the wrong
 * place, and is exactly the kind of character a linter refuses for good reason.
 */
const BOM = '\uFEFF'

/** Mirrors the escaping `buildCsv` applies, for the provenance block. */
function escapeForCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * A filename somebody can find again.
 *
 * Report, agency-free, and the period — never a customer name, and never a
 * vehicle plate. A download folder is shared, indexed and backed up, and a file
 * called `outstanding-balances-cherkaoui.csv` says something about a person to
 * everyone who can see the folder.
 */
export function reportFilename(reportKey: string, from: string, to: string): string {
  const safe = reportKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `atlas-${safe || 'report'}-${csvDate(from)}-to-${csvDate(to)}.csv`
}

/** Hands the file to the browser and releases the object URL immediately after. */
export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
