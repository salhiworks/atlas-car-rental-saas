/**
 * Up to two initials for an agency or person, skipping words that carry no
 * identity ("The", "and", "de"). Used as the fallback mark when no logo has
 * been uploaded.
 */
export function getMonogram(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0 && !/^(the|and|of|de|la|le|el)$/i.test(word))

  if (words.length === 0) return name.slice(0, 2).toUpperCase() || '—'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase()
}
