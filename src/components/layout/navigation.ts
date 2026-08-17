import {
  Banknote,
  CalendarRange,
  CarFront,
  CreditCard,
  FileSignature,
  LayoutDashboard,
  Landmark,
  MapPinned,
  Settings,
  TrendingUp,
  Users,
  UsersRound,
} from 'lucide-react'
import type { ComponentType } from 'react'

import { paths } from '@/app/routes/paths'
import type { Permission } from '@/lib/authz/permissions'

export interface NavigationItem {
  readonly label: string
  readonly to: string
  readonly icon: ComponentType<{ className?: string }>
  /** Hides the entry when the member's role could not use it anyway. */
  readonly permission: Permission
  /** False while the module is still being built; the route renders an explanatory screen. */
  readonly isAvailable: boolean
}

export interface NavigationGroup {
  /** Omitted for the first group so the dashboard link sits on its own. */
  readonly label?: string
  readonly items: readonly NavigationItem[]
}

export const navigationGroups: readonly NavigationGroup[] = [
  {
    items: [
      {
        label: 'Overview',
        to: paths.overview,
        icon: LayoutDashboard,
        permission: 'organization.view',
        isAvailable: true,
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        label: 'Rentals',
        to: paths.rentals,
        icon: FileSignature,
        permission: 'rentals.view',
        isAvailable: true,
      },
      {
        label: 'Calendar',
        to: paths.calendar,
        icon: CalendarRange,
        permission: 'rentals.view',
        isAvailable: true,
      },
      {
        label: 'Customers',
        to: paths.customers,
        icon: Users,
        permission: 'customers.view',
        isAvailable: true,
      },
    ],
  },
  {
    label: 'Fleet',
    items: [
      {
        label: 'Vehicles',
        to: paths.vehicles,
        icon: CarFront,
        permission: 'vehicles.view',
        isAvailable: true,
      },
      {
        label: 'GPS tracking',
        to: paths.gpsTracking,
        icon: MapPinned,
        permission: 'gps.view',
        isAvailable: true,
      },
    ],
  },
  {
    label: 'Finance',
    items: [
      {
        label: 'Expenses',
        to: paths.expenses,
        icon: Banknote,
        permission: 'expenses.view',
        isAvailable: true,
      },
      {
        label: 'Financing',
        to: paths.financing,
        icon: Landmark,
        permission: 'financing.view',
        isAvailable: true,
      },
      {
        label: 'Reports',
        to: paths.reports,
        icon: TrendingUp,
        permission: 'reports.view',
        isAvailable: true,
      },
    ],
  },
  {
    label: 'Agency',
    items: [
      {
        label: 'Team',
        to: paths.team,
        icon: UsersRound,
        permission: 'team.view',
        isAvailable: true,
      },
      {
        label: 'Billing',
        to: paths.billing,
        icon: CreditCard,
        permission: 'billing.manage',
        isAvailable: true,
      },
      {
        label: 'Settings',
        to: paths.settings,
        icon: Settings,
        permission: 'organization.view',
        isAvailable: true,
      },
    ],
  },
]
