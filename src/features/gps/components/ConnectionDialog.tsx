import { CheckCircle2, ShieldCheck } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  useToast,
} from '@/components/ui'
import { useOrganization } from '@/features/workspace/workspace-context'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { GpsProviderConnection } from '@/types/database'

import type { ProviderAccountSummary } from '../api'
import { useSaveConnection, useTestConnection } from '../queries'
import { getAppName } from '@/lib/config/env'

/**
 * Linking a tracking provider, and replacing a credential on one already linked.
 *
 * WHAT HAPPENS TO WHAT IS TYPED HERE. The token goes into one request to a
 * server function and is never held anywhere else: not in a query cache, not in
 * a form library's persisted state, not in local storage, not in the URL, and
 * not in the error message if the request fails. The server puts it in Supabase
 * Vault, which is encrypted at rest and readable only by the service role — the
 * browser's own client cannot select from it and neither can an owner. What
 * comes back to this dialog is a display name, a host and a count.
 *
 * Once saved, the field is cleared and the token is never shown again, because
 * there is no code path that could retrieve it. A connection whose token is lost
 * is replaced, not recovered — which is the correct behaviour for a secret and
 * the reason the button says "Replace credential" rather than "Edit".
 *
 * Testing before saving is the whole point of the flow. An agency that pastes a
 * token, saves, and finds out three days later that it was for the wrong Wialon
 * region has been failed by the product.
 */

/**
 * Wialon's documented hosting regions, plus Wialon Local.
 *
 * A wrong host is the most common setup failure and the least obvious one: the
 * token is valid, the account exists, and the API answers "invalid credentials"
 * because it is a different installation. Offering the documented hosts by name
 * turns that into a choice rather than a guess.
 */
const WIALON_HOSTS = [
  { value: 'https://hst-api.wialon.com', label: 'Wialon Hosting (hst-api.wialon.com)' },
  { value: 'https://hst-api.wialon.us', label: 'Wialon Hosting — North America (.us)' },
  { value: 'https://hst-api.wialon.eu', label: 'Wialon Hosting — Europe (.eu)' },
  { value: 'https://hst-api.wialon.org', label: 'Wialon Hosting — alternative (.org)' },
  { value: 'custom', label: 'Wialon Local — my own server' },
] as const

export interface ConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when replacing the credential on an existing connection. */
  connection?: GpsProviderConnection | null
}

export function ConnectionDialog({ open, onOpenChange, connection }: ConnectionDialogProps) {
  const organization = useOrganization()
  const toast = useToast()
  const rotating = Boolean(connection)

  const [label, setLabel] = useState(connection?.label ?? 'Wialon')
  const [host, setHost] = useState<string>(() => {
    const current = connection?.base_url
    if (!current) return WIALON_HOSTS[0].value
    return WIALON_HOSTS.some((entry) => entry.value === current) ? current : 'custom'
  })
  const [customUrl, setCustomUrl] = useState(
    connection && !WIALON_HOSTS.some((entry) => entry.value === connection.base_url)
      ? connection.base_url
      : '',
  )
  const [token, setToken] = useState('')
  const [verified, setVerified] = useState<ProviderAccountSummary | null>(null)

  const test = useTestConnection()
  const save = useSaveConnection()

  const baseUrl = host === 'custom' ? customUrl.trim() : host

  function reset() {
    setToken('')
    setVerified(null)
    test.reset()
    save.reset()
  }

  async function onTest() {
    setVerified(null)
    try {
      const account = await test.mutateAsync({
        organizationId: organization.id,
        baseUrl,
        ...(token.trim() === '' ? {} : { token: token.trim() }),
        ...(connection ? { connectionId: connection.id } : {}),
      })
      setVerified(account)
    } catch {
      // The mutation carries the message; nothing to add here.
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (token.trim() === '') return

    try {
      await save.mutateAsync({
        label: label.trim() === '' ? 'Wialon' : label.trim(),
        baseUrl,
        token: token.trim(),
        ...(connection ? { connectionId: connection.id } : {}),
      })
      // Cleared immediately: there is no reason for a provider token to survive
      // one submit in a React state tree that a devtools panel can read.
      setToken('')
      toast.success(
        rotating ? 'Credential replaced' : 'Provider connected',
        rotating
          ? 'The new credential is stored. Synchronise to confirm the provider accepts it.'
          : 'Synchronise devices to bring your trackers in.',
      )
      onOpenChange(false)
      reset()
    } catch {
      // Shown inline below.
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent
        title={rotating ? 'Replace provider credential' : 'Connect a tracking provider'}
        description={
          rotating
            ? 'The current token cannot be shown — it is stored encrypted and is not readable by anyone, including you. Paste the replacement.'
            : `${getAppName()} reads positions from your existing tracking account. Nothing is sent to your vehicles.`
        }
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} type="button">
              Cancel
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => void onTest()}
              isLoading={test.isPending}
              disabled={baseUrl === '' || (token.trim() === '' && !rotating)}
            >
              Test connection
            </Button>
            <Button
              type="submit"
              form="gps-connection-form"
              isLoading={save.isPending}
              disabled={token.trim() === '' || baseUrl === ''}
            >
              {rotating ? 'Replace credential' : 'Connect'}
            </Button>
          </>
        }
      >
        <form
          id="gps-connection-form"
          onSubmit={(event) => void onSubmit(event)}
          className="space-y-4"
        >
          <Field label="Provider">
            <Select
              value="wialon"
              disabled
              options={[{ value: 'wialon', label: 'Wialon' }]}
              onChange={() => {}}
            />
          </Field>

          <Field label="Name" hint="How this connection is referred to across the workspace.">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
            />
          </Field>

          <Field
            label="Server"
            hint="Wialon runs separate installations. A token issued on one is not valid on another."
            required
          >
            <Select
              value={host}
              onChange={(event) => {
                setHost(event.target.value)
                setVerified(null)
              }}
              options={WIALON_HOSTS.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          </Field>

          {host === 'custom' ? (
            <Field
              label="Server address"
              hint="The https address of your Wialon Local installation."
              required
              error={
                customUrl !== '' && !/^https:\/\//i.test(customUrl)
                  ? 'Must start with https://'
                  : undefined
              }
            >
              <Input
                value={customUrl}
                onChange={(event) => {
                  setCustomUrl(event.target.value)
                  setVerified(null)
                }}
                placeholder="https://gps.example.com"
                inputMode="url"
                autoComplete="off"
              />
            </Field>
          ) : null}

          <Field
            label={rotating ? 'New access token' : 'Access token'}
            hint={`Created in Wialon under your user account. ${getAppName()} stores it encrypted and never shows it again.`}
            required
          >
            <Input
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setVerified(null)
              }}
              autoComplete="off"
              spellCheck={false}
              // Keeps the value out of the browser's saved form data and out of
              // any autofill store shared between sites.
              data-1p-ignore
              data-lpignore="true"
            />
          </Field>

          <div className="border-line bg-surface-inset text-ink-muted flex gap-2.5 rounded-md border px-3 py-2.5 text-[0.75rem] leading-4">
            <ShieldCheck className="text-ink-subtle mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              This token is sent once, to {getAppName()}&rsquo;s server, and stored in an encrypted
              vault that the browser cannot read. It is used only to read unit lists, positions and
              history. {getAppName()} sends no commands to your trackers — no immobilisation, no
              door control, no configuration.
            </p>
          </div>

          {test.isError ? <Alert tone="critical">{toErrorMessage(test.error)}</Alert> : null}
          {save.isError ? <Alert tone="critical">{toErrorMessage(save.error)}</Alert> : null}

          {verified ? (
            <Alert tone="positive" title="The provider answered">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  {verified.accountLabel ?? 'Account verified'}
                </span>
                <span>
                  {verified.unitCount} {verified.unitCount === 1 ? 'device' : 'devices'} visible
                </span>
                <span className="text-[0.75rem] opacity-80">{verified.host}</span>
              </span>
            </Alert>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}
