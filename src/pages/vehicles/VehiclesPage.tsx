import { CarFront, Plus, SearchX, Upload } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import { Button, ButtonLink, Card, EmptyState, ListPagination, PageHeader } from '@/components/ui'
import { VEHICLE_SORTS, type ComplianceFilter, type VehicleSort } from '@/features/vehicles/api'
import { FleetSummary } from '@/features/vehicles/components/FleetSummary'
import { FleetToolbar, type FleetFilters } from '@/features/vehicles/components/FleetToolbar'
import { VehicleCardList } from '@/features/vehicles/components/VehicleCardList'
import { VehicleImportDialog } from '@/features/vehicles/components/VehicleImportDialog'
import { VehicleTable } from '@/features/vehicles/components/VehicleTable'
import {
  useFleetCounts,
  useVehicleList,
  useVehicleMakes,
  useVehicleThumbnails,
} from '@/features/vehicles/queries'
import { useComplianceOptions, useDistanceUnit } from '@/features/workspace/useOrganizationSettings'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import type { VehicleStatus } from '@/types/database'

const STATUS_VALUES: readonly VehicleStatus[] = [
  'available',
  'rented',
  'reserved',
  'maintenance',
  'unavailable',
]

function isVehicleStatus(value: string): value is VehicleStatus {
  return (STATUS_VALUES as readonly string[]).includes(value)
}

function isVehicleSort(value: string): value is VehicleSort {
  return value in VEHICLE_SORTS
}

/**
 * Fleet list.
 *
 * Filters live in the URL rather than in component state, so a filtered view can
 * be bookmarked, reloaded and sent to a colleague — which is what people do with
 * "every car whose insurance has expired".
 */
export function VehiclesPage() {
  const organization = useOrganization()
  const canCreate = usePermission('vehicles.create')
  const compliance = useComplianceOptions()
  const distanceUnit = useDistanceUnit()
  const [searchParams, setSearchParams] = useSearchParams()
  const [isImportOpen, setIsImportOpen] = useState(false)

  const filters: FleetFilters = useMemo(() => {
    const sort = searchParams.get('sort') ?? 'newest'
    const compliance = searchParams.get('compliance') ?? 'any'

    return {
      search: searchParams.get('q') ?? '',
      sort: isVehicleSort(sort) ? sort : 'newest',
      makes: searchParams.getAll('make'),
      modelYear: searchParams.get('year') ? Number(searchParams.get('year')) : null,
      compliance: ['any', 'expired', 'unrecorded'].includes(compliance)
        ? (compliance as ComplianceFilter)
        : 'any',
      includeArchived: searchParams.get('archived') === '1',
    }
  }, [searchParams])

  const statuses = useMemo(
    () => searchParams.getAll('status').filter(isVehicleStatus),
    [searchParams],
  )

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, { resetPage = true } = {}) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          mutate(next)
          if (resetPage) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const handleFilterChange = useCallback(
    (patch: Partial<FleetFilters>) => {
      updateParams((params) => {
        if (patch.search !== undefined) {
          if (patch.search === '') params.delete('q')
          else params.set('q', patch.search)
        }
        if (patch.sort !== undefined) {
          if (patch.sort === 'newest') params.delete('sort')
          else params.set('sort', patch.sort)
        }
        if (patch.makes !== undefined) {
          params.delete('make')
          for (const make of patch.makes) params.append('make', make)
        }
        if (patch.modelYear !== undefined) {
          if (patch.modelYear === null) params.delete('year')
          else params.set('year', String(patch.modelYear))
        }
        if (patch.compliance !== undefined) {
          if (patch.compliance === 'any') params.delete('compliance')
          else params.set('compliance', patch.compliance)
        }
        if (patch.includeArchived !== undefined) {
          if (patch.includeArchived) params.set('archived', '1')
          else params.delete('archived')
        }
      })
    },
    [updateParams],
  )

  const toggleStatus = useCallback(
    (status: VehicleStatus) => {
      updateParams((params) => {
        params.delete('status')
        params.append('status', status)
      })
    },
    [updateParams],
  )

  const clearStatuses = useCallback(() => {
    updateParams((params) => params.delete('status'))
  }, [updateParams])

  const clearAll = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true })
  }, [setSearchParams])

  const countsQuery = useFleetCounts()
  const makesQuery = useVehicleMakes()

  const listQuery = useVehicleList({
    search: filters.search,
    statuses,
    makes: filters.makes,
    modelYear: filters.modelYear,
    compliance: filters.compliance,
    includeArchived: filters.includeArchived,
    sort: filters.sort,
    page,
  })

  const vehicles = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data])
  const thumbnails = useVehicleThumbnails(
    useMemo(() => vehicles.map((vehicle) => vehicle.vehicle_id), [vehicles]),
  )

  const availableYears = useMemo(() => {
    const current = new Date().getUTCFullYear()
    return Array.from({ length: 30 }, (_, index) => current + 1 - index)
  }, [])

  const activeFilterCount =
    (filters.makes.length > 0 ? 1 : 0) +
    (filters.modelYear !== null ? 1 : 0) +
    (filters.compliance !== 'any' ? 1 : 0) +
    (filters.includeArchived ? 1 : 0) +
    (statuses.length > 0 ? 1 : 0)

  const hasAnyVehicles = (countsQuery.data?.total ?? 0) > 0 || (countsQuery.data?.archived ?? 0) > 0
  const isFiltered = activeFilterCount > 0 || filters.search.length > 0
  const total = listQuery.data?.total ?? 0
  const pageCount = listQuery.data?.pageCount ?? 1

  const addAction = canCreate ? (
    <div className="flex items-center gap-2">
      <Button variant="secondary" leadingIcon={<Upload />} onClick={() => setIsImportOpen(true)}>
        Import
      </Button>
      <ButtonLink variant="primary" leadingIcon={<Plus />} to={paths.vehicleNew}>
        Add vehicle
      </ButtonLink>
    </div>
  ) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vehicles"
        eyebrow="Fleet"
        description={`Every vehicle ${organization.name} operates, and what each one is doing right now.`}
        actions={addAction}
      />

      {/* Six zeros describe nothing. The strip appears with the first vehicle. */}
      {countsQuery.isPending || hasAnyVehicles || isFiltered ? (
        <FleetSummary
          counts={countsQuery.data}
          isLoading={countsQuery.isPending}
          activeStatuses={statuses}
          onToggleStatus={toggleStatus}
          onClear={clearStatuses}
        />
      ) : null}

      {countsQuery.isError ? (
        <Card>
          <ErrorState error={countsQuery.error} onRetry={() => void countsQuery.refetch()} />
        </Card>
      ) : null}

      {/* The toolbar is pointless before there is anything to search. */}
      {hasAnyVehicles || isFiltered ? (
        <FleetToolbar
          filters={filters}
          onChange={handleFilterChange}
          availableMakes={makesQuery.data ?? []}
          availableYears={availableYears}
          activeFilterCount={activeFilterCount}
          onClearAll={clearAll}
        />
      ) : null}

      <Card className="overflow-hidden">
        {listQuery.isError ? (
          <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
        ) : listQuery.isPending ? (
          <>
            <VehicleTable
              vehicles={[]}
              thumbnails={thumbnails}
              compliance={compliance}
              locale={organization.locale}
              distanceUnit={distanceUnit}
              isLoading
            />
            <VehicleCardList
              vehicles={[]}
              thumbnails={thumbnails}
              compliance={compliance}
              locale={organization.locale}
              distanceUnit={distanceUnit}
              isLoading
            />
          </>
        ) : vehicles.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={SearchX}
              title="No vehicles match these filters"
              description="Try a different search term, or clear the filters to see the whole fleet."
              action={
                <Button variant="secondary" size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={CarFront}
              title="Add your first vehicle"
              description="Once a vehicle is in the fleet you can track its mileage, rate, compliance dates and availability, and put it on a contract."
              action={
                canCreate ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <ButtonLink variant="primary" to={paths.vehicleNew}>
                      Add vehicle
                    </ButtonLink>
                    <Button variant="secondary" onClick={() => setIsImportOpen(true)}>
                      Import from a spreadsheet
                    </Button>
                  </div>
                ) : (
                  <p className="text-ink-subtle text-[0.8125rem]">
                    Ask a manager or administrator to add vehicles to this fleet.
                  </p>
                )
              }
            />
          )
        ) : (
          <>
            <VehicleTable
              vehicles={vehicles}
              thumbnails={thumbnails}
              compliance={compliance}
              locale={organization.locale}
              distanceUnit={distanceUnit}
            />
            <VehicleCardList
              vehicles={vehicles}
              thumbnails={thumbnails}
              compliance={compliance}
              locale={organization.locale}
              distanceUnit={distanceUnit}
            />
          </>
        )}

        <ListPagination
          page={page}
          pageCount={pageCount}
          total={total}
          noun="vehicle"
          onPageChange={(next) =>
            updateParams((params) => params.set('page', String(next)), { resetPage: false })
          }
        />
      </Card>

      <VehicleImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  )
}
