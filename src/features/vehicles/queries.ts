import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  keepPreviousData,
} from '@tanstack/react-query'
import { useMemo } from 'react'

import { useOrganization } from '@/features/workspace/workspace-context'
import type { VehicleImage } from '@/types/database'

import {
  type VehicleQuery,
  archiveVehicle,
  createVehicle,
  deleteVehicle,
  fetchFleetCounts,
  fetchPrimaryImages,
  fetchVehicle,
  fetchVehicleDocuments,
  fetchVehicleImages,
  fetchVehicleMakes,
  fetchVehicleUsage,
  fetchVehicles,
  restoreVehicle,
  setPrimaryImage,
  setVehicleStatus,
  updateOdometer,
  updateVehicle,
} from './api'
import { PHOTO_BUCKET, signMediaUrls, uploadVehiclePhoto, deleteVehiclePhoto } from './media'
import type { VehicleFormValues } from './schemas'

/**
 * Query keys for the fleet.
 *
 * Every key starts with the organization id, so switching agency cannot serve a
 * cached list from the previous one, and the workspace switcher's blanket
 * `['organization']` invalidation reaches all of them.
 */
export const vehicleKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'vehicles'] as const,
  list: (organizationId: string, query: Omit<VehicleQuery, 'organizationId'>) =>
    ['organization', organizationId, 'vehicles', 'list', query] as const,
  counts: (organizationId: string) =>
    ['organization', organizationId, 'vehicles', 'counts'] as const,
  makes: (organizationId: string) => ['organization', organizationId, 'vehicles', 'makes'] as const,
  detail: (organizationId: string, vehicleId: string) =>
    ['organization', organizationId, 'vehicles', 'detail', vehicleId] as const,
  usage: (organizationId: string, vehicleId: string) =>
    ['organization', organizationId, 'vehicles', 'usage', vehicleId] as const,
  images: (organizationId: string, vehicleId: string) =>
    ['organization', organizationId, 'vehicles', 'images', vehicleId] as const,
  documents: (organizationId: string, vehicleId: string) =>
    ['organization', organizationId, 'vehicles', 'documents', vehicleId] as const,
  thumbnails: (organizationId: string, paths: readonly string[]) =>
    ['organization', organizationId, 'vehicles', 'thumbnails', paths] as const,
  photoUrls: (organizationId: string, paths: readonly string[]) =>
    ['organization', organizationId, 'vehicles', 'photo-urls', paths] as const,
}

/**
 * Anything that changed a vehicle can change the list, the counts and the
 * filter menu. Invalidating the whole `vehicles` subtree is one line and cannot
 * miss a key; the alternative is a list of individual invalidations that goes
 * stale the first time somebody adds a query.
 */
async function invalidateFleet(client: QueryClient, organizationId: string): Promise<void> {
  await client.invalidateQueries({ queryKey: vehicleKeys.all(organizationId) })
}

export function useVehicleList(query: Omit<VehicleQuery, 'organizationId'>) {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.list(organization.id, query),
    queryFn: () => fetchVehicles({ organizationId: organization.id, ...query }),
    // Keeps the current page on screen while the next one loads, so typing in
    // the search box does not blank the table on every keystroke.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}

export function useFleetCounts() {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.counts(organization.id),
    queryFn: () => fetchFleetCounts(organization.id),
    staleTime: 30_000,
  })
}

export function useVehicleMakes() {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.makes(organization.id),
    queryFn: () => fetchVehicleMakes(organization.id),
    staleTime: 5 * 60_000,
  })
}

export function useVehicle(vehicleId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.detail(organization.id, vehicleId ?? 'none'),
    queryFn: () => fetchVehicle(vehicleId!),
    enabled: Boolean(vehicleId),
    retry: false,
  })
}

export function useVehicleUsage(vehicleId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.usage(organization.id, vehicleId ?? 'none'),
    queryFn: () => fetchVehicleUsage(vehicleId!),
    enabled: Boolean(vehicleId),
    retry: false,
  })
}

export function useVehicleImages(vehicleId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.images(organization.id, vehicleId ?? 'none'),
    queryFn: () => fetchVehicleImages(vehicleId!),
    enabled: Boolean(vehicleId),
  })
}

export function useVehicleDocuments(vehicleId: string | undefined) {
  const organization = useOrganization()

  return useQuery({
    queryKey: vehicleKeys.documents(organization.id, vehicleId ?? 'none'),
    queryFn: () => fetchVehicleDocuments(vehicleId!),
    enabled: Boolean(vehicleId),
  })
}

/**
 * Signed thumbnail URLs for a page of vehicles.
 *
 * One request signs every key on the page. The full-size photo is never fetched
 * for a list row: `thumbnail_path` is a small copy made at upload time, and the
 * original is only used when no thumbnail exists.
 */
export function useVehicleThumbnails(vehicleIds: readonly string[]) {
  const organization = useOrganization()

  const imagesQuery = useQuery({
    queryKey: [...vehicleKeys.all(organization.id), 'primary-images', vehicleIds] as const,
    queryFn: () => fetchPrimaryImages(vehicleIds),
    enabled: vehicleIds.length > 0,
    staleTime: 60_000,
  })

  const images = useMemo(() => imagesQuery.data ?? [], [imagesQuery.data])
  const paths = useMemo(
    () => images.map((image) => image.thumbnail_path ?? image.storage_path),
    [images],
  )

  const urlsQuery = useQuery({
    queryKey: vehicleKeys.thumbnails(organization.id, paths),
    queryFn: () => signMediaUrls(PHOTO_BUCKET, paths),
    enabled: paths.length > 0,
    // Comfortably inside the signature's lifetime so a rendered URL never lapses.
    staleTime: 45 * 60_000,
  })

  return useMemo(() => {
    const byVehicle = new Map<string, string>()
    const urls = urlsQuery.data
    if (urls) {
      for (const image of images) {
        const url = urls.get(image.thumbnail_path ?? image.storage_path)
        if (url) byVehicle.set(image.vehicle_id, url)
      }
    }
    return byVehicle
  }, [images, urlsQuery.data])
}

/** Signed URLs for every photo of one vehicle, keyed by image id. */
export function useVehiclePhotoUrls(images: readonly VehicleImage[]) {
  const organization = useOrganization()
  const paths = useMemo(() => images.map((image) => image.storage_path), [images])

  const query = useQuery({
    queryKey: vehicleKeys.photoUrls(organization.id, paths),
    queryFn: () => signMediaUrls(PHOTO_BUCKET, paths),
    enabled: paths.length > 0,
    staleTime: 45 * 60_000,
  })

  return useMemo(() => {
    const byImage = new Map<string, string>()
    if (query.data) {
      for (const image of images) {
        const url = query.data.get(image.storage_path)
        if (url) byImage.set(image.id, url)
      }
    }
    return byImage
  }, [images, query.data])
}

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

export function useCreateVehicle() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: VehicleFormValues) => createVehicle(organization.id, values),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useUpdateVehicle(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (values: VehicleFormValues) => updateVehicle(vehicleId, values),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

/**
 * Status changes are applied optimistically.
 *
 * This is the one fleet mutation where it is clearly safe: a single enum on a
 * row the user is looking at, with no derived totals that would have to be
 * guessed. Anything touching money or occupancy waits for the server.
 */
export function useSetVehicleStatus(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()
  const key = vehicleKeys.detail(organization.id, vehicleId)

  return useMutation({
    mutationFn: (status: 'available' | 'maintenance' | 'unavailable') =>
      setVehicleStatus(vehicleId, status),
    onMutate: async (status) => {
      await client.cancelQueries({ queryKey: key })
      const previous = client.getQueryData(key)

      client.setQueryData(key, (current: unknown) => {
        if (!current || typeof current !== 'object') return current
        return { ...current, operational_status: status }
      })

      return { previous }
    },
    onError: (_error, _status, context) => {
      if (context?.previous !== undefined) client.setQueryData(key, context.previous)
    },
    // Effective status also depends on contracts, so the server's answer always
    // replaces the guess rather than being assumed correct.
    onSettled: () => invalidateFleet(client, organization.id),
  })
}

export function useUpdateOdometer(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (odometer: number) => updateOdometer(vehicleId, odometer),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useArchiveVehicle(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => archiveVehicle(vehicleId),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useRestoreVehicle(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => restoreVehicle(vehicleId),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useDeleteVehicle(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => deleteVehicle(vehicleId),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useUploadVehiclePhoto(vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (file: File) =>
      uploadVehiclePhoto({ organizationId: organization.id, vehicleId, file }),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useDeleteVehiclePhoto(_vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (image: VehicleImage) => deleteVehiclePhoto(image),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}

export function useSetPrimaryPhoto(_vehicleId: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (imageId: string) => setPrimaryImage(imageId),
    onSuccess: () => invalidateFleet(client, organization.id),
  })
}
