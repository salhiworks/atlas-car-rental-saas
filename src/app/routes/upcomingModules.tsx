import type { ModulePageProps } from '@/pages/ModulePage'

/**
 * Copy for sections whose modules are still being built.
 *
 * Empty: every section of the product now has a real page behind it. The type and
 * the export stay because AppRouter maps over this list, and an empty list is a
 * truthful statement about the product rather than a file to delete and re-add.
 */
export const upcomingModules: ReadonlyArray<ModulePageProps & { path: string }> = []
