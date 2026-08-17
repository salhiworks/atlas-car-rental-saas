import { List, Map as MapIcon, MapPinned, Plug, RefreshCw, Search, SearchX } from 'lucide-react'
import { Suspense, lazy, useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Button,
  Card,
  CardBody,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Spinner,
  useToast,
} from '@/components/ui'
import { ConnectionCard } from '@/features/gps/components/ConnectionCard'
import { ConnectionDialog } from '@/features/gps/components/ConnectionDialog'
import { DeviceInventory } from '@/features/gps/components/DeviceInventory'
import { FleetList } from '@/features/gps/components/FleetList'
import { HistoryPanel } from '@/features/gps/components/HistoryPanel'
import { SyncHealthBadge } from '@/features/gps/components/GpsBadges'
import { VehicleTrackingPanel } from '@/features/gps/components/VehicleTrackingPanel'
import {
  useGpsConnections,
  useGpsFleet,
  useGpsSyncRuns,
  useRefreshPositions,
} from '@/features/gps/queries'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { GpsFleetRow, GpsProviderConnection } from '@/types/database'
import { getAppName } from '@/lib/config/env'

/*
 * The map is the heaviest thing this application loads, and most sessions never
 * open this page. Splitting it out keeps MapLibre and its stylesheet off the
 * critical path for everybody who came here to write a contract.
 */
const FleetMap = lazy(() => import('@/features/gps/components/FleetMap'))

/**
 * The tracking workspace.
 *
 * List and map are two views of one selection: clicking a dot highlights a row,
 * clicking a row pans to the dot, and both agree at all times. The list is
 * authoritative — a vehicle with no usable position appears there, labelled, and
 * simply cannot appear on a map.
 *
 * Filters live in the URL because a view worth building is a view worth sending
 * to a colleague. None of them carries anything about a customer: this screen
 * shows plates, devices and contract references, and never a name.
 */

type TabKey = 'map' | 'devices' | 'connection'
type FreshnessFilter = 'any' | 'live' | 'delayed' | 'none'
type HireFilter = 'any' | 'on_hire' | 'off_hire'

const FRESHNESS_OPTIONS = [
  { value: 'any', label: 'Any position age' },
  { value: 'live', label: 'Live only' },
  { value: 'delayed', label: 'Delayed or older' },
  { value: 'none', label: 'No position' },
] as const

const HIRE_OPTIONS = [
  { value: 'any', label: 'On hire or not' },
  { value: 'on_hire', label: 'On hire now' },
  { value: 'off_hire', label: 'Not on hire' },
] as const

function isTab(value: string | null): value is TabKey {
  return value === 'map' || value === 'devices' || value === 'connection'
}

export function GpsTrackingPage() {
  const organization = useOrganization()
  const toast = useToast()
  const canAdminister = usePermission('gps.connect')
  const canAssign = usePermission('gps.assign')
  const canSync = usePermission('gps.sync')

  const [searchParams, setSearchParams] = useSearchParams()
  const [connectionDialog, setConnectionDialog] = useState<{
    open: boolean
    connection: GpsProviderConnection | null
  }>({ open: false, connection: null })
  const [historyFor, setHistoryFor] = useState<GpsFleetRow | null>(null)
  const [mobileView, setMobileView] = useState<'map' | 'list'>('list')

  const tabParam = searchParams.get('tab')
  const tab: TabKey = isTab(tabParam) ? tabParam : 'map'
  const search = searchParams.get('q') ?? ''
  const freshness = (searchParams.get('state') ?? 'any') as FreshnessFilter
  const hire = (searchParams.get('hire') ?? 'any') as HireFilter
  const selectedVehicleId = searchParams.get('v')

  const patchParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '' || value === 'any') next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const connections = useGpsConnections()
  const connection = connections.data?.[0] ?? null

  const fleet = useGpsFleet({
    search,
    // Only poll on the map tab: a device table does not need a heartbeat.
    live: tab === 'map',
    enabled: connections.isSuccess && connections.data.length > 0,
  })

  const runs = useGpsSyncRuns(tab === 'connection' ? (connection?.id ?? undefined) : undefined)
  const refresh = useRefreshPositions()

  const rows = useMemo(() => {
    const all = fleet.data ?? []
    return all.filter((row) => {
      if (freshness === 'live' && row.position_freshness !== 'fresh') return false
      if (
        freshness === 'delayed' &&
        row.position_freshness !== 'stale' &&
        row.position_freshness !== 'very_stale' &&
        row.position_freshness !== 'future'
      ) {
        return false
      }
      if (freshness === 'none' && row.position_freshness !== 'unknown') return false
      if (hire === 'on_hire' && row.current_rental_id === null) return false
      if (hire === 'off_hire' && row.current_rental_id !== null) return false
      return true
    })
  }, [fleet.data, freshness, hire])

  const selected = rows.find((row) => row.vehicle_id === selectedVehicleId) ?? null

  async function onRefresh() {
    if (!connection) return
    try {
      const result = await refresh.mutateAsync(connection.id)
      if (result.coalesced) {
        toast.toast({
          tone: 'info',
          title: 'Already up to date',
          description:
            'Another open tab in your agency refreshed moments ago, so that answer was reused rather than asking the provider again.',
        })
      }
    } catch (error) {
      toast.error('Could not refresh positions', toErrorMessage(error))
    }
  }

  // ---------------------------------------------------------------------------
  // Not connected
  // ---------------------------------------------------------------------------

  if (connections.isError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Fleet" title="GPS tracking" />
        <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
      </div>
    )
  }

  if (connections.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Fleet" title="GPS tracking" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (connections.data.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Fleet"
          title="GPS tracking"
          description="Read vehicle positions from the tracking account your fleet already uses."
        />

        <Card>
          <EmptyState
            icon={MapPinned}
            title="No tracking provider connected"
            description={
              canAdminister
                ? `Connect the Wialon account your trackers already report to. ${getAppName()} reads positions and history from it — nothing is sent to your vehicles.`
                : 'Nobody has connected a tracking provider for this agency yet. An administrator can set it up from this screen.'
            }
            action={
              canAdminister ? (
                <Button
                  variant="primary"
                  leadingIcon={<Plug />}
                  onClick={() => setConnectionDialog({ open: true, connection: null })}
                >
                  Connect a provider
                </Button>
              ) : undefined
            }
            footer={
              <>
                <p className="text-ink mb-2 font-medium">
                  What this integration does, and does not do
                </p>
                <ul className="space-y-1.5">
                  <li className="flex gap-2">
                    <span aria-hidden="true">·</span>
                    <span>Reads unit lists, current positions and bounded history.</span>
                  </li>
                  <li className="flex gap-2">
                    <span aria-hidden="true">·</span>
                    <span>
                      Sends no commands to any tracker: no immobilisation, no door control, no
                      configuration, no alarm reset.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span aria-hidden="true">·</span>
                    <span>
                      Never overwrites a vehicle&rsquo;s recorded mileage and never creates an
                      expense from telemetry.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span aria-hidden="true">·</span>
                    <span>
                      Refreshes while somebody has this screen open. There is no background job on
                      this deployment, so nothing is fetched overnight.
                    </span>
                  </li>
                </ul>
              </>
            }
          />
        </Card>

        <ConnectionDialog
          open={connectionDialog.open}
          onOpenChange={(open) => setConnectionDialog({ open, connection: null })}
        />
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Connected
  // ---------------------------------------------------------------------------

  const total = fleet.data?.length ?? 0
  const disabled = connection?.disabled_at !== null && connection?.disabled_at !== undefined

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <PageHeader
        eyebrow="Fleet"
        title="GPS tracking"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {total} tracked {total === 1 ? 'vehicle' : 'vehicles'}
            </span>
            {connection ? (
              <>
                <span aria-hidden="true">·</span>
                <SyncHealthBadge
                  health={
                    disabled
                      ? 'disabled'
                      : connection.status === 'healthy'
                        ? 'healthy'
                        : connection.status === 'never_connected'
                          ? 'never_synced'
                          : connection.status
                  }
                />
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw />}
              onClick={() => void onRefresh()}
              isLoading={refresh.isPending}
              disabled={disabled}
            >
              Refresh
            </Button>
            {canAdminister && !connection ? (
              <Button
                leadingIcon={<Plug />}
                onClick={() => setConnectionDialog({ open: true, connection: null })}
              >
                Connect a provider
              </Button>
            ) : null}
          </>
        }
      />

      {disabled ? (
        <Alert tone="caution" title="This provider connection is switched off">
          Positions below are the last ones recorded before it was switched off. Nothing is being
          synchronised.
        </Alert>
      ) : null}

      <nav className="border-line flex gap-1 border-b" aria-label="Tracking sections">
        {(
          [
            { key: 'map', label: 'Live map' },
            { key: 'devices', label: 'Devices' },
            ...(canAdminister ? [{ key: 'connection' as const, label: 'Connection' }] : []),
          ] as ReadonlyArray<{ key: TabKey; label: string }>
        ).map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => patchParams({ tab: entry.key === 'map' ? null : entry.key })}
            aria-current={tab === entry.key ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
              tab === entry.key
                ? 'border-brand-600 text-ink'
                : 'text-ink-muted hover:text-ink border-transparent',
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'map' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search
                className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                aria-label="Search tracked vehicles"
                className="ps-9"
                placeholder="Plate, make, model or device"
                value={search}
                onChange={(event) => patchParams({ q: event.target.value })}
              />
            </div>
            <Select
              aria-label="Position age"
              className="w-44"
              value={freshness}
              onChange={(event) => patchParams({ state: event.target.value })}
              options={FRESHNESS_OPTIONS.map((option) => ({ ...option }))}
            />
            <Select
              aria-label="Hire status"
              className="w-40"
              value={hire}
              onChange={(event) => patchParams({ hire: event.target.value })}
              options={HIRE_OPTIONS.map((option) => ({ ...option }))}
            />

            {/* Below lg there is not room for a map and a list at once. */}
            <div className="border-line flex overflow-hidden rounded-md border lg:hidden">
              <button
                type="button"
                onClick={() => setMobileView('list')}
                aria-pressed={mobileView === 'list'}
                className={cn(
                  'flex h-9 items-center gap-1.5 px-3 text-[0.8125rem]',
                  mobileView === 'list' ? 'bg-surface-inset text-ink' : 'text-ink-muted',
                )}
              >
                <List className="size-3.5" aria-hidden="true" />
                List
              </button>
              <button
                type="button"
                onClick={() => setMobileView('map')}
                aria-pressed={mobileView === 'map'}
                className={cn(
                  'border-line flex h-9 items-center gap-1.5 border-s px-3 text-[0.8125rem]',
                  mobileView === 'map' ? 'bg-surface-inset text-ink' : 'text-ink-muted',
                )}
              >
                <MapIcon className="size-3.5" aria-hidden="true" />
                Map
              </button>
            </div>
          </div>

          {fleet.isError ? (
            <ErrorState error={fleet.error} onRetry={() => void fleet.refetch()} />
          ) : total === 0 && fleet.isSuccess ? (
            <Card>
              <CardBody>
                <EmptyState
                  icon={MapPinned}
                  title="No device is assigned to a vehicle yet"
                  description={
                    canAssign
                      ? 'Synchronise the connection to bring in your trackers, then assign each one to the vehicle it is fitted to.'
                      : 'An administrator needs to assign your trackers to vehicles before positions appear here.'
                  }
                  action={
                    canSync ? (
                      <Button variant="secondary" onClick={() => patchParams({ tab: 'devices' })}>
                        Open devices
                      </Button>
                    ) : undefined
                  }
                />
              </CardBody>
            </Card>
          ) : (
            <div
              className={cn(
                'border-line bg-surface grid min-h-[32rem] overflow-hidden rounded-lg border',
                'lg:h-[calc(100dvh-19rem)] lg:min-h-[28rem]',
                selected
                  ? 'lg:grid-cols-[19rem_minmax(0,1fr)_21rem]'
                  : 'lg:grid-cols-[19rem_minmax(0,1fr)]',
              )}
            >
              <div
                className={cn(
                  'border-line min-h-0 overflow-y-auto lg:block lg:border-e',
                  mobileView === 'list' ? 'block' : 'hidden',
                  selected ? 'lg:col-start-1' : '',
                )}
              >
                {fleet.isPending ? (
                  <div className="space-y-2 p-4">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                  </div>
                ) : (
                  <FleetList
                    rows={rows}
                    selectedVehicleId={selectedVehicleId}
                    onSelect={(vehicleId) => patchParams({ v: vehicleId })}
                    locale={organization.locale}
                    timeZone={organization.time_zone}
                  />
                )}
              </div>

              <div
                className={cn(
                  'relative min-h-[24rem] lg:block lg:min-h-0',
                  mobileView === 'map' ? 'block' : 'hidden',
                )}
              >
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center">
                      <Spinner />
                    </div>
                  }
                >
                  <FleetMap
                    rows={rows}
                    selectedVehicleId={selectedVehicleId}
                    onSelect={(vehicleId) => patchParams({ v: vehicleId })}
                    className="h-full w-full"
                  />
                </Suspense>
              </div>

              {selected ? (
                <div className="border-line min-h-0 border-t lg:border-t-0 lg:border-s">
                  <VehicleTrackingPanel
                    row={selected}
                    locale={organization.locale}
                    timeZone={organization.time_zone}
                    onClose={() => patchParams({ v: null })}
                    onShowHistory={() => setHistoryFor(selected)}
                    canViewHistory
                    className="h-full"
                  />
                </div>
              ) : null}
            </div>
          )}

          {rows.length === 0 && total > 0 ? (
            <Card>
              <CardBody>
                <EmptyState
                  icon={SearchX}
                  size="sm"
                  title="No tracked vehicle matches these filters"
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => patchParams({ q: null, state: null, hire: null })}
                    >
                      Clear filters
                    </Button>
                  }
                />
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === 'devices' ? (
        <DeviceInventory
          locale={organization.locale}
          timeZone={organization.time_zone}
          canAssign={canAssign}
        />
      ) : null}

      {tab === 'connection' && canAdminister ? (
        <div className="space-y-4">
          {connections.data.map((entry) => (
            <ConnectionCard
              key={entry.id}
              connection={entry}
              runs={entry.id === connection?.id ? (runs.data ?? []) : []}
              locale={organization.locale}
              timeZone={organization.time_zone}
              canAdminister={canAdminister}
              onReplaceCredential={() => setConnectionDialog({ open: true, connection: entry })}
            />
          ))}
        </div>
      ) : null}

      <ConnectionDialog
        open={connectionDialog.open}
        onOpenChange={(open) =>
          setConnectionDialog((current) => ({ open, connection: open ? current.connection : null }))
        }
        connection={connectionDialog.connection}
      />

      <Dialog
        open={historyFor !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryFor(null)
        }}
      >
        {historyFor ? (
          <DialogContent
            title={`History — ${historyFor.vehicle_plate}`}
            description={`Fetched from your tracking provider when you ask for it. ${getAppName()} keeps only the current position.`}
            size="xl"
          >
            <HistoryPanel
              vehicleId={historyFor.vehicle_id}
              plate={historyFor.vehicle_plate}
              locale={organization.locale}
              timeZone={organization.time_zone}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}
