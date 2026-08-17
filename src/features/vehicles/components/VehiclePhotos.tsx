import { ImagePlus, Images, Star, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  Alert,
  Button,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Skeleton,
} from '@/components/ui'
import { useToast } from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { VehicleImage } from '@/types/database'

import { PHOTO_MIME_TYPES } from '../media'
import {
  useDeleteVehiclePhoto,
  useSetPrimaryPhoto,
  useUploadVehiclePhoto,
  useVehicleImages,
  useVehiclePhotoUrls,
} from '../queries'

export interface VehiclePhotosProps {
  vehicleId: string
  canEdit: boolean
}

/**
 * Photographs of a vehicle.
 *
 * Files go to a private bucket keyed by agency and vehicle, and are displayed
 * through short-lived signed URLs. The first upload becomes the primary photo
 * automatically — the database does that, so a vehicle with photos always has
 * one leading the list.
 */
export function VehiclePhotos({ vehicleId, canEdit }: VehiclePhotosProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<VehicleImage | null>(null)

  const imagesQuery = useVehicleImages(vehicleId)
  const images = imagesQuery.data ?? []
  const urls = useVehiclePhotoUrls(images)

  const upload = useUploadVehiclePhoto(vehicleId)
  const remove = useDeleteVehiclePhoto(vehicleId)
  const setPrimary = useSetPrimaryPhoto(vehicleId)

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError(null)

    // Uploaded one at a time so a single rejected file reports its own reason
    // rather than failing an opaque batch.
    const queue = Array.from(files)
    void queue
      .reduce<Promise<void>>(
        (chain, file) =>
          chain.then(async () => {
            await upload.mutateAsync(file)
          }),
        Promise.resolve(),
      )
      .then(() => {
        toast.success(queue.length === 1 ? 'Photo added' : `${queue.length} photos added`)
      })
      .catch((cause: unknown) => {
        setError(toErrorMessage(cause))
      })
  }

  return (
    <>
      <CardHeader
        title="Photos"
        description="Shown on the fleet list and when choosing a vehicle for a contract."
        actions={
          canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<ImagePlus />}
              isLoading={upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              Add photos
            </Button>
          ) : null
        }
      />

      <CardBody>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={PHOTO_MIME_TYPES.join(',')}
          className="sr-only"
          onChange={(event) => {
            handleFiles(event.target.files)
            event.target.value = ''
          }}
        />

        {error ? (
          <Alert tone="critical" className="mb-4">
            {error}
          </Alert>
        ) : null}

        {imagesQuery.isPending ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="aspect-[4/3] w-full" />
            ))}
          </div>
        ) : images.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Images}
            title="No photos yet"
            description={
              canEdit
                ? 'Add photographs of this vehicle so staff can identify it at a glance.'
                : 'No photographs have been added for this vehicle.'
            }
            action={
              canEdit ? (
                <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
                  Add photos
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((image) => {
              const url = urls.get(image.id)

              return (
                <li key={image.id} className="group relative">
                  <div className="border-line bg-surface-inset aspect-[4/3] overflow-hidden rounded-md border">
                    {url ? (
                      <img
                        src={url}
                        alt={image.caption ?? 'Vehicle photograph'}
                        loading="lazy"
                        decoding="async"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Skeleton className="size-full" />
                    )}
                  </div>

                  {image.is_primary ? (
                    <span className="bg-brand-700 text-ink-inverse absolute start-1.5 top-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.625rem] font-semibold">
                      <Star className="size-2.5 fill-current" aria-hidden="true" />
                      Primary
                    </span>
                  ) : null}

                  {canEdit ? (
                    <div
                      className={cn(
                        'absolute end-1.5 top-1.5 flex gap-1',
                        // Always reachable by keyboard; revealed on hover for the mouse.
                        'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
                      )}
                    >
                      {!image.is_primary ? (
                        <button
                          type="button"
                          onClick={() => {
                            setPrimary.mutate(image.id, {
                              onSuccess: () => toast.success('Primary photo updated'),
                              onError: (cause) => setError(toErrorMessage(cause)),
                            })
                          }}
                          className="bg-surface/90 text-ink-muted hover:text-ink rounded p-1.5 shadow-raised backdrop-blur"
                          aria-label="Make this the primary photo"
                        >
                          <Star className="size-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setPendingDelete(image)}
                        className="bg-surface/90 text-critical-600 rounded p-1.5 shadow-raised backdrop-blur"
                        aria-label="Delete this photo"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this photo?"
        description="The image file is removed from storage. This cannot be undone."
        confirmLabel="Delete photo"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(pendingDelete, {
            onSuccess: () => {
              setPendingDelete(null)
              toast.success('Photo deleted')
            },
            onError: (cause) => {
              setPendingDelete(null)
              setError(toErrorMessage(cause))
            },
          })
        }}
      />
    </>
  )
}
