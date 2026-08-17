import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useOrganization } from '@/features/workspace/workspace-context'

import {
  type FleetQuery,
  type HistoryQuery,
  type InventoryQuery,
  type SaveConnectionInput,
  type TestConnectionInput,
  assignUnit,
  disconnectConnection,
  fetchAssignableVehicles,
  fetchAttentionSignals,
  fetchConnections,
  fetchFleet,
  fetchSyncRuns,
  fetchUnitInventory,
  fetchVehicleFleetRow,
  fetchVehicleTrack,
  refreshPositions,
  saveConnection,
  syncDevices,
  testConnection,
  unassignUnit,
} from './api'
import { BACKGROUND_REFRESH_MS, LIVE_REFRESH_MS } from './domain'

/**
 * Query keys for tracking.
 *
 * Every key begins with the organization id. That is not tidiness: a tracking
 * cache keyed on `['gps','fleet']` alone would serve one agency's vehicle
 * positions to the next agency the user switches into, for as long as the entry
 * stayed fresh. Prefixing with the workspace makes that impossible and lets the
 * workspace switcher's blanket `['organization', id]` invalidation reach every
 * key here without listing them.
 */
export const gpsKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'gps'] as const,
  connections: (organizationId: string) =>
    ['organization', organizationId, 'gps', 'connections'] as const,
  fleet: (organizationId: string, query: Omit<FleetQuery, 'organizationId'>) =>
    ['organization', organizationId, 'gps', 'fleet', query] as const,
  vehicle: (organizationId: string, vehicleId: string) =>
    ['organization', organizationId, 'gps', 'vehicle', vehicleId] as const,
  inventory: (organizationId: string, query: Omit<InventoryQuery, 'organizationId'>) =>
    ['organization', organizationId, 'gps', 'inventory', query] as const,
  syncRuns: (organizationId: string, connectionId: string) =>
    ['organization', organizationId, 'gps', 'sync-runs', connectionId] as const,
  attention: (organizationId: string) =>
    ['organization', organizationId, 'gps', 'attention'] as const,
  assignable: (organizationId: string, search: string) =>
    ['organization', organizationId, 'gps', 'assignable', search] as const,
  track: (organizationId: string, vehicleId: string, from: string, to: string) =>
    ['organization', organizationId, 'gps', 'track', vehicleId, from, to] as const,
}

async function invalidateGps(client: QueryClient, organizationId: string): Promise<void> {
  await client.invalidateQueries({ queryKey: gpsKeys.all(organizationId) })
}

// -----------------------------------------------------------------------------
// Live-while-watched
// -----------------------------------------------------------------------------

/**
 * True while this tab is the one somebody is looking at.
 *
 * Tracking polls, and polling a hidden tab is pure cost: a laptop with eight
 * agency tabs open would keep eight refresh loops alive for a map nobody can
 * see. React Query already pauses on window blur for `refetchIntervalInBackground:
 * false`, but the interval itself is chosen here so a visible tab and a
 * backgrounded one ask at honestly different rates rather than one rate that is
 * wrong for both.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  )

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export function useGpsConnections() {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.connections(organization.id),
    queryFn: () => fetchConnections(organization.id),
    staleTime: 30_000,
  })
}

export interface FleetOptions extends Omit<FleetQuery, 'organizationId'> {
  /** Re-reads the snapshot while a person is watching the map. */
  readonly live?: boolean
  readonly enabled?: boolean
}

/**
 * The fleet snapshot.
 *
 * This re-reads the DATABASE, not the provider. Asking the provider is a
 * separate, explicit action — `useRefreshPositions` — which the map runs on its
 * own timer and which coalesces across tabs server-side. Keeping the two apart
 * means a second person opening the map costs one database read rather than one
 * more provider call.
 */
export function useGpsFleet(options: FleetOptions = {}) {
  const organization = useOrganization()
  const visible = useDocumentVisible()
  const { live = false, enabled = true, ...query } = options

  return useQuery({
    queryKey: gpsKeys.fleet(organization.id, query),
    queryFn: () => fetchFleet({ organizationId: organization.id, ...query }),
    enabled,
    staleTime: 5_000,
    refetchInterval: live ? (visible ? LIVE_REFRESH_MS : BACKGROUND_REFRESH_MS) : false,
    refetchIntervalInBackground: false,
  })
}

export function useVehicleGps(vehicleId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.vehicle(organization.id, vehicleId ?? 'none'),
    queryFn: () => fetchVehicleFleetRow(organization.id, vehicleId as string),
    enabled: Boolean(vehicleId),
    staleTime: 15_000,
  })
}

export function useGpsInventory(query: Omit<InventoryQuery, 'organizationId'> = {}) {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.inventory(organization.id, query),
    queryFn: () => fetchUnitInventory({ organizationId: organization.id, ...query }),
    staleTime: 15_000,
  })
}

export function useGpsSyncRuns(connectionId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.syncRuns(organization.id, connectionId ?? 'none'),
    queryFn: () => fetchSyncRuns(connectionId as string),
    enabled: Boolean(connectionId),
    staleTime: 15_000,
  })
}

export function useGpsAttention(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.attention(organization.id),
    queryFn: () => fetchAttentionSignals(organization.id),
    enabled,
    staleTime: 30_000,
  })
}

export function useAssignableVehicles(search: string, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.assignable(organization.id, search),
    queryFn: () => fetchAssignableVehicles(organization.id, search),
    enabled,
    staleTime: 30_000,
  })
}

/**
 * A vehicle's track over a period.
 *
 * Cached for five minutes because history does not change: the same window of
 * last Tuesday is the same answer every time it is asked for, and each ask is a
 * live provider request charged to the agency's account.
 */
export function useVehicleTrack(query: HistoryQuery | null) {
  const organization = useOrganization()

  return useQuery({
    queryKey: gpsKeys.track(
      organization.id,
      query?.vehicleId ?? 'none',
      query?.from.toISOString() ?? '',
      query?.to.toISOString() ?? '',
    ),
    queryFn: () => fetchVehicleTrack(query as HistoryQuery),
    enabled: query !== null,
    staleTime: 300_000,
    retry: false,
  })
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export function useTestConnection() {
  return useMutation({
    mutationFn: (input: Omit<TestConnectionInput, 'organizationId'> & { organizationId: string }) =>
      testConnection(input),
  })
}

export function useSaveConnection() {
  const client = useQueryClient()
  const organization = useOrganization()

  return useMutation({
    mutationFn: (input: Omit<SaveConnectionInput, 'organizationId'>) =>
      saveConnection({ organizationId: organization.id, ...input }),
    onSuccess: async () => {
      await invalidateGps(client, organization.id)
    },
  })
}

export function useDisconnectConnection() {
  const client = useQueryClient()
  const organization = useOrganization()

  return useMutation({
    mutationFn: (connectionId: string) => disconnectConnection(connectionId),
    onSuccess: async () => {
      await invalidateGps(client, organization.id)
    },
  })
}

/**
 * Asks the provider for current positions, then re-reads the snapshot.
 *
 * The server may answer `coalesced` — another tab in this agency asked less than
 * twenty seconds ago and its answer still stands. That is a success, not a
 * failure: the snapshot is re-read either way, and the interface says "just
 * updated" rather than pretending a provider call happened.
 */
export function useRefreshPositions() {
  const client = useQueryClient()
  const organization = useOrganization()

  return useMutation({
    mutationFn: (connectionId: string) => refreshPositions(connectionId),
    onSettled: async () => {
      await invalidateGps(client, organization.id)
    },
  })
}

export function useSyncDevices() {
  const client = useQueryClient()
  const organization = useOrganization()

  return useMutation({
    mutationFn: (connectionId: string) => syncDevices(connectionId),
    onSettled: async () => {
      await invalidateGps(client, organization.id)
    },
  })
}

export function useAssignUnit() {
  const client = useQueryClient()
  const organization = useOrganization()

  return useMutation({
    mutationFn: (input: { vehicleId: string; unitId: string; note?: string | null }) =>
      assignUnit(input.vehicleId, input.unitId, input.note ?? null),
    onSuccess: async () => {
      await invalidateGps(client, organization.id)
    },
  })
}

export function useUnassignUnit() {
  const client = useQueryClient()
  const organization = useOrganization()

  return useMutation({
    mutationFn: (assignmentId: string) => unassignUnit(assignmentId),
    onSuccess: async () => {
      await invalidateGps(client, organization.id)
    },
  })
}
