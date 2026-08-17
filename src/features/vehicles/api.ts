import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type {
  FleetStatusCountsRow,
  FuelType,
  TablesInsert,
  TablesUpdate,
  Vehicle,
  VehicleDocument,
  VehicleFleetEntry,
  VehicleImage,
  VehicleOperationalStatus,
  VehicleStatus,
  VehicleUsageRow,
  TransmissionType,
} from '@/types/database'

import type { VehicleFormValues } from './schemas'

/** Sort orders offered in the fleet list, mapped to a column and direction. */
export const VEHICLE_SORTS = {
  newest: { column: 'created_at', ascending: false, label: 'Recently added' },
  oldest: { column: 'created_at', ascending: true, label: 'Oldest first' },
  make: { column: 'make', ascending: true, label: 'Make and model' },
  year_desc: { column: 'model_year', ascending: false, label: 'Newest model year' },
  year_asc: { column: 'model_year', ascending: true, label: 'Oldest model year' },
  odometer_desc: { column: 'odometer', ascending: false, label: 'Highest mileage' },
  odometer_asc: { column: 'odometer', ascending: true, label: 'Lowest mileage' },
  rate_desc: { column: 'daily_rate_minor', ascending: false, label: 'Highest daily rate' },
  rate_asc: { column: 'daily_rate_minor', ascending: true, label: 'Lowest daily rate' },
  status: { column: 'effective_status', ascending: true, label: 'Status' },
} as const

export type VehicleSort = keyof typeof VEHICLE_SORTS

export type ComplianceFilter = 'any' | 'attention' | 'expired' | 'unrecorded'

export interface VehicleQuery {
  readonly organizationId: string
  readonly search?: string
  readonly statuses?: readonly VehicleStatus[]
  readonly makes?: readonly string[]
  readonly modelYear?: number | null
  readonly compliance?: ComplianceFilter
  readonly includeArchived?: boolean
  readonly sort?: VehicleSort
  readonly page?: number
  readonly pageSize?: number
}

export interface VehiclePage {
  readonly rows: VehicleFleetEntry[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly pageCount: number
}

export const DEFAULT_PAGE_SIZE = 25

/** PostgREST `or=` values are comma-separated, so a comma in the term would split it. */
function escapeForOrFilter(term: string): string {
  return term.replace(/[,()]/g, ' ').trim()
}

/**
 * One query for the fleet list: filtered, sorted and paginated in the database.
 *
 * Reading the whole fleet and filtering in the browser would work for twenty
 * vehicles and quietly stop working somewhere above a few hundred, by which
 * point the filtering logic has spread across components. Pushing it into the
 * query keeps the rules in one place and keeps the payload proportional to what
 * is displayed.
 *
 * Tenancy is not expressed here as a `where` clause the caller could forget: the
 * `vehicle_fleet` view is SECURITY INVOKER, so RLS scopes it. The explicit
 * organization filter is a second, narrowing condition, not the boundary.
 */
export async function fetchVehicles(query: VehicleQuery): Promise<VehiclePage> {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE))
  const sort = VEHICLE_SORTS[query.sort ?? 'newest']

  let request = getSupabaseClient()
    .from('vehicle_fleet')
    .select('*', { count: 'exact' })
    .eq('organization_id', query.organizationId)

  if (!query.includeArchived) {
    request = request.is('archived_at', null)
  }

  const search = escapeForOrFilter(query.search ?? '')
  if (search.length > 0) {
    const pattern = `%${search}%`
    request = request.or(
      [
        `make.ilike.${pattern}`,
        `model.ilike.${pattern}`,
        `registration_plate.ilike.${pattern}`,
        `vin.ilike.${pattern}`,
      ].join(','),
    )
  }

  if (query.statuses && query.statuses.length > 0) {
    request = request.in('effective_status', [...query.statuses])
  }

  if (query.makes && query.makes.length > 0) {
    request = request.in('make', [...query.makes])
  }

  if (query.modelYear != null) {
    request = request.eq('model_year', query.modelYear)
  }

  // Compliance filters are date comparisons the database can do; only the
  // presentation of the result is the client's business.
  const today = new Date().toISOString().slice(0, 10)
  if (query.compliance === 'expired') {
    request = request.or(
      [
        `insurance_expires_on.lt.${today}`,
        `inspection_expires_on.lt.${today}`,
        `registration_expires_on.lt.${today}`,
      ].join(','),
    )
  } else if (query.compliance === 'unrecorded') {
    request = request.or(
      [
        'insurance_expires_on.is.null',
        'inspection_expires_on.is.null',
        'registration_expires_on.is.null',
      ].join(','),
    )
  }

  const from = (page - 1) * pageSize
  const { data, error, count } = await request
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // A stable tiebreaker: without one, two vehicles sharing a sort value can
    // swap places between pages and appear twice or not at all.
    .order('vehicle_id', { ascending: true })
    .range(from, from + pageSize - 1)

  if (error) throw toAppError(error)

  const total = count ?? 0
  return {
    rows: data ?? [],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/**
 * The distinct makes in a fleet, for the filter menu.
 * Read from the vehicles table rather than assembled from the current page.
 */
export async function fetchVehicleMakes(organizationId: string): Promise<string[]> {
  const { data, error } = await getSupabaseClient()
    .from('vehicles')
    .select('make')
    .eq('organization_id', organizationId)
    .is('archived_at', null)
    .order('make')

  if (error) throw toAppError(error)

  return [...new Set((data ?? []).map((row) => row.make))]
}

export async function fetchFleetCounts(organizationId: string): Promise<FleetStatusCountsRow> {
  const { data, error } = await getSupabaseClient().rpc('fleet_status_counts', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)

  return (
    data?.[0] ?? {
      total: 0,
      available: 0,
      rented: 0,
      reserved: 0,
      maintenance: 0,
      unavailable: 0,
      archived: 0,
    }
  )
}

/**
 * A single vehicle, with its derived availability.
 *
 * An id from another agency and an id that does not exist produce the same
 * error. Distinguishing them would confirm to a caller that a given identifier
 * belongs to *somebody*, which is exactly the leak deep links must not have.
 */
export async function fetchVehicle(vehicleId: string): Promise<VehicleFleetEntry> {
  const { data, error } = await getSupabaseClient()
    .from('vehicle_fleet')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .maybeSingle()

  if (error) throw toAppError(error)
  if (!data) throw new AppError('notFound', 'This vehicle could not be found.')

  return data
}

/**
 * The columns a vehicle form owns.
 *
 * Stated explicitly rather than derived from the Insert type, so it is
 * assignable to both insert and update without dragging in provenance columns
 * (`created_by`, timestamps) that triggers freeze and clients must not send.
 */
interface VehicleWritePayload {
  make: string
  model: string
  model_year: number | null
  registration_plate: string
  vin: string | null
  color: string | null
  category: string | null
  fuel_type: FuelType | null
  transmission: TransmissionType | null
  seats: number | null
  odometer: number
  daily_rate_minor: number
  currency: string
  status: VehicleOperationalStatus
  insurance_expires_on: string | null
  inspection_expires_on: string | null
  registration_expires_on: string | null
  next_service_on: string | null
  notes: string | null
}

function toRow(values: VehicleFormValues): VehicleWritePayload {
  return {
    make: values.make,
    model: values.model,
    model_year: values.modelYear,
    registration_plate: values.registrationPlate,
    vin: values.vin,
    color: values.color,
    category: values.category,
    fuel_type: values.fuelType,
    transmission: values.transmission,
    seats: values.seats,
    odometer: values.odometer,
    daily_rate_minor: values.dailyRate,
    currency: values.currency,
    status: values.status,
    insurance_expires_on: values.insuranceExpiresOn,
    inspection_expires_on: values.inspectionExpiresOn,
    registration_expires_on: values.registrationExpiresOn,
    next_service_on: values.nextServiceOn,
    notes: values.notes,
  }
}

export async function createVehicle(
  organizationId: string,
  values: VehicleFormValues,
): Promise<Vehicle> {
  const { data, error } = await getSupabaseClient()
    .from('vehicles')
    .insert({ organization_id: organizationId, ...toRow(values) })
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateVehicle(
  vehicleId: string,
  values: VehicleFormValues,
): Promise<Vehicle> {
  const { data, error } = await getSupabaseClient()
    .from('vehicles')
    .update(toRow(values))
    .eq('id', vehicleId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

/** Operational status only — occupancy is never written. */
export async function setVehicleStatus(
  vehicleId: string,
  status: VehicleOperationalStatus,
): Promise<Vehicle> {
  const { data, error } = await getSupabaseClient()
    .from('vehicles')
    .update({ status })
    .eq('id', vehicleId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

/** Records a new odometer reading and stamps when it was taken. */
export async function updateOdometer(vehicleId: string, odometer: number): Promise<Vehicle> {
  const { data, error } = await getSupabaseClient()
    .from('vehicles')
    .update({ odometer, odometer_updated_at: new Date().toISOString() })
    .eq('id', vehicleId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function fetchVehicleUsage(vehicleId: string): Promise<VehicleUsageRow> {
  const { data, error } = await getSupabaseClient().rpc('vehicle_usage', {
    p_vehicle_id: vehicleId,
  })

  if (error) throw toAppError(error)
  const row = data?.[0]
  if (!row) throw new AppError('notFound', 'This vehicle could not be found.')

  return row
}

/**
 * Archiving retires a vehicle while leaving every contract, payment and expense
 * that references it intact. The database refuses to archive a vehicle that is
 * still committed to a contract.
 */
export async function archiveVehicle(vehicleId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('vehicles')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', vehicleId)

  if (error) throw toAppError(error)
}

export async function restoreVehicle(vehicleId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('vehicles')
    .update({ archived_at: null })
    .eq('id', vehicleId)

  if (error) throw toAppError(error)
}

/**
 * Permanent removal, allowed only for a vehicle nothing financial refers to.
 * The foreign keys are ON DELETE RESTRICT, so this fails rather than cascading
 * through an agency's books; `fetchVehicleUsage` lets the interface say so first.
 */
export async function deleteVehicle(vehicleId: string): Promise<void> {
  const { error } = await getSupabaseClient().from('vehicles').delete().eq('id', vehicleId)
  if (error) throw toAppError(error)
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

export async function fetchVehicleDocuments(vehicleId: string): Promise<VehicleDocument[]> {
  const { data, error } = await getSupabaseClient()
    .from('vehicle_documents')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('expires_on', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function createVehicleDocument(
  input: TablesInsert<'vehicle_documents'>,
): Promise<VehicleDocument> {
  const { data, error } = await getSupabaseClient()
    .from('vehicle_documents')
    .insert(input)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateVehicleDocument(
  documentId: string,
  changes: TablesUpdate<'vehicle_documents'>,
): Promise<VehicleDocument> {
  const { data, error } = await getSupabaseClient()
    .from('vehicle_documents')
    .update(changes)
    .eq('id', documentId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function deleteVehicleDocument(documentId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('vehicle_documents')
    .delete()
    .eq('id', documentId)

  if (error) throw toAppError(error)
}

// -----------------------------------------------------------------------------
// Photos
// -----------------------------------------------------------------------------

export async function fetchVehicleImages(vehicleId: string): Promise<VehicleImage[]> {
  const { data, error } = await getSupabaseClient()
    .from('vehicle_images')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('is_primary', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw toAppError(error)
  return data ?? []
}

/** Primary photos for a page of vehicles, in one request rather than N. */
export async function fetchPrimaryImages(vehicleIds: readonly string[]): Promise<VehicleImage[]> {
  if (vehicleIds.length === 0) return []

  const { data, error } = await getSupabaseClient()
    .from('vehicle_images')
    .select('*')
    .in('vehicle_id', [...vehicleIds])
    .eq('is_primary', true)

  if (error) throw toAppError(error)
  return data ?? []
}

export async function setPrimaryImage(imageId: string): Promise<void> {
  // The database trigger demotes whichever photo was primary before, so this
  // stays a single write and cannot leave a vehicle with two or none.
  const { error } = await getSupabaseClient()
    .from('vehicle_images')
    .update({ is_primary: true })
    .eq('id', imageId)

  if (error) throw toAppError(error)
}
