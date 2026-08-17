import { UserSearch } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Alert, Badge } from '@/components/ui'

import { useDuplicateCheck } from '../queries'

export interface DuplicateWarningProps {
  email?: string
  phone?: string
  documents?: readonly {
    document_type: string
    document_number: string
    issuing_country?: string | null
  }[]
  excludeCustomerId?: string | undefined
  /** Copy shown above the candidate list. */
  title?: string
}

/**
 * Surfaces customers who may already be this person.
 *
 * It warns and links; it never merges, and it never blocks. Two people can share
 * a phone number and two people can be called the same thing — deciding they are
 * one person is a judgement a member of staff makes with the customer in front
 * of them, not something an algorithm should do silently to an agency's records.
 *
 * The one case that *is* refused happens in the database: a repeated passport or
 * licence number hits a unique index, because that is not a resemblance, it is
 * the same document.
 */
export function DuplicateWarning({
  email = '',
  phone = '',
  documents = [],
  excludeCustomerId,
  title = 'This might already be one of your customers',
}: DuplicateWarningProps) {
  const hasContact = email.trim().length > 3 || phone.replace(/[^0-9]/g, '').length >= 6
  const hasDocument = documents.some((entry) => entry.document_number.trim().length >= 2)

  const probe = {
    email: email.trim() || null,
    phone: phone.trim() || null,
    documents,
    excludeCustomerId: excludeCustomerId ?? null,
  }

  const { data } = useDuplicateCheck(probe, hasContact || hasDocument)

  const matches = data ?? []
  if (matches.length === 0) return null

  const hasStrongMatch = matches.some((match) => match.match_strength === 'strong')

  return (
    <Alert tone={hasStrongMatch ? 'caution' : 'info'} title={title}>
      <p className="mb-2">
        {hasStrongMatch
          ? 'A customer with the same identification already exists. Open it instead of creating a second record.'
          : 'These customers share contact details. That is often a family or a company, so check before continuing.'}
      </p>

      <ul className="space-y-1.5">
        {matches.slice(0, 5).map((match) => (
          <li key={match.customer_id} className="flex flex-wrap items-center gap-2">
            <UserSearch className="size-3.5 shrink-0" aria-hidden="true" />
            <Link
              to={`${paths.customers}/${match.customer_id}`}
              className="font-medium underline underline-offset-2"
            >
              {match.display_name}
            </Link>
            <span className="text-[0.75rem]">{match.match_reason}</span>
            {match.archived_at ? <Badge tone="neutral">Archived</Badge> : null}
          </li>
        ))}
      </ul>
    </Alert>
  )
}
