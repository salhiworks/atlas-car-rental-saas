import { detectImageType, signMediaUrl, signMediaUrls } from '@/features/vehicles/media'
import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type { RentalConditionPhoto } from '@/types/database'

/**
 * Contract documents, signatures and condition photographs.
 *
 * The bucket is private. Object keys are `<organization_id>/<rental_id>/…` and
 * the storage policies read that leading segment, so the key *is* the access
 * check: a guessed path from another agency resolves to a refusal, not a file.
 * Nothing is ever served from a permanent public URL — the interface asks for a
 * short-lived signed URL when it needs one.
 */

export const RENTAL_BUCKET = 'rental-documents'

export const CONTRACT_MAX_BYTES = 10 * 1024 * 1024
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024

/**
 * SVG is absent on purpose. It is an executable document format, and accepting
 * it would put script content on the storage origin.
 */
export const PHOTO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

function randomSegment(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

export function contractKey(organizationId: string, rentalId: string, version: number): string {
  return `${organizationId}/${rentalId}/contract-v${version}-${randomSegment()}.pdf`
}

export function signatureKey(organizationId: string, rentalId: string): string {
  return `${organizationId}/${rentalId}/signature-${randomSegment()}.png`
}

export function conditionPhotoKey(
  organizationId: string,
  rentalId: string,
  phase: 'pickup' | 'return',
  contentType: string,
): string {
  const extension =
    contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
  return `${organizationId}/${rentalId}/${phase}-${randomSegment()}.${extension}`
}

// -----------------------------------------------------------------------------
// Contract PDFs
// -----------------------------------------------------------------------------

/**
 * A SHA-256 of the bytes, stored with the contract.
 *
 * It is not a signature and does not pretend to be one. It is a way to tell,
 * later, whether the file that comes back out of storage is the file that went
 * in — a cheap integrity check on a document the agency may need to rely on.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface StoreContractPdfInput {
  readonly organizationId: string
  readonly rentalId: string
  readonly contractId: string
  readonly version: number
  readonly bytes: Blob
}

export async function storeContractPdf(input: StoreContractPdfInput): Promise<string> {
  if (input.bytes.size > CONTRACT_MAX_BYTES) {
    throw new AppError('validation', 'That contract is too large to store. Shorten your terms.')
  }

  const supabase = getSupabaseClient()
  const path = contractKey(input.organizationId, input.rentalId, input.version)

  const { error } = await supabase.storage
    .from(RENTAL_BUCKET)
    .upload(path, input.bytes, { contentType: 'application/pdf', upsert: false })

  if (error) throw toAppError(error)

  const checksum = await sha256Hex(await input.bytes.arrayBuffer())

  const { error: metadataError } = await supabase
    .from('rental_contracts')
    .update({
      pdf_path: path,
      pdf_generated_at: new Date().toISOString(),
      pdf_byte_size: input.bytes.size,
      pdf_sha256: checksum,
    })
    .eq('id', input.contractId)

  if (metadataError) {
    // Do not leave an orphaned object behind if the metadata write is refused.
    await supabase.storage.from(RENTAL_BUCKET).remove([path])
    throw toAppError(metadataError)
  }

  return path
}

// -----------------------------------------------------------------------------
// Signatures
// -----------------------------------------------------------------------------

export async function storeSignature(
  organizationId: string,
  rentalId: string,
  png: Blob,
): Promise<string> {
  const path = signatureKey(organizationId, rentalId)
  const { error } = await getSupabaseClient()
    .storage.from(RENTAL_BUCKET)
    .upload(path, png, { contentType: 'image/png', upsert: false })

  if (error) throw toAppError(error)
  return path
}

// -----------------------------------------------------------------------------
// Condition photographs
// -----------------------------------------------------------------------------

export interface UploadConditionPhotoInput {
  readonly organizationId: string
  readonly rentalId: string
  readonly phase: 'pickup' | 'return'
  readonly file: File
  readonly caption: string | null
}

export async function uploadConditionPhoto(
  input: UploadConditionPhotoInput,
): Promise<RentalConditionPhoto> {
  if (input.file.size > PHOTO_MAX_BYTES) {
    throw new AppError('validation', 'Choose a photograph smaller than 8 MB.')
  }

  // The declared type comes from the file extension and is trivially wrong. The
  // bytes are what decide.
  const contentType = await detectImageType(input.file)
  if (!contentType) {
    throw new AppError('validation', 'Attach a PNG, JPEG or WebP photograph.')
  }

  const supabase = getSupabaseClient()
  const path = conditionPhotoKey(input.organizationId, input.rentalId, input.phase, contentType)

  const { error } = await supabase.storage
    .from(RENTAL_BUCKET)
    .upload(path, input.file, { contentType, upsert: false })

  if (error) throw toAppError(error)

  const { data, error: metadataError } = await supabase
    .from('rental_condition_photos')
    .insert({
      organization_id: input.organizationId,
      rental_id: input.rentalId,
      phase: input.phase,
      storage_path: path,
      content_type: contentType,
      byte_size: input.file.size,
      caption: input.caption,
    })
    .select()
    .single()

  if (metadataError) {
    await supabase.storage.from(RENTAL_BUCKET).remove([path])
    throw toAppError(metadataError)
  }

  return data
}

export async function deleteConditionPhoto(photo: RentalConditionPhoto): Promise<void> {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from('rental_condition_photos').delete().eq('id', photo.id)
  if (error) throw toAppError(error)

  // Row first, file second: an orphaned file is invisible and cheap, whereas a
  // row pointing at a deleted file renders as a broken image.
  await supabase.storage.from(RENTAL_BUCKET).remove([photo.storage_path])
}

export function signRentalUrl(path: string, expiresInSeconds?: number): Promise<string> {
  return signMediaUrl(RENTAL_BUCKET, path, expiresInSeconds)
}

export function signRentalUrls(
  paths: readonly string[],
  expiresInSeconds?: number,
): Promise<Map<string, string>> {
  return signMediaUrls(RENTAL_BUCKET, paths, expiresInSeconds)
}
