/**
 * CSV parsing and template generation, shared by every import in the product.
 *
 * Written here rather than pulled in: the requirement is one well-understood
 * format — RFC 4180 plus the tolerances real spreadsheets need — and a
 * dependency would be a larger surface than the code it replaces.
 */

export interface ParsedCsv {
  readonly headers: string[]
  readonly rows: string[][]
}

/**
 * RFC 4180, plus what spreadsheets actually emit: CRLF or LF, a UTF-8
 * byte-order mark, and quoted fields containing commas, newlines and doubled
 * quotes.
 */
export function parseCsv(text: string): ParsedCsv {
  const input = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []

  let field = ''
  let row: string[] = []
  let inQuotes = false
  let index = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // Ignore the trailing blank line almost every file ends with.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (index < input.length) {
    const char = input[index]!

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      index += 1
      continue
    }
    if (char === ',') {
      endField()
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      endRow()
      index += 1
      continue
    }

    field += char
    index += 1
  }

  if (field !== '' || row.length > 0) endRow()

  const headers = (rows.shift() ?? []).map((header) => header.trim())
  return { headers, rows }
}

export function escapeCsvValue(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function buildCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers.map(escapeCsvValue).join(',')]
  for (const row of rows) lines.push(row.map(escapeCsvValue).join(','))
  return `${lines.join('\n')}\n`
}

/**
 * Accepts the date shapes spreadsheets export; returns ISO or null.
 *
 * Day-first is preferred when both readings are possible, because that is what
 * the majority of the world's spreadsheets produce.
 */
export function normaliseImportedDate(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (iso) {
    return `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}`
  }

  const slashed = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(trimmed)
  if (slashed) {
    const first = Number(slashed[1])
    const second = Number(slashed[2])
    const year = slashed[3]!

    const day = first > 12 ? first : second > 12 ? second : first
    const month = first > 12 ? second : second > 12 ? first : second
    if (month < 1 || month > 12 || day < 1 || day > 31) return null

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}
