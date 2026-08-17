import type { ParsedCsv } from './csv'
import { type ColumnMapping, type ImportField, cellReader } from './mapping'

/**
 * Row validation shared by every CSV import.
 *
 * The rule this enforces, generically, is the one that matters: an imported row
 * goes through the *same* validation as one typed into the form. A spreadsheet
 * must never be a way around a schema, a uniqueness rule or a permission.
 *
 * Everything entity-specific is supplied by an adapter, so adding an import for
 * a new entity is a field list and three small functions rather than a copy of
 * this file.
 */

export interface ImportRowIssue {
  readonly field: string
  readonly message: string
}

export interface ImportRow<TValues> {
  /** 1-based line number in the file, counting the header — what the user sees. */
  readonly line: number
  readonly raw: string[]
  readonly values: TValues | null
  readonly issues: ImportRowIssue[]
  /** Human-readable identity for the preview table. */
  readonly identifier: string
  /** Normalised key used for duplicate detection; null when the row has none. */
  readonly dedupeKey: string | null
  /** Set when an earlier row in the same file claims this key. */
  readonly duplicateOfLine: number | null
  /** Set when a record already in the agency claims this key. */
  readonly conflictsWithExisting: boolean
}

export interface ImportAdapter<K extends string, TValues> {
  readonly fields: readonly ImportField<K>[]
  /**
   * Turns raw cells into a candidate for the schema, reporting anything the
   * schema itself cannot express (an unrecognised status word, an unreadable
   * date) as an issue.
   */
  buildCandidate(read: (key: K) => string): { candidate: unknown; issues: ImportRowIssue[] }
  /** The entity's real validation schema — the same one the form uses. */
  parse(candidate: unknown): { ok: true; values: TValues } | { ok: false; issues: ImportRowIssue[] }
  /** Normalised duplicate key, or null when this row cannot collide. */
  dedupeKey(values: TValues | null, read: (key: K) => string): string | null
  /** Label shown in the preview. */
  identifier(values: TValues | null, read: (key: K) => string): string
}

export interface ImportValidation<TValues> {
  readonly rows: ImportRow<TValues>[]
  readonly validCount: number
  readonly errorCount: number
  readonly duplicateCount: number
}

export interface ValidateOptions {
  /** Normalised keys already present in the agency. */
  readonly existingKeys: ReadonlySet<string>
}

export function validateImportRows<K extends string, TValues>(
  parsed: ParsedCsv,
  mapping: ColumnMapping<K>,
  adapter: ImportAdapter<K, TValues>,
  options: ValidateOptions,
): ImportValidation<TValues> {
  const seen = new Map<string, number>()
  const rows: ImportRow<TValues>[] = []

  parsed.rows.forEach((raw, index) => {
    const line = index + 2 // +1 for the header, +1 for 1-based counting
    const read = cellReader(raw, mapping)

    const { candidate, issues } = adapter.buildCandidate(read)
    const parsedRow = adapter.parse(candidate)
    const values = parsedRow.ok ? parsedRow.values : null
    if (!parsedRow.ok) issues.push(...parsedRow.issues)

    const dedupeKey = adapter.dedupeKey(values, read)

    let duplicateOfLine: number | null = null
    if (dedupeKey) {
      const firstSeen = seen.get(dedupeKey)
      if (firstSeen !== undefined) duplicateOfLine = firstSeen
      else seen.set(dedupeKey, line)
    }

    rows.push({
      line,
      raw,
      values,
      issues,
      identifier: adapter.identifier(values, read),
      dedupeKey,
      duplicateOfLine,
      conflictsWithExisting: dedupeKey !== null && options.existingKeys.has(dedupeKey),
    })
  })

  return {
    rows,
    validCount: rows.filter(isImportable).length,
    errorCount: rows.filter((row) => row.issues.length > 0).length,
    duplicateCount: rows.filter((row) => row.duplicateOfLine !== null || row.conflictsWithExisting)
      .length,
  }
}

/** A row imports only if it validated and claims a key nothing else claims. */
export function isImportable<TValues>(row: ImportRow<TValues>): boolean {
  return row.issues.length === 0 && row.duplicateOfLine === null && !row.conflictsWithExisting
}

/** Collects Zod-shaped issues into the generic form. */
export function issuesFromZod(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): ImportRowIssue[] {
  return error.issues.map((issue) => ({
    field: String(issue.path[0] ?? 'row'),
    message: issue.message,
  }))
}
