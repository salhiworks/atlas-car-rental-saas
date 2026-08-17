import { KeyRound } from 'lucide-react'

import type { EnvironmentProblem } from '@/lib/config/env'

/**
 * Rendered instead of the application when the environment is not usable.
 *
 * The alternative — starting anyway and filling the interface with placeholder
 * numbers — would let a misconfigured deployment look like a working one. This
 * screen states exactly which variable is wrong and where its value comes from.
 */
export function ConfigurationRequired({ problems }: { problems: readonly EnvironmentProblem[] }) {
  return (
    <div className="bg-canvas flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="bg-surface border-line w-full max-w-xl rounded-lg border p-8 shadow-raised">
        <div className="border-line bg-surface-inset text-ink-muted mb-5 flex size-10 items-center justify-center rounded-lg border">
          <KeyRound className="size-5" aria-hidden="true" />
        </div>

        <h1 className="text-lg font-semibold">Connect a database to continue</h1>
        <p className="text-ink-muted mt-2 text-[0.8125rem] leading-6">
          This deployment is not linked to a Supabase project yet, so there is nothing to sign in
          to. Add the values below to a <code className="identifier">.env.local</code> file in the
          project root and restart the dev server.
        </p>

        <ul className="mt-6 space-y-3">
          {problems.map((problem) => (
            <li key={problem.variable} className="border-line rounded-md border p-3.5">
              <p className="identifier text-ink font-medium">{problem.variable}</p>
              <p className="text-ink-muted mt-1 text-[0.8125rem] leading-5">{problem.detail}</p>
            </li>
          ))}
        </ul>

        <p className="text-ink-subtle mt-6 text-[0.75rem] leading-5">
          Both values are in your Supabase dashboard under Project Settings → API. See{' '}
          <code className="identifier">.env.example</code> for the full list.
        </p>
      </div>
    </div>
  )
}
