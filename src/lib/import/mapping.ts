/**
 * Matching a spreadsheet's columns to the fields an import understands.
 *
 * Shared across entities: the guessing is the same problem whether the file
 * describes vehicles or customers, and only the field list differs.
 */

export interface ImportField<K extends string = string> {
  readonly key: K
  readonly label: string
  readonly required: boolean
  /** Header names other systems use, already lowercased and space-separated. */
  readonly aliases: readonly string[]
}

/** Column index in the file for each field, or null when unmapped. */
export type ColumnMapping<K extends string = string> = Partial<Record<K, number | null>>

export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Best-effort match of the file's headers to a field list.
 *
 * Only a starting point: the import screen shows the result and lets the person
 * correct it before anything is validated, because a wrong guess that imports
 * silently is far worse than one that is visible.
 */
export function guessColumnMapping<K extends string>(
  fields: readonly ImportField<K>[],
  headers: readonly string[],
): ColumnMapping<K> {
  const normalised = headers.map(normaliseHeader)
  const mapping: ColumnMapping<K> = {}
  const taken = new Set<number>()

  // Exact alias matches first, so a precise header is never stolen by a looser
  // match on an earlier field.
  for (const field of fields) {
    const index = normalised.findIndex(
      (header, position) => !taken.has(position) && field.aliases.includes(header),
    )
    if (index !== -1) {
      mapping[field.key] = index
      taken.add(index)
    } else {
      mapping[field.key] = null
    }
  }

  return mapping
}

/** Reads a cell for a mapped field, trimmed. Unmapped fields read as ''. */
export function cellReader<K extends string>(row: readonly string[], mapping: ColumnMapping<K>) {
  return (key: K): string => {
    const index = mapping[key]
    if (index == null) return ''
    return (row[index] ?? '').trim()
  }
}
