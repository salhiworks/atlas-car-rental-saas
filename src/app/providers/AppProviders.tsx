import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'

import { ToastProvider } from '@/components/ui'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { toAppError } from '@/lib/supabase/errors'

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Agency data changes when a colleague changes it, not on a timer.
        // Refetching on focus keeps a staff member's screen current when they
        // come back to the tab, without polling all day.
        refetchOnWindowFocus: true,
        staleTime: 30_000,
        retry: (failureCount, error) => {
          const kind = toAppError(error).kind
          // Retrying a permission or validation failure just repeats it.
          if (kind === 'permission' || kind === 'validation' || kind === 'notFound') return false
          return failureCount < 2
        },
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function AppProviders({ children }: { children: ReactNode }) {
  // Created once per mount: a client shared across React roots would leak one
  // tenant's cached reads into another's session after a sign-out.
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
