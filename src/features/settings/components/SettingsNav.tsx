import { cn } from '@/lib/utils/cn'

export interface SettingsSection {
  readonly id: string
  readonly label: string
  /** Marks the section as holding edits that have not been saved. */
  readonly isDirty?: boolean
}

export interface SettingsNavProps {
  sections: readonly SettingsSection[]
  activeId: string
  onSelect: (id: string) => void
}

/**
 * Section navigation for Settings.
 *
 * Settings is not one form, it is six unrelated ones, and stacking them made a
 * page nobody could scan: the currency selector and the logo uploader were
 * eleven hundred pixels apart with no relationship between them. Showing one
 * section at a time is the honest structure — each section is a thing you came
 * here to change, not a step on the way to somewhere else.
 *
 * A section holding unsaved edits says so, because the section you are looking
 * at is no longer the only one that can be dirty.
 */
export function SettingsNav({ sections, activeId, onSelect }: SettingsNavProps) {
  return (
    <nav aria-label="Settings sections" className="min-w-0">
      {/* Phone and tablet: one scrollable row, bled to the page edges so the
          first and last chips are not visually trapped. */}
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:hidden [&::-webkit-scrollbar]:hidden">
        <ul className="flex w-max gap-1.5 pb-1">
          {sections.map((section) => (
            <li key={section.id}>
              <NavButton section={section} isActive={section.id === activeId} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      </div>

      {/* Desktop: a rail that stays with the reader down a long section. */}
      <ul className="sticky top-6 hidden space-y-0.5 lg:block">
        {sections.map((section) => (
          <li key={section.id}>
            <NavButton section={section} isActive={section.id === activeId} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function NavButton({
  section,
  isActive,
  onSelect,
}: {
  section: SettingsSection
  isActive: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      aria-current={isActive ? 'true' : undefined}
      onClick={() => onSelect(section.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-start text-[0.8125rem] whitespace-nowrap',
        'transition-colors',
        isActive
          ? 'bg-surface border-line text-ink font-medium shadow-raised'
          : 'text-ink-muted hover:bg-surface-inset hover:text-ink border-transparent',
      )}
    >
      <span className="flex-1">{section.label}</span>
      {section.isDirty ? (
        <>
          <span className="bg-brand-500 size-1.5 shrink-0 rounded-full" aria-hidden="true" />
          <span className="sr-only">has unsaved changes</span>
        </>
      ) : null}
    </button>
  )
}
