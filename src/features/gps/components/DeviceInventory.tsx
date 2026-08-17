import { Link2, Link2Off, Radio, Search } from 'lucide-react'
import { useState } from 'react'

import { vehicleDetailPath } from '@/app/routes/paths'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  useToast,
} from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { GpsUnitInventoryRow } from '@/types/database'
import { Link } from 'react-router-dom'

import { useGpsInventory, useUnassignUnit } from '../queries'

import { AssignDeviceDialog } from './AssignDeviceDialog'
import { ProviderConnectivityBadge, UnitAvailabilityBadge } from './GpsBadges'

/**
 * The devices the provider account contains, and what each one is on.
 *
 * The identifiers are the provider's and stay opaque strings: a Wialon unit id
 * is a 64-bit integer that a JavaScript number would silently round, and a
 * hardware UID belongs to a physical box the agency may need to find in a
 * warehouse. Neither is parsed, reformatted or treated as meaningful.
 *
 * This is the only screen where the hardware UID appears. It is an identifier
 * for a device, not for a vehicle or a person, and it has no business being on
 * a map somebody has open at a counter.
 *
 * Assignment is enforced by the database, not by this list. Two partial unique
 * indexes make "one device on one vehicle" and "one vehicle with one device"
 * true regardless of what two administrators do at the same moment; the dialog
 * below simply asks nicely first.
 */

export interface DeviceInventoryProps {
  locale: string
  timeZone: string
  canAssign: boolean
}

export function DeviceInventory({ locale, timeZone, canAssign }: DeviceInventoryProps) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'any' | 'assigned' | 'unassigned'>('any')
  const [assigning, setAssigning] = useState<GpsUnitInventoryRow | null>(null)
  const [releasing, setReleasing] = useState<GpsUnitInventoryRow | null>(null)

  const inventory = useGpsInventory({ search, assigned: filter })
  const unassign = useUnassignUnit()

  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })

  const rows = inventory.data ?? []

  async function onRelease() {
    if (!releasing?.assignment_id) return
    try {
      await unassign.mutateAsync(releasing.assignment_id)
      toast.success(
        'Device released',
        'The link is closed and kept in the assignment history. Positions already recorded are unchanged.',
      )
      setReleasing(null)
    } catch (error) {
      toast.error('Could not release the device', toErrorMessage(error))
    }
  }

  return (
    <Card>
      <CardHeader
        title="Devices"
        description="Trackers in your provider account, and the vehicle each one is fitted to."
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative min-w-[10rem] flex-1 sm:flex-none">
              <Search
                className="text-ink-subtle pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                aria-label="Search devices"
                className="h-8 w-full ps-8 text-[0.8125rem] sm:w-48"
                placeholder="Name or identifier"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select
              aria-label="Assignment filter"
              className="h-8 w-full text-[0.8125rem] sm:w-40"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as 'any' | 'assigned' | 'unassigned')
              }
              options={[
                { value: 'any', label: 'All devices' },
                { value: 'assigned', label: 'Assigned' },
                { value: 'unassigned', label: 'Unassigned' },
              ]}
            />
          </div>
        }
      />

      <CardBody className="p-0">
        {rows.length === 0 ? (
          <EmptyState
            icon={Radio}
            size="sm"
            title={
              search === '' && filter === 'any'
                ? 'No devices synchronised yet'
                : 'No device matches these filters'
            }
            description={
              search === '' && filter === 'any'
                ? 'Synchronise the connection to bring in the trackers your provider account contains.'
                : undefined
            }
          />
        ) : (
          <>
            {/*
              A six-column device table cannot go on a 390px screen, and putting
              one inside a horizontal scroller made the whole page slide sideways
              underneath it. The same devices are a list below `lg`, which is the
              pattern the rest of the product already uses for its ledgers.
            */}
            <ul className="divide-line divide-y lg:hidden">
              {rows.map((row) => (
                <li key={row.id} className="space-y-2 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[0.875rem] font-medium">{row.name}</p>
                      <p className="text-ink-subtle truncate font-mono text-[0.75rem]">
                        {row.external_id}
                        {row.device_uid ? ` · ${row.device_uid}` : ''}
                      </p>
                    </div>
                    {canAssign ? (
                      row.assignment_id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => setReleasing(row)}
                        >
                          Release
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          onClick={() => setAssigning(row)}
                        >
                          Assign
                        </Button>
                      )
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <UnitAvailabilityBadge availability={row.availability} />
                    <ProviderConnectivityBadge online={row.provider_online} />
                  </div>

                  <p className="text-ink-muted text-[0.75rem]">
                    {row.vehicle_id ? (
                      <Link
                        to={vehicleDetailPath(row.vehicle_id)}
                        className="text-brand-700 font-medium hover:underline"
                      >
                        {row.vehicle_plate}
                      </Link>
                    ) : (
                      <span className="text-ink-subtle">Unassigned</span>
                    )}
                    {' · '}
                    {row.last_position_at
                      ? dateTime.format(new Date(row.last_position_at))
                      : 'never reported'}
                  </p>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[46rem] text-[0.8125rem]">
                <thead>
                  <tr className="border-line text-ink-subtle text-2xs border-b text-start tracking-wide uppercase">
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      Device
                    </th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      Identifier
                    </th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      State
                    </th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      Vehicle
                    </th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      Last position
                    </th>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-surface-muted">
                      <td className="px-4 py-2.5">
                        <p className="font-medium">{row.name}</p>
                        <p className="text-ink-subtle text-[0.75rem]">{row.connection_label}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="font-mono text-[0.75rem]">{row.external_id}</p>
                        {row.device_uid ? (
                          <p className="text-ink-subtle font-mono text-[0.75rem]">
                            {row.device_uid}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <UnitAvailabilityBadge availability={row.availability} />
                          <ProviderConnectivityBadge online={row.provider_online} />
                        </div>
                        {row.missing_since ? (
                          <p className="text-critical-700 mt-1 text-[0.75rem]">
                            Not seen since {dateTime.format(new Date(row.missing_since))}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.vehicle_id ? (
                          <Link
                            to={vehicleDetailPath(row.vehicle_id)}
                            className="text-brand-700 font-medium hover:underline"
                          >
                            {row.vehicle_plate}
                          </Link>
                        ) : (
                          <span className="text-ink-subtle">Unassigned</span>
                        )}
                        {row.vehicle_id ? (
                          <p className="text-ink-subtle text-[0.75rem]">
                            {row.vehicle_make} {row.vehicle_model}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.last_position_at ? (
                          <span className="tabular-nums">
                            {dateTime.format(new Date(row.last_position_at))}
                          </span>
                        ) : (
                          <span className="text-ink-subtle">Never</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-end">
                        {canAssign ? (
                          row.assignment_id ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              leadingIcon={<Link2Off />}
                              onClick={() => setReleasing(row)}
                            >
                              Release
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              leadingIcon={<Link2 />}
                              onClick={() => setAssigning(row)}
                            >
                              Assign
                            </Button>
                          )
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardBody>

      {assigning ? (
        <AssignDeviceDialog
          unit={assigning}
          open={assigning !== null}
          onOpenChange={(open) => {
            if (!open) setAssigning(null)
          }}
        />
      ) : null}

      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) setReleasing(null)
        }}
        title={`Release ${releasing?.name ?? 'this device'}?`}
        description={`This ends the link between the device and ${releasing?.vehicle_plate ?? 'the vehicle'}. The assignment stays in the history, so past positions remain attributable to the right vehicle.`}
        confirmLabel="Release device"
        tone="danger"
        isPending={unassign.isPending}
        onConfirm={() => void onRelease()}
      />
    </Card>
  )
}
