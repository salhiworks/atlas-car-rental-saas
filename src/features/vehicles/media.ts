import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type { VehicleImage } from '@/types/database'

import { deleteVehicleDocument, updateVehicleDocument } from './api'

/**
 * Vehicle media: photographs and document scans.
 *
 * Both buckets are private. Object keys are `<organization_id>/<vehicle_id>/…`
 * and the storage policies read that leading segment, so the key *is* the access
 * check — a predictable path from another agency resolves to a refusal, not a
 * file. Nothing is ever served from a permanent public URL; the interface asks
 * for a short-lived signed URL each session.
 */

export const PHOTO_BUCKET = 'vehicle-photos'
export const DOCUMENT_BUCKET = 'vehicle-documents'

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

/**
 * SVG is absent on purpose. It is an executable document format, and accepting
 * it would put script content on the storage origin.
 */
export const PHOTO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const

export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number]

const THUMBNAIL_MAX_EDGE = 480
const THUMBNAIL_QUALITY = 0.72
const SIGNED_URL_TTL_SECONDS = 3600

/**
 * Validates a file by its sniffed signature as well as its declared type.
 *
 * A browser's `File.type` comes from the file extension and is trivially wrong
 * or spoofed. The bucket's `allowed_mime_types` is the backstop; this check
 * exists so a mislabelled file is rejected with a useful message before it is
 * uploaded rather than after.
 */
export async function detectImageType(file: File): Promise<PhotoMimeType | null> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (header.length < 12) return null

  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte)

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'

  // RIFF....WEBP
  const isRiff = startsWith(0x52, 0x49, 0x46, 0x46)
  const isWebp =
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
  if (isRiff && isWebp) return 'image/webp'

  return null
}

export interface PreparedImage {
  readonly file: File
  readonly contentType: PhotoMimeType
  readonly width: number
  readonly height: number
  readonly thumbnail: Blob | null
}

/**
 * Reads a chosen photograph and produces a small copy to display in lists.
 *
 * Supabase's server-side image transformation is a paid feature, so the small
 * copy is generated here and stored alongside the original. A fleet list then
 * costs a few kilobytes per row instead of several megabytes.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > PHOTO_MAX_BYTES) {
    throw new AppError('validation', 'Choose an image smaller than 8 MB.')
  }

  const contentType = await detectImageType(file)
  if (!contentType) {
    throw new AppError(
      'validation',
      'That file is not a PNG, JPEG or WebP image. Convert it and try again.',
    )
  }

  const bitmap = await loadBitmap(file)
  try {
    const thumbnail = await renderThumbnail(bitmap)
    return {
      file,
      contentType,
      width: bitmap.width,
      height: bitmap.height,
      thumbnail,
    }
  } finally {
    bitmap.close?.()
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new AppError('validation', 'That image could not be read. Try a different file.')
  }
}

async function renderThumbnail(bitmap: ImageBitmap): Promise<Blob | null> {
  const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) return null

  context.drawImage(bitmap, 0, 0, width, height)

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', THUMBNAIL_QUALITY)
  })
}

/** Object keys carry the tenant and the vehicle, because the policies read them. */
function mediaKey(
  organizationId: string,
  vehicleId: string,
  extension: string,
  prefix = '',
): string {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${organizationId}/${vehicleId}/${prefix}${unique}.${extension}`
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'application/pdf':
      return 'pdf'
    default:
      return 'jpg'
  }
}

export interface UploadPhotoInput {
  organizationId: string
  vehicleId: string
  file: File
  caption?: string | null
}

export async function uploadVehiclePhoto(input: UploadPhotoInput): Promise<VehicleImage> {
  const supabase = getSupabaseClient()
  const prepared = await prepareImage(input.file)

  const storagePath = mediaKey(
    input.organizationId,
    input.vehicleId,
    extensionFor(prepared.contentType),
  )

  const upload = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, prepared.file, { contentType: prepared.contentType, upsert: false })

  if (upload.error) throw toAppError(upload.error)

  let thumbnailPath: string | null = null
  if (prepared.thumbnail) {
    const path = mediaKey(input.organizationId, input.vehicleId, 'jpg', 'thumb-')
    const thumbUpload = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, prepared.thumbnail, { contentType: 'image/jpeg', upsert: false })

    // A missing thumbnail costs bandwidth, not correctness — the list falls back
    // to the full image. Failing the whole upload over it would be worse.
    if (!thumbUpload.error) thumbnailPath = path
  }

  const { data, error } = await supabase
    .from('vehicle_images')
    .insert({
      organization_id: input.organizationId,
      vehicle_id: input.vehicleId,
      storage_path: storagePath,
      thumbnail_path: thumbnailPath,
      content_type: prepared.contentType,
      byte_size: prepared.file.size,
      width: prepared.width,
      height: prepared.height,
      caption: input.caption ?? null,
    })
    .select('*')
    .single()

  if (error) {
    // Do not leave an orphaned object behind if the metadata insert is refused.
    await supabase.storage
      .from(PHOTO_BUCKET)
      .remove(thumbnailPath ? [storagePath, thumbnailPath] : [storagePath])
    throw toAppError(error)
  }

  return data
}

export async function deleteVehiclePhoto(image: VehicleImage): Promise<void> {
  const supabase = getSupabaseClient()

  const { error } = await supabase.from('vehicle_images').delete().eq('id', image.id)
  if (error) throw toAppError(error)

  const paths = image.thumbnail_path
    ? [image.storage_path, image.thumbnail_path]
    : [image.storage_path]
  // Row first, file second: an orphaned file is invisible and cheap, whereas a
  // row pointing at a deleted file renders as a broken image.
  await supabase.storage.from(PHOTO_BUCKET).remove(paths)
}

export interface UploadDocumentFileInput {
  organizationId: string
  vehicleId: string
  documentId: string
  file: File
}

export async function uploadVehicleDocumentFile(input: UploadDocumentFileInput): Promise<string> {
  if (input.file.size > DOCUMENT_MAX_BYTES) {
    throw new AppError('validation', 'Choose a file smaller than 10 MB.')
  }

  const declared = input.file.type
  const isPdf = declared === 'application/pdf'
  const detected = isPdf ? null : await detectImageType(input.file)

  if (!isPdf && !detected) {
    throw new AppError('validation', 'Attach a PDF, PNG, JPEG or WebP file.')
  }

  const contentType = isPdf ? 'application/pdf' : (detected as string)
  const path = mediaKey(input.organizationId, input.vehicleId, extensionFor(contentType), 'doc-')

  const { error } = await getSupabaseClient()
    .storage.from(DOCUMENT_BUCKET)
    .upload(path, input.file, { contentType, upsert: false })

  if (error) throw toAppError(error)

  await updateVehicleDocument(input.documentId, { file_path: path })
  return path
}

export async function removeVehicleDocument(
  documentId: string,
  filePath: string | null,
): Promise<void> {
  await deleteVehicleDocument(documentId)
  if (filePath) {
    await getSupabaseClient().storage.from(DOCUMENT_BUCKET).remove([filePath])
  }
}

/**
 * Signs a batch of object keys in one request.
 *
 * Keys that the caller may not read come back without a URL rather than failing
 * the batch, so one inaccessible file cannot blank an entire fleet list.
 */
export async function signMediaUrls(
  bucket: string,
  paths: readonly string[],
  expiresInSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((path) => path.length > 0))]
  if (unique.length === 0) return new Map()

  const { data, error } = await getSupabaseClient()
    .storage.from(bucket)
    .createSignedUrls(unique, expiresInSeconds)

  if (error) throw toAppError(error)

  const urls = new Map<string, string>()
  for (const entry of data ?? []) {
    if (entry.signedUrl && entry.path) urls.set(entry.path, entry.signedUrl)
  }
  return urls
}

export async function signMediaUrl(
  bucket: string,
  path: string,
  expiresInSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .storage.from(bucket)
    .createSignedUrl(path, expiresInSeconds)

  if (error) throw toAppError(error)
  return data.signedUrl
}

export { SIGNED_URL_TTL_SECONDS }
