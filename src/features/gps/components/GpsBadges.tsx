import { Antenna, Radio, Satellite } from 'lucide-react'

import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type {
  GpsConnectionStatus,
  GpsPositionFreshness,
  GpsSyncHealth,
  GpsUnitAvailability,
} from '@/types/database'

import {
  CONNECTION_STATUS,
  POSITION_FRESHNESS,
  SYNC_HEALTH,
  UNIT_AVAILABILITY,
  formatAge,
  providerConnectivity,
} from '../domain'

/**
 * The three facts, kept apart.
 *
 * A single green dot on a tracking screen is a lie waiting to happen: it merges
 * "the tracker is talking to its provider", "the position we hold is recent" and
 * "our integration is working", which fail independently and mean different
 * things to whoever is looking. A tracker can be online while our credential is
 * dead — the map would be green and hours old. Our synchronisation can be
 * perfect while a device sits in a basement — the map would be green and wrong.
 *
 * So there are three badges, they never collapse, and each says what it knows
 * with the word the data supports. `title` carries the sentence, so hovering any
 * of them explains what it is claiming.
 */

export function PositionFreshnessBadge({
  freshness,
  ageSeconds,
}: {
  freshness: GpsPositionFreshness
  ageSeconds?: number | null
}) {
  const meta = POSITION_FRESHNESS[freshness]
  const age =
    freshness === 'unknown' || ageSeconds === null || ageSeconds === undefined
      ? null
      : formatAge(ageSeconds)

  return (
    <Badge tone={meta.tone} withDot title={meta.detail}>
      {age ? `${meta.label} · ${age}` : meta.label}
    </Badge>
  )
}

export function ProviderConnectivityBadge({ online }: { online: boolean | null }) {
  const meta = providerConnectivity(online)
  return (
    <Badge tone={meta.tone} title={meta.detail}>
      <Antenna className="size-3" aria-hidden="true" />
      {meta.label}
    </Badge>
  )
}

export function SyncHealthBadge({ health }: { health: GpsSyncHealth }) {
  const meta = SYNC_HEALTH[health]
  return (
    <Badge tone={meta.tone} title={meta.detail}>
      <Radio className="size-3" aria-hidden="true" />
      {meta.label}
    </Badge>
  )
}

export function ConnectionStatusBadge({ status }: { status: GpsConnectionStatus }) {
  const meta = CONNECTION_STATUS[status]
  return (
    <Badge tone={meta.tone} withDot title={meta.detail}>
      {meta.label}
    </Badge>
  )
}

export function UnitAvailabilityBadge({ availability }: { availability: GpsUnitAvailability }) {
  const meta = UNIT_AVAILABILITY[availability]
  return (
    <Badge tone={meta.tone} title={meta.detail}>
      {meta.label}
    </Badge>
  )
}

export interface TrackingFactsProps {
  freshness: GpsPositionFreshness
  ageSeconds: number | null
  providerOnline: boolean | null
  syncHealth: GpsSyncHealth
  className?: string
}

/** All three, in the order somebody reads them: what, from whom, via what. */
export function TrackingFacts({
  freshness,
  ageSeconds,
  providerOnline,
  syncHealth,
  className,
}: TrackingFactsProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <PositionFreshnessBadge freshness={freshness} ageSeconds={ageSeconds} />
      <ProviderConnectivityBadge online={providerOnline} />
      <SyncHealthBadge health={syncHealth} />
    </div>
  )
}

/**
 * A labelled value that renders an unknown as an unknown.
 *
 * Every telemetry field on this screen goes through here, so there is exactly
 * one place where "the provider did not report this" could accidentally become
 * a zero — and it does not.
 */
export function TelemetryFact({
  label,
  value,
  hint,
  unknown = false,
}: {
  label: string
  value: string
  hint?: string
  unknown?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-subtle text-2xs tracking-wide uppercase">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate text-[0.8125rem] tabular-nums',
          unknown ? 'text-ink-subtle' : 'text-ink',
        )}
        title={hint ?? undefined}
      >
        {value}
      </dd>
    </div>
  )
}

/** Used where a device reports nothing at all, so the row is not simply blank. */
export function NoTelemetryNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-ink-subtle flex items-start gap-2 text-[0.8125rem] leading-5">
      <Satellite className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
