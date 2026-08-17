import { Info } from 'lucide-react'

import { Card, CardBody, CardHeader, Skeleton, Switch } from '@/components/ui'
import { ErrorState } from '@/components/feedback/ErrorState'
import { CATEGORY_DESCRIPTIONS, CATEGORY_LABELS } from '../domain'
import { useNotificationPreferences, useSetNotificationPreference } from '../queries'
import { getAppName } from '@/lib/config/env'

/**
 * Notification preferences, in Settings.
 *
 * Yours and nobody else's: muting Financing here silences it for you, in this
 * agency, and changes nothing for a colleague. There is no organisation-wide
 * notification policy and no way to edit somebody else's inbox.
 *
 * Only categories this person can actually receive are listed — the database
 * decides which those are, and refuses to store a preference for anything else.
 * A toggle for something that will never arrive is a control that does nothing.
 *
 * There are no email, SMS or push switches. None of those channels is delivered
 * by this deployment, and a switch that turns on nothing is worse than an
 * absent feature: it makes somebody believe they will be told.
 */
export function NotificationPreferences() {
  const preferences = useNotificationPreferences()
  const setPreference = useSetNotificationPreference()

  return (
    <Card>
      <CardHeader
        title="What you are told about"
        description="Each row is a category of reminder. Changes here save as you make them."
      />

      {preferences.isError ? (
        <CardBody>
          <ErrorState
            error={preferences.error}
            title="Preferences could not be loaded"
            onRetry={() => void preferences.refetch()}
          />
        </CardBody>
      ) : preferences.isPending ? (
        <CardBody className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </CardBody>
      ) : (
        <>
          <ul className="divide-line divide-y">
            {preferences.data.map((preference) => {
              const category = preference.category
              const inputId = `notification-${category}`

              return (
                <li
                  key={category}
                  className="flex items-start justify-between gap-x-6 gap-y-1 px-5 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <label htmlFor={inputId} className="text-ink text-[0.8125rem] font-medium">
                      {CATEGORY_LABELS[category]}
                    </label>
                    <p className="text-ink-muted mt-0.5 text-[0.75rem] leading-4">
                      {CATEGORY_DESCRIPTIONS[category]}
                    </p>
                  </div>

                  <Switch
                    id={inputId}
                    className="mt-0.5"
                    checked={!preference.muted}
                    disabled={setPreference.isPending}
                    onChange={(event) =>
                      setPreference.mutate({ category, muted: !event.target.checked })
                    }
                  />
                </li>
              )
            })}
          </ul>

          {/*
            Said once, plainly, where somebody configuring reminders will read
            it. Nothing in this product runs while the tab is closed, and a
            notification surface that implies otherwise is the one lie that
            would matter most here. A tinted alert box gave it the weight of a
            warning; it is a fact about the product, so it is set as a footnote.
          */}
          <div className="border-line text-ink-subtle flex gap-2.5 border-t px-5 py-3.5">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <p className="text-[0.75rem] leading-5">
              Reminders are worked out from your live records each time you open {getAppName()}.
              Nothing runs overnight, and no email is sent for them.
            </p>
          </div>
        </>
      )}
    </Card>
  )
}
