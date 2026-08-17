import { Suspense, lazy, useMemo, useState } from 'react'

import { Alert, Button, Select, Spinner } from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { GpsTrackPoint } from '@/types/database'

import {
  downsampleForDisplay,
  formatSpeed,
  straightLineDistanceKm,
  trackPointsForMap,
} from '../domain'
import { useVehicleTrack } from '../queries'

const TrackMap = lazy(() => import('./TrackMap'))

/**
 * A vehicle's recent history, fetched from the provider on request.
 *
 * The provider remains the system of record for raw telemetry. This product
 * keeps one current position per device and asks for a window of history when
 * somebody opens this panel — which means the agency is never maintaining an
 * unbounded archive of everywhere its vehicles have ever been, and what is shown
 * is what the provider actually holds rather than what we managed to capture.
 *
 * Two numbers are always visible and always distinct: how many points the
 * provider returned, and how many of them are drawn. Thinning a track for the
 * browser is necessary; doing it silently would make a sparse track and a dense
 * one look identical.
 */

/** Beyond this a browser starts dropping frames on pan, with no visible gain. */
const MAX_DRAWN_POINTS = 2000

/** A stable identity, so an absent track does not invalidate every memo. */
const EMPTY_POINTS: readonly GpsTrackPoint[] = []

const PERIODS = [
  { value: '6', label: 'Last 6 hours', hours: 6 },
  { value: '24', label: 'Last 24 hours', hours: 24 },
  { value: '72', label: 'Last 3 days', hours: 72 },
  { value: '168', label: 'Last 7 days', hours: 168 },
] as const

export interface HistoryPanelProps {
  vehicleId: string
  plate: string
  locale: string
  timeZone: string
}

export function HistoryPanel({ vehicleId, plate, locale, timeZone }: HistoryPanelProps) {
  const [period, setPeriod] = useState<string>('24')
  const [requested, setRequested] = useState(false)

  const hours = PERIODS.find((entry) => entry.value === period)?.hours ?? 24

  // Anchored when the request is made, not on every render: a window that keeps
  // sliding would produce a new query key every second and a new provider call
  // with it.
  const [anchor, setAnchor] = useState(() => new Date())

  const query = useMemo(
    () =>
      requested
        ? {
            vehicleId,
            from: new Date(anchor.getTime() - hours * 3_600_000),
            to: anchor,
          }
        : null,
    [anchor, hours, requested, vehicleId],
  )

  const track = useVehicleTrack(query)

  const points: readonly GpsTrackPoint[] = useMemo(
    () => track.data?.points ?? EMPTY_POINTS,
    [track.data],
  )
  const drawn = useMemo(() => downsampleForDisplay(points, MAX_DRAWN_POINTS), [points])
  const distanceKm = useMemo(() => straightLineDistanceKm(trackPointsForMap(points)), [points])

  const speeds = points
    .map((point) => point.speedKph)
    .filter((value): value is number => value !== undefined)
  const topSpeed = speeds.length > 0 ? Math.max(...speeds) : null

  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label
            htmlFor="gps-history-period"
            className="text-ink-muted mb-1 block text-[0.8125rem] font-medium"
          >
            Period
          </label>
          <Select
            id="gps-history-period"
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value)
              setRequested(false)
            }}
            options={PERIODS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
        </div>
        <Button
          onClick={() => {
            setAnchor(new Date())
            setRequested(true)
          }}
          disabled={track.isFetching}
        >
          {track.isFetching ? 'Loading…' : 'Load history'}
        </Button>
      </div>

      {!requested ? (
        <p className="text-ink-muted text-[0.8125rem] leading-5">
          History is fetched from your tracking provider when you ask for it, not stored here.
          Choose a period and load it.
        </p>
      ) : null}

      {track.isError ? <Alert tone="critical">{toErrorMessage(track.error)}</Alert> : null}

      {requested && track.isFetching ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : null}

      {track.data ? (
        track.data.points.length === 0 ? (
          <Alert tone="info">
            The provider holds no positions for {plate} in this period. That is an answer, not a
            failure — the tracker may have been unpowered or out of coverage.
          </Alert>
        ) : (
          <>
            <div className="border-line h-[22rem] overflow-hidden rounded-lg border">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner />
                  </div>
                }
              >
                <TrackMap points={drawn} className="h-full w-full" />
              </Suspense>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <div>
                <dt className="text-ink-subtle text-2xs tracking-wide uppercase">
                  Positions returned
                </dt>
                <dd className="mt-0.5 text-[0.8125rem] tabular-nums">
                  {track.data.totalPoints.toLocaleString(locale)}
                  {track.data.truncated ? ' (capped)' : ''}
                </dd>
              </div>
              <div>
                <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Drawn</dt>
                <dd className="mt-0.5 text-[0.8125rem] tabular-nums">
                  {drawn.length.toLocaleString(locale)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Straight-line</dt>
                <dd className="mt-0.5 text-[0.8125rem] tabular-nums">{distanceKm.toFixed(1)} km</dd>
              </div>
              <div>
                <dt className="text-ink-subtle text-2xs tracking-wide uppercase">Top speed</dt>
                <dd className="mt-0.5 text-[0.8125rem] tabular-nums">
                  {formatSpeed(topSpeed, locale)}
                </dd>
              </div>
            </dl>

            <p className="text-ink-subtle text-[0.75rem] leading-4">
              {dateTime.format(new Date(track.data.from))} —{' '}
              {dateTime.format(new Date(track.data.to))}. Straight-line distance is the sum of the
              gaps between reported positions, not distance driven: the route between two reports is
              unknown and is not guessed at.
              {drawn.length < points.length
                ? ` Every ${Math.round(points.length / drawn.length)}th position is drawn; no position has been moved or averaged.`
                : ''}
              {track.data.truncated
                ? ' The provider returned more positions than one request may carry, so this period is cut short at the cap.'
                : ''}
            </p>
          </>
        )
      ) : null}
    </div>
  )
}
