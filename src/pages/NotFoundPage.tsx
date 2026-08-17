import { Compass } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Card, EmptyState } from '@/components/ui'

export function NotFoundPage() {
  return (
    <Card className="mx-auto max-w-lg">
      <EmptyState
        icon={Compass}
        title="That page does not exist"
        description="The link may be out of date, or the section may have moved."
        action={
          <Link
            to={paths.overview}
            className="text-brand-700 text-[0.8125rem] font-medium hover:underline"
          >
            Go to overview
          </Link>
        }
      />
    </Card>
  )
}
