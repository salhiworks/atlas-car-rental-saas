import { ArrowLeft, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Card, PageHeader } from '@/components/ui'

export interface ModulePageProps {
  eyebrow: string
  title: string
  /** One sentence, in the product's voice, on the state of this section. */
  summary: string
  /** What this section will do — described, never simulated. */
  capabilities: readonly string[]
  icon: LucideIcon
}

/**
 * Placeholder for a section whose module is still being built.
 *
 * It shows nothing that looks like data. A screen of greyed-out sample vehicles
 * or an empty table with working-looking filters would suggest the feature is
 * present and broken; this says plainly that it is not open yet and describes
 * what will be here, so nobody wastes time hunting for a button.
 */
export function ModulePage({ eyebrow, title, summary, capabilities, icon: Icon }: ModulePageProps) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} eyebrow={eyebrow} />

      <Card className="mx-auto max-w-2xl">
        <div className="p-8">
          <div className="border-line bg-surface-inset text-ink-muted flex size-11 items-center justify-center rounded-lg border">
            <Icon className="size-5" aria-hidden="true" />
          </div>

          <h2 className="mt-5 text-[0.9375rem] font-semibold">Not open yet</h2>
          <p className="text-ink-muted mt-1.5 text-[0.8125rem] leading-6">{summary}</p>

          <p className="eyebrow mt-6">What you'll be able to do here</p>
          <ul className="mt-2.5 space-y-2">
            {capabilities.map((capability) => (
              <li
                key={capability}
                className="text-ink-muted flex gap-2.5 text-[0.8125rem] leading-5"
              >
                <span
                  aria-hidden="true"
                  className="bg-brand-300 mt-[7px] size-1 shrink-0 rounded-full"
                />
                {capability}
              </li>
            ))}
          </ul>

          <Link
            to={paths.overview}
            className="text-brand-700 mt-7 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium hover:underline"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to overview
          </Link>
        </div>
      </Card>
    </div>
  )
}
