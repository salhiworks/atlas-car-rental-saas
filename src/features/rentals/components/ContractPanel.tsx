import { Download, FileSignature, PenLine, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  useToast,
} from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { RentalContract } from '@/types/database'

import { contractFileName, renderContractPdf } from '../contract-pdf'
import { useIssueContract, useRentalContracts, useSignContract } from '../queries'
import { storeContractPdf, storeSignature } from '../storage'
import { ContractStatusBadge } from './RentalBadges'
import { SignaturePad } from './SignaturePad'

export interface ContractPanelProps {
  rentalId: string
  organizationId: string
  canIssue: boolean
  canIssueReason: string
  locale: string
  timeZone: string
}

/**
 * The contract, its versions, and the PDF.
 *
 * Issuing freezes everything legally relevant into a snapshot; the PDF is
 * rendered from that snapshot and from nothing else. Correcting a customer's
 * surname afterwards therefore changes the customer record and leaves the
 * signed agreement exactly as it was — which is the entire point of issuing a
 * document rather than displaying one.
 *
 * Amendments create a new version and supersede the previous one. Nothing is
 * ever edited in place.
 */
export function ContractPanel({
  rentalId,
  organizationId,
  canIssue,
  canIssueReason,
  locale,
  timeZone,
}: ContractPanelProps) {
  const toast = useToast()
  const contractsQuery = useRentalContracts(rentalId)
  const issueContract = useIssueContract(rentalId)
  const signContract = useSignContract()

  const [generating, setGenerating] = useState<string | null>(null)
  const [signing, setSigning] = useState<RentalContract | null>(null)

  const contracts = contractsQuery.data ?? []
  const current = contracts[0]

  /**
   * Renders the PDF, stores it privately and records its size and checksum.
   *
   * Storing rather than only downloading means the agency and the customer can
   * be shown the same file later, and the checksum makes "is this the document
   * we issued?" answerable.
   */
  const generate = async (contract: RentalContract, { download = true } = {}) => {
    setGenerating(contract.id)
    try {
      const blob = await renderContractPdf(contract.snapshot)

      if (!contract.pdf_path) {
        await storeContractPdf({
          organizationId,
          rentalId,
          contractId: contract.id,
          version: contract.version,
          bytes: blob,
        })
        await contractsQuery.refetch()
      }

      if (download) {
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = contractFileName(contract.snapshot)
        anchor.click()
        URL.revokeObjectURL(url)
      }
    } catch (error) {
      toast.error('Could not produce the contract', toErrorMessage(error))
    } finally {
      setGenerating(null)
    }
  }

  const issue = async (reason: string | null) => {
    try {
      const contract = await issueContract.mutateAsync(reason)
      toast.success(
        contract.version === 1 ? 'Contract issued' : `Version ${contract.version} issued`,
        'The document is frozen as it stands now.',
      )
      await generate(contract, { download: false })
    } catch (error) {
      toast.error('Could not issue the contract', toErrorMessage(error))
    }
  }

  return (
    <Card>
      <CardHeader
        title="Contract"
        description="Issued documents are frozen. Changes create a new version."
        actions={
          canIssue ? (
            <Button
              variant={current ? 'secondary' : 'primary'}
              size="sm"
              leadingIcon={current ? <RefreshCw /> : <FileSignature />}
              onClick={() => void issue(current ? 'Reissued after a change' : null)}
              isLoading={issueContract.isPending}
            >
              {current ? 'Reissue' : 'Issue contract'}
            </Button>
          ) : null
        }
      />

      <CardBody className="space-y-3">
        {!canIssue && !current ? (
          <EmptyState
            icon={FileSignature}
            title="No contract yet"
            description={canIssueReason || 'Confirm the reservation to issue a contract.'}
          />
        ) : null}

        {current && current.snapshot.pricing.total_minor === 0 ? (
          <Alert tone="caution" title="This contract charges nothing">
            It was issued with no priced lines. Add the charges and reissue before the customer
            signs.
          </Alert>
        ) : null}

        {contracts.length > 0 ? (
          <ul className="divide-line divide-y">
            {contracts.map((contract) => (
              <li key={contract.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-ink flex items-center gap-2 text-[0.8125rem] font-medium">
                    <span className="identifier">{contract.contract_number}</span>
                    <span className="text-ink-subtle">v{contract.version}</span>
                    <ContractStatusBadge status={contract.status} />
                  </p>
                  <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                    Issued {formatDateTime(new Date(contract.issued_at), { locale, timeZone })}
                    {contract.signed_at
                      ? ` · signed ${formatDateTime(new Date(contract.signed_at), { locale, timeZone })}`
                      : ''}
                    {contract.pdf_byte_size
                      ? ` · ${Math.round(contract.pdf_byte_size / 1024)} kB`
                      : ''}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {contract.status !== 'superseded' && contract.status !== 'signed' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<PenLine />}
                      onClick={() => setSigning(contract)}
                    >
                      Sign
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<Download />}
                    onClick={() => void generate(contract)}
                    isLoading={generating === contract.id}
                  >
                    PDF
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>

      {signing ? (
        <SignContractDialog
          contract={signing}
          onClose={() => setSigning(null)}
          organizationId={organizationId}
          rentalId={rentalId}
          onSign={async (input) => {
            await signContract.mutateAsync(input)
            toast.success('Contract signed', 'The signed version is on file.')
            setSigning(null)
          }}
          isPending={signContract.isPending}
        />
      ) : null}
    </Card>
  )
}

function SignContractDialog({
  contract,
  onClose,
  organizationId,
  rentalId,
  onSign,
  isPending,
}: {
  contract: RentalContract
  onClose: () => void
  organizationId: string
  rentalId: string
  onSign: (input: {
    contractId: string
    renterSignatureName: string
    renterSignaturePath: string | null
    agencySignatureName: string | null
  }) => Promise<void>
  isPending: boolean
}) {
  const toast = useToast()
  const [renterName, setRenterName] = useState(contract.snapshot.renter.display_name)
  const [agencyName, setAgencyName] = useState('')
  const [signature, setSignature] = useState<Blob | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const submit = async () => {
    if (renterName.trim() === '') return

    setIsSaving(true)
    try {
      const path = signature ? await storeSignature(organizationId, rentalId, signature) : null
      await onSign({
        contractId: contract.id,
        renterSignatureName: renterName.trim(),
        renterSignaturePath: path,
        agencySignatureName: agencyName.trim() || null,
      })
    } catch (error) {
      toast.error('Could not save the signature', toErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title="Sign the contract"
        description={`${contract.contract_number}, version ${contract.version}.`}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={isPending || isSaving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={isPending || isSaving}
              disabled={renterName.trim() === ''}
            >
              Record signature
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Signed by" required hint="The name as the person gives it at the counter.">
            <Input
              value={renterName}
              onChange={(event) => setRenterName(event.target.value)}
              maxLength={160}
            />
          </Field>

          <SignaturePad onChange={setSignature} label="Renter's signature — optional" />

          <Field label="Countersigned by" hint="Whoever is at the desk. Optional.">
            <Input
              value={agencyName}
              onChange={(event) => setAgencyName(event.target.value)}
              maxLength={160}
            />
          </Field>

          <Alert tone="info" title="What this records">
            A signature on this screen records that the person was at the counter and agreed to the
            document as it stands. It does not alter the document, and it is not a qualified
            electronic signature.
          </Alert>
        </div>
      </DialogContent>
    </Dialog>
  )
}
