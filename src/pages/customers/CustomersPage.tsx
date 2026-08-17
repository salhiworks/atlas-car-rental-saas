import { Plus, SearchX, Upload, Users } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import { Button, ButtonLink, Card, EmptyState, ListPagination, PageHeader } from '@/components/ui'
import {
  CUSTOMER_SORTS,
  type CustomerSort,
  type LicenceFilter,
  type RentalFilter,
} from '@/features/customers/api'
import { CustomerCardList } from '@/features/customers/components/CustomerCardList'
import { CustomerImportDialog } from '@/features/customers/components/CustomerImportDialog'
import { CustomerTable } from '@/features/customers/components/CustomerTable'
import {
  CustomerToolbar,
  type CustomerFilters,
} from '@/features/customers/components/CustomerToolbar'
import { useCustomerCountries, useCustomerList } from '@/features/customers/queries'
import { useComplianceOptions } from '@/features/workspace/useOrganizationSettings'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'

function isSort(value: string): value is CustomerSort {
  return value in CUSTOMER_SORTS
}

/**
 * The customer list.
 *
 * Filters live in the URL so a view can be bookmarked and shared — "everyone
 * with an expired licence" is a thing an agency wants to send to a colleague.
 * The search term goes in the URL too; a name is not a secret, and identifiers
 * are never placed there, because those are.
 */
export function CustomersPage() {
  const organization = useOrganization()
  const canCreate = usePermission('customers.create')
  const compliance = useComplianceOptions()
  const [searchParams, setSearchParams] = useSearchParams()
  const [isImportOpen, setIsImportOpen] = useState(false)

  const filters: CustomerFilters = useMemo(() => {
    const sort = searchParams.get('sort') ?? 'name'
    const licence = searchParams.get('licence') ?? 'any'
    const rental = searchParams.get('rental') ?? 'any'

    return {
      search: searchParams.get('q') ?? '',
      sort: isSort(sort) ? sort : 'name',
      countries: searchParams.getAll('country'),
      licence: (['any', 'valid', 'expired', 'missing'] as const).includes(licence as LicenceFilter)
        ? (licence as LicenceFilter)
        : 'any',
      rental: (['any', 'active', 'outstanding', 'never'] as const).includes(rental as RentalFilter)
        ? (rental as RentalFilter)
        : 'any',
      includeArchived: searchParams.get('archived') === '1',
    }
  }, [searchParams])

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, { resetPage = true } = {}) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          mutate(next)
          if (resetPage) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const handleFilterChange = useCallback(
    (patch: Partial<CustomerFilters>) => {
      updateParams((params) => {
        if (patch.search !== undefined) {
          if (patch.search === '') params.delete('q')
          else params.set('q', patch.search)
        }
        if (patch.sort !== undefined) {
          if (patch.sort === 'name') params.delete('sort')
          else params.set('sort', patch.sort)
        }
        if (patch.countries !== undefined) {
          params.delete('country')
          for (const country of patch.countries) params.append('country', country)
        }
        if (patch.licence !== undefined) {
          if (patch.licence === 'any') params.delete('licence')
          else params.set('licence', patch.licence)
        }
        if (patch.rental !== undefined) {
          if (patch.rental === 'any') params.delete('rental')
          else params.set('rental', patch.rental)
        }
        if (patch.includeArchived !== undefined) {
          if (patch.includeArchived) params.set('archived', '1')
          else params.delete('archived')
        }
      })
    },
    [updateParams],
  )

  const clearAll = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true })
  }, [setSearchParams])

  const countriesQuery = useCustomerCountries()
  const listQuery = useCustomerList({
    search: filters.search,
    countries: filters.countries,
    licence: filters.licence,
    rental: filters.rental,
    includeArchived: filters.includeArchived,
    sort: filters.sort,
    page,
  })

  const customers = listQuery.data?.rows ?? []
  const total = listQuery.data?.total ?? 0
  const pageCount = listQuery.data?.pageCount ?? 1

  const activeFilterCount =
    (filters.countries.length > 0 ? 1 : 0) +
    (filters.licence !== 'any' ? 1 : 0) +
    (filters.rental !== 'any' ? 1 : 0) +
    (filters.includeArchived ? 1 : 0)

  const isFiltered = activeFilterCount > 0 || filters.search.length > 0
  const hasAnyCustomers = total > 0 || isFiltered

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        eyebrow="Operations"
        description={
          total > 0
            ? `${total} ${total === 1 ? 'customer' : 'customers'} on file for ${organization.name}.`
            : `Renters and company accounts for ${organization.name}.`
        }
        actions={
          canCreate ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                leadingIcon={<Upload />}
                onClick={() => setIsImportOpen(true)}
              >
                Import
              </Button>
              <ButtonLink variant="primary" leadingIcon={<Plus />} to={paths.customerNew}>
                Add customer
              </ButtonLink>
            </div>
          ) : null
        }
      />

      {hasAnyCustomers ? (
        <CustomerToolbar
          filters={filters}
          onChange={handleFilterChange}
          availableCountries={countriesQuery.data ?? []}
          locale={organization.locale}
          activeFilterCount={activeFilterCount}
          onClearAll={clearAll}
        />
      ) : null}

      <Card className="overflow-hidden">
        {listQuery.isError ? (
          <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
        ) : listQuery.isPending ? (
          <>
            <CustomerTable
              customers={[]}
              compliance={compliance}
              locale={organization.locale}
              isLoading
            />
            <CustomerCardList
              customers={[]}
              compliance={compliance}
              locale={organization.locale}
              isLoading
            />
          </>
        ) : customers.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={SearchX}
              title="No customers match these filters"
              description="Try a different search term, or clear the filters to see everyone."
              action={
                <Button variant="secondary" size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="Add your first customer"
              description="Record who is renting, keep their identification and licence on file, and put them on a contract."
              action={
                canCreate ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <ButtonLink variant="primary" to={paths.customerNew}>
                      Add customer
                    </ButtonLink>
                    <Button variant="secondary" onClick={() => setIsImportOpen(true)}>
                      Import from a spreadsheet
                    </Button>
                  </div>
                ) : (
                  <p className="text-ink-subtle text-[0.8125rem]">
                    Ask a colleague with the right access to add customers.
                  </p>
                )
              }
            />
          )
        ) : (
          <>
            <CustomerTable
              customers={customers}
              compliance={compliance}
              locale={organization.locale}
            />
            <CustomerCardList
              customers={customers}
              compliance={compliance}
              locale={organization.locale}
            />
          </>
        )}

        <ListPagination
          page={page}
          pageCount={pageCount}
          total={total}
          noun="customer"
          onPageChange={(next) =>
            updateParams((params) => params.set('page', String(next)), { resetPage: false })
          }
        />
      </Card>

      <CustomerImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  )
}
