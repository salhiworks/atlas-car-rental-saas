import { KeyRound, PlugZap, RefreshCw, Unplug } from 'lucide-react'
import { useState } from 'react'

import { Alert, Button, Card, CardBody, CardHeader, ConfirmDialog, useToast } from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { GpsProviderConnection, GpsSyncRun } from '@/types/database'

import { CONNECTION_STATUS } from '../domain'
import { useDisconnectConnection, useSyncDevices } from '../queries'

import { ConnectionStatusBadge } from './GpsBadges'
import { getAppName } from '@/lib/config/env'

/**
 * What the agency can see about its own integration.
 *
 * An integration that fails silently is worse than one that is switched off:
 * the map keeps showing yesterday's positions and looks exactly like a map
 * showing today's. So this card states, separately and plainly, when the
 * provider was last reached, when it last succeeded, how long that took, and
 * what the last failure was — and the last failure is a category and a sentence
 * we wrote, never a provider payload echoed back at somebody.
 */

export interface ConnectionCardProps {
  connection: GpsProviderConnection
  runs: readonly GpsSyncRun[]
  locale: string
  timeZone: string
  canAdminister: boolean
  onReplaceCredential: () => void
}

export function ConnectionCard({
  connection,
  runs,
  locale,
  timeZone,
  canAdminister,
  onReplaceCredential,
}: ConnectionCardProps) {
  const toast = useToast()
  const sync = useSyncDevices()
  const disconnect = useDisconnectConnection()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })

  const meta = CONNECTION_STATUS[connection.status]
  const disabled = connection.disabled_at !== null

  async function onSync() {
    try {
      const result = await sync.mutateAsync(connection.id)
      if (result.ok) {
        toast.success('Devices synchronised', 'The device list now matches the provider.')
      } else {
        toast.error('Synchronisation failed', 'The connection card shows what went wrong.')
      }
    } catch (error) {
      toast.error('Synchronisation failed', toErrorMessage(error))
    }
  }

  async function onDisconnect() {
    try {
      await disconnect.mutateAsync(connection.id)
      setConfirmDisconnect(false)
      toast.success(
        'Provider switched off',
        'Devices, assignments and last known positions are kept. Nothing is being synchronised.',
      )
    } catch (error) {
      toast.error('Could not switch off', toErrorMessage(error))
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {connection.label}
            <ConnectionStatusBadge status={connection.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="capitalize">{connection.provider}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[0.75rem]">{connection.base_url}</span>
            {connection.account_label ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{connection.account_label}</span>
              </>
            ) : null}
          </span>
        }
        actions={
          canAdminister ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<RefreshCw />}
                onClick={() => void onSync()}
                isLoading={sync.isPending}
                disabled={disabled}
              >
                Synchronise
              </Button>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<KeyRound />}
                onClick={onReplaceCredential}
              >
                {disabled ? 'Reconnect' : 'Replace credential'}
              </Button>
              {!disabled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<Unplug />}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Switch off
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <CardBody className="space-y-4">
        <p className="text-ink-muted text-[0.8125rem] leading-5">{meta.detail}</p>

        {connection.last_error_message && connection.status !== 'healthy' ? (
          <Alert tone={connection.status === 'rate_limited' ? 'caution' : 'critical'}>
            {connection.last_error_message}
            {connection.last_error_at ? (
              <span className="mt-1 block text-[0.75rem] opacity-80">
                {dateTime.format(new Date(connection.last_error_at))}
              </span>
            ) : null}
          </Alert>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Devices</dt>
            <dd className="mt-0.5 text-[0.8125rem] tabular-nums">{connection.unit_count ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Last success</dt>
            <dd className="mt-0.5 text-[0.8125rem]">
              {connection.last_sync_success_at
                ? dateTime.format(new Date(connection.last_sync_success_at))
                : 'Never'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Last attempt</dt>
            <dd className="mt-0.5 text-[0.8125rem]">
              {connection.last_sync_started_at
                ? dateTime.format(new Date(connection.last_sync_started_at))
                : 'Never'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Round trip</dt>
            <dd className="mt-0.5 text-[0.8125rem] tabular-nums">
              {connection.last_sync_duration_ms === null
                ? '—'
                : `${connection.last_sync_duration_ms.toLocaleString(locale)} ms`}
            </dd>
          </div>
        </dl>

        {runs.length > 0 ? (
          <div>
            <p className="text-ink-subtle text-2xs mb-1.5 tracking-wide uppercase">
              Recent attempts
            </p>
            <ul className="divide-line border-line divide-y rounded-md border text-[0.75rem]">
              {runs.slice(0, 6).map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5"
                >
                  <span className="tabular-nums">{dateTime.format(new Date(run.started_at))}</span>
                  <span
                    className={
                      run.outcome === 'success'
                        ? 'text-positive-700'
                        : run.outcome === 'partial'
                          ? 'text-caution-700'
                          : 'text-critical-700'
                    }
                  >
                    {run.outcome ?? 'in progress'}
                  </span>
                  <span className="text-ink-muted tabular-nums">
                    {run.unit_count ?? 0} devices
                    {run.skipped_count ? ` · ${run.skipped_count} skipped` : ''}
                  </span>
                  {run.duration_ms !== null ? (
                    <span className="text-ink-subtle tabular-nums">{run.duration_ms} ms</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
         * The honest sentence about cadence.
         *
         * This deployment has no scheduler: Hostinger serves static files and the
         * database has neither pg_cron nor pg_net, so nothing runs while nobody
         * is here. Saying "24/7 monitoring" would be a lie that costs an agency
         * real money the first time they rely on it.
         */}
        <p className="text-ink-subtle border-line flex gap-2 border-t pt-3 text-[0.75rem] leading-4">
          <PlugZap className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Positions refresh while somebody has the tracking workspace open, and when anyone
            presses Refresh. Nothing runs in the background: nothing is fetched overnight, and{' '}
            {getAppName()} will not alert you to a vehicle moving while nobody is watching.
          </span>
        </p>
      </CardBody>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Switch off this provider connection?"
        description="The stored credential is deleted and synchronising stops. Your devices, their vehicle assignments and the last known positions are kept, so switching it back on is a matter of pasting a new token."
        confirmLabel="Switch off"
        tone="danger"
        isPending={disconnect.isPending}
        onConfirm={() => void onDisconnect()}
      />
    </Card>
  )
}
