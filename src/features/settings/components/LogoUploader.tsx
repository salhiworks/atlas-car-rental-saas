import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImageUp, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button, useToast } from '@/components/ui'
import {
  LOGO_ACCEPTED_TYPES,
  removeOrganizationLogo,
  updateOrganization,
  uploadOrganizationLogo,
} from '@/features/workspace/api'
import { useOrganizationLogo } from '@/features/workspace/useOrganizationLogo'
import { useWorkspace } from '@/features/workspace/workspace-context'
import { toErrorMessage } from '@/lib/supabase/errors'
import { getMonogram } from '@/lib/utils/monogram'
import type { Organization } from '@/types/database'

export interface LogoUploaderProps {
  organization: Organization
  canEdit: boolean
}

/**
 * Agency logo upload.
 *
 * The file goes into a private bucket under `<organization_id>/…`, which is the
 * key the storage policies read to decide access — so the object is readable by
 * this agency's members and writable by its administrators, and by nobody else.
 * The interface reads it back through a short-lived signed URL rather than a
 * permanent public link.
 */
export function LogoUploader({ organization, canEdit }: LogoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const { refresh } = useWorkspace()
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)

  const { data: logoUrl } = useOrganizationLogo(organization.id, organization.logo_path)

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const path = await uploadOrganizationLogo(organization.id, file)
      await updateOrganization(organization.id, { logo_path: path })

      // Best effort: a leftover object is harmless, and failing the whole
      // operation because cleanup failed would be worse.
      if (organization.logo_path) {
        try {
          await removeOrganizationLogo(organization.logo_path)
        } catch {
          /* ignore */
        }
      }
    },
    onSuccess: async () => {
      setError(null)
      await refresh()
      await queryClient.invalidateQueries({ queryKey: ['organization', organization.id, 'logo'] })
      toast.success('Logo updated')
    },
    onError: (cause: unknown) => {
      setError(toErrorMessage(cause))
    },
  })

  const removeMutation = useMutation({
    mutationFn: async () => {
      await updateOrganization(organization.id, { logo_path: null })
      if (organization.logo_path) {
        try {
          await removeOrganizationLogo(organization.logo_path)
        } catch {
          /* ignore */
        }
      }
    },
    onSuccess: async () => {
      setError(null)
      await refresh()
      toast.success('Logo removed')
    },
    onError: (cause: unknown) => {
      setError(toErrorMessage(cause))
    },
  })

  const isBusy = uploadMutation.isPending || removeMutation.isPending

  return (
    <div className="grid gap-6 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-start">
      {/* The mark on its own ground, at the size it is actually seen. A 64px
          thumbnail wedged between two large forms read as an afterthought. */}
      <div className="border-line bg-surface-inset flex flex-col items-center gap-3 rounded-lg border px-6 py-7">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={`${organization.name} logo`}
            className="border-line bg-surface size-20 rounded-lg border object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="bg-brand-700 text-ink-inverse flex size-20 items-center justify-center rounded-lg text-2xl font-semibold tracking-wide"
          >
            {getMonogram(organization.name)}
          </span>
        )}

        <p className="eyebrow">{organization.logo_path ? 'Current logo' : 'No logo yet'}</p>
      </div>

      <div className="min-w-0 space-y-4">
        <div className="space-y-1.5">
          <p className="text-ink-muted text-[0.8125rem] leading-5">
            {organization.logo_path
              ? 'Used in the sidebar, and at the head of every contract and receipt you issue.'
              : 'Until one is uploaded, the agency’s initials stand in for it across the workspace and on the documents you issue.'}
          </p>
          <ul className="text-ink-subtle space-y-0.5 text-[0.75rem] leading-4">
            <li>PNG, JPEG or WebP, up to 2 MB.</li>
            <li>A square image around 512×512 reproduces best.</li>
          </ul>
        </div>

        {error ? <p className="text-critical-600 text-[0.75rem] font-medium">{error}</p> : null}

        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <input
              ref={inputRef}
              type="file"
              accept={LOGO_ACCEPTED_TYPES.join(',')}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) uploadMutation.mutate(file)
                // Reset so choosing the same file twice still fires a change.
                event.target.value = ''
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<ImageUp />}
              isLoading={uploadMutation.isPending}
              onClick={() => inputRef.current?.click()}
              disabled={isBusy}
            >
              {organization.logo_path ? 'Replace logo' : 'Upload logo'}
            </Button>

            {organization.logo_path ? (
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<Trash2 />}
                isLoading={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
                disabled={isBusy}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
