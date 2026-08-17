import { Camera, ImageOff, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button, Card, CardBody, CardHeader, useToast } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { RentalConditionPhase, RentalConditionPhoto } from '@/types/database'

import {
  useConditionPhotoUrls,
  useConditionPhotos,
  useDeleteConditionPhoto,
  useUploadConditionPhoto,
} from '../queries'

export interface ConditionPhotosProps {
  rentalId: string
  canUpload: boolean
  canDelete: boolean
  locale: string
  timeZone: string
}

const PHASE_LABELS: Record<RentalConditionPhase, string> = {
  pickup: 'At hand-over',
  return: 'At return',
}

/**
 * Photographs of how the vehicle looked at each end of the hire.
 *
 * The evidence a damage dispute turns on. Kept apart from the fleet's
 * photographs on purpose: a marketing shot and a picture of a scratch taken at
 * 08:00 on a particular contract are different things, and letting one be
 * mistaken for the other would be worse than having neither.
 *
 * The bucket is private and every image is fetched through a short-lived signed
 * URL, so a photograph of somebody's damaged car is never on a public address.
 */
export function ConditionPhotos({
  rentalId,
  canUpload,
  canDelete,
  locale,
  timeZone,
}: ConditionPhotosProps) {
  const toast = useToast()
  const photosQuery = useConditionPhotos(rentalId)
  const upload = useUploadConditionPhoto(rentalId)
  const remove = useDeleteConditionPhoto(rentalId)

  const photos = photosQuery.data ?? []
  const urls = useConditionPhotoUrls(photos)

  const [phase, setPhase] = useState<RentalConditionPhase>('pickup')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const choose = (next: RentalConditionPhase) => {
    setPhase(next)
    inputRef.current?.click()
  }

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      try {
        await upload.mutateAsync({ file, phase, caption: null })
      } catch (error) {
        toast.error('Could not attach that photograph', toErrorMessage(error))
        break
      }
    }

    if (inputRef.current) inputRef.current.value = ''
  }

  const grouped: Record<RentalConditionPhase, RentalConditionPhoto[]> = {
    pickup: photos.filter((photo) => photo.phase === 'pickup'),
    return: photos.filter((photo) => photo.phase === 'return'),
  }

  return (
    <Card>
      <CardHeader
        title="Condition photographs"
        description="What the vehicle looked like when it left, and when it came back."
        actions={
          canUpload ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Camera />}
                onClick={() => choose('pickup')}
                isLoading={upload.isPending && phase === 'pickup'}
              >
                Hand-over
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Camera />}
                onClick={() => choose('return')}
                isLoading={upload.isPending && phase === 'return'}
              >
                Return
              </Button>
            </div>
          ) : null
        }
      />

      <CardBody className="space-y-5">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="sr-only"
          onChange={(event) => void onFiles(event.target.files)}
        />

        {(['pickup', 'return'] as const).map((group) => (
          <section key={group} className="space-y-2">
            <h3 className="eyebrow">{PHASE_LABELS[group]}</h3>

            {grouped[group].length === 0 ? (
              <p className="text-ink-subtle border-line flex items-center gap-2 rounded-md border border-dashed px-3 py-4 text-[0.8125rem]">
                <ImageOff className="size-4 shrink-0" aria-hidden="true" />
                No photographs recorded.
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {grouped[group].map((photo) => {
                  const url = urls.get(photo.id)

                  return (
                    <li key={photo.id} className="group relative">
                      <div className="bg-surface-inset border-line aspect-[4/3] overflow-hidden rounded-md border">
                        {url ? (
                          <img
                            src={url}
                            alt={
                              photo.caption ??
                              `${PHASE_LABELS[group]} — ${formatDateTime(new Date(photo.uploaded_at), { locale, timeZone })}`
                            }
                            className="size-full object-cover"
                            loading="lazy"
                          />
                        ) : null}
                      </div>

                      {canDelete ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="absolute end-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label="Remove this photograph"
                          onClick={() => void remove.mutateAsync(photo)}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ))}
      </CardBody>
    </Card>
  )
}
