import { Suspense, lazy } from 'react'
import { Route, BrowserRouter as Router, Routes } from 'react-router-dom'

import { FullPageLoader } from '@/components/feedback/FullPageLoader'
import { navigationGroups } from '@/components/layout/navigation'
import { ModulePage } from '@/pages/ModulePage'

import {
  RequireAnonymous,
  RequireAuth,
  RequireNoOrganization,
  RequireOrganization,
  RequirePermission,
  WithWorkspace,
} from './guards'
import { paths } from './paths'
import { upcomingModules } from './upcomingModules'

/*
 * Routes are code-split along the boundary that matters: someone arriving at the
 * sign-in screen should not download the dashboard, its charts and its settings
 * forms before they can type a password. The shell and the authenticated pages
 * load once a session exists.
 */
const AppShell = lazy(() =>
  import('@/components/layout/AppShell').then((module) => ({ default: module.AppShell })),
)
const OverviewPage = lazy(() =>
  import('@/pages/OverviewPage').then((module) => ({ default: module.OverviewPage })),
)
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
)
const NotFoundPage = lazy(() =>
  import('@/pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })),
)

const VehiclesPage = lazy(() =>
  import('@/pages/vehicles/VehiclesPage').then((module) => ({ default: module.VehiclesPage })),
)
const VehicleNewPage = lazy(() =>
  import('@/pages/vehicles/VehicleNewPage').then((module) => ({ default: module.VehicleNewPage })),
)
const VehicleDetailPage = lazy(() =>
  import('@/pages/vehicles/VehicleDetailPage').then((module) => ({
    default: module.VehicleDetailPage,
  })),
)

const RentalsPage = lazy(() =>
  import('@/pages/rentals/RentalsPage').then((module) => ({ default: module.RentalsPage })),
)
const RentalNewPage = lazy(() =>
  import('@/pages/rentals/RentalNewPage').then((module) => ({ default: module.RentalNewPage })),
)
const RentalDetailPage = lazy(() =>
  import('@/pages/rentals/RentalDetailPage').then((module) => ({
    default: module.RentalDetailPage,
  })),
)

const CalendarPage = lazy(() =>
  import('@/pages/calendar/CalendarPage').then((module) => ({ default: module.CalendarPage })),
)

const ExpensesPage = lazy(() =>
  import('@/pages/expenses/ExpensesPage').then((module) => ({ default: module.ExpensesPage })),
)
const ExpenseNewPage = lazy(() =>
  import('@/pages/expenses/ExpenseNewPage').then((module) => ({ default: module.ExpenseNewPage })),
)
const ExpenseDetailPage = lazy(() =>
  import('@/pages/expenses/ExpenseDetailPage').then((module) => ({
    default: module.ExpenseDetailPage,
  })),
)

const FinancingPage = lazy(() =>
  import('@/pages/financing/FinancingPage').then((module) => ({ default: module.FinancingPage })),
)
const FinancingNewPage = lazy(() =>
  import('@/pages/financing/FinancingNewPage').then((module) => ({
    default: module.FinancingNewPage,
  })),
)
const FinancingDetailPage = lazy(() =>
  import('@/pages/financing/FinancingDetailPage').then((module) => ({
    default: module.FinancingDetailPage,
  })),
)

const GpsTrackingPage = lazy(() =>
  import('@/pages/gps/GpsTrackingPage').then((module) => ({ default: module.GpsTrackingPage })),
)

const ReportsPage = lazy(() =>
  import('@/pages/reports/ReportsPage').then((module) => ({ default: module.ReportsPage })),
)

const TeamPage = lazy(() =>
  import('@/pages/team/TeamPage').then((module) => ({ default: module.TeamPage })),
)

const BillingPage = lazy(() =>
  import('@/pages/billing/BillingPage').then((module) => ({ default: module.BillingPage })),
)
const BillingReturnPage = lazy(() =>
  import('@/pages/billing/BillingReturnPage').then((module) => ({
    default: module.BillingReturnPage,
  })),
)
const NotificationsPage = lazy(() =>
  import('@/pages/notifications/NotificationsPage').then((module) => ({
    default: module.NotificationsPage,
  })),
)

const CustomersPage = lazy(() =>
  import('@/pages/customers/CustomersPage').then((module) => ({ default: module.CustomersPage })),
)
const CustomerNewPage = lazy(() =>
  import('@/pages/customers/CustomerNewPage').then((module) => ({
    default: module.CustomerNewPage,
  })),
)
const CustomerDetailPage = lazy(() =>
  import('@/pages/customers/CustomerDetailPage').then((module) => ({
    default: module.CustomerDetailPage,
  })),
)

const SignInPage = lazy(() =>
  import('@/pages/auth/SignInPage').then((module) => ({ default: module.SignInPage })),
)
const SignUpPage = lazy(() =>
  import('@/pages/auth/SignUpPage').then((module) => ({ default: module.SignUpPage })),
)
const ForgotPasswordPage = lazy(() =>
  import('@/pages/auth/ForgotPasswordPage').then((module) => ({
    default: module.ForgotPasswordPage,
  })),
)
const ResetPasswordPage = lazy(() =>
  import('@/pages/auth/ResetPasswordPage').then((module) => ({
    default: module.ResetPasswordPage,
  })),
)
const AuthCallbackPage = lazy(() =>
  import('@/pages/auth/AuthCallbackPage').then((module) => ({ default: module.AuthCallbackPage })),
)
const ConfirmEmailPage = lazy(() =>
  import('@/pages/auth/ConfirmEmailPage').then((module) => ({ default: module.ConfirmEmailPage })),
)
const AcceptInvitePage = lazy(() =>
  import('@/pages/auth/AcceptInvitePage').then((module) => ({
    default: module.AcceptInvitePage,
  })),
)
const CreateAgencyPage = lazy(() =>
  import('@/pages/onboarding/CreateAgencyPage').then((module) => ({
    default: module.CreateAgencyPage,
  })),
)

/*
 * The public marketing homepage. Shown at `paths.overview` ('/') only to a
 * signed-out visitor — see the `publicHome` branch in `RequireAuth`. It is its
 * own lazy chunk so visiting `/` signed out never downloads the authenticated
 * shell, its feature modules, or anything Reports/GPS/Financing pull in.
 */
const MarketingHomePage = lazy(() =>
  import('@/pages/marketing/MarketingHomePage').then((module) => ({
    default: module.MarketingHomePage,
  })),
)

/** The permission that gates each not-yet-open section, taken from the nav model. */
const permissionForPath = new Map(
  navigationGroups.flatMap((group) => group.items.map((item) => [item.to, item.permission])),
)

export function AppRouter() {
  return (
    <Router>
      <Suspense fallback={<FullPageLoader />}>
        <Routes>
          {/* Unauthenticated */}
          <Route element={<RequireAnonymous />}>
            <Route path={paths.signIn} element={<SignInPage />} />
            <Route path={paths.signUp} element={<SignUpPage />} />
            <Route path={paths.forgotPassword} element={<ForgotPasswordPage />} />
          </Route>

          {/* Reachable in either state: these establish or complete a session. */}
          <Route path={paths.authCallback} element={<AuthCallbackPage />} />
          <Route path={paths.resetPassword} element={<ResetPasswordPage />} />
          <Route path={paths.confirmEmail} element={<ConfirmEmailPage />} />

          {/*
           * Invitation acceptance sits outside every guard, and has to.
           *
           * RequireAuth would bounce a signed-out invitee to the sign-in screen
           * and lose the fragment carrying their token on the way. RequireOrganization
           * would send an invited person with no membership yet to onboarding —
           * which is the exact accident this module exists to prevent: being made
           * to create an agency of your own before you are allowed to join one.
           * The page handles all three arrival states itself, and the token grants
           * nothing until the database has checked it.
           */}
          <Route path={paths.acceptInvite} element={<AcceptInvitePage />} />

          {/* Authenticated — except `/`, which a signed-out visitor sees the
              public marketing page for instead of being sent to sign in. */}
          <Route element={<RequireAuth publicHome={<MarketingHomePage />} />}>
            <Route element={<WithWorkspace />}>
              <Route element={<RequireNoOrganization />}>
                <Route path={paths.createAgency} element={<CreateAgencyPage />} />
              </Route>

              <Route element={<RequireOrganization />}>
                <Route element={<AppShell />}>
                  <Route path={paths.overview} element={<OverviewPage />} />
                  <Route path={paths.settings} element={<SettingsPage />} />

                  {/* Fleet. Creation is gated separately from viewing, so staff
                      can look up a vehicle without being offered Add. */}
                  <Route element={<RequirePermission permission="vehicles.view" />}>
                    <Route path={paths.vehicles} element={<VehiclesPage />} />
                    <Route path={paths.vehicleDetail} element={<VehicleDetailPage />} />
                    <Route element={<RequirePermission permission="vehicles.create" />}>
                      <Route path={paths.vehicleNew} element={<VehicleNewPage />} />
                    </Route>
                  </Route>

                  {/* Tracking. Viewing sits with the manager, not the desk: a
                      vehicle's position during an active rental is a customer's
                      movements. Connecting a provider and assigning a device are
                      gated separately again, inside the page. */}
                  <Route element={<RequirePermission permission="gps.view" />}>
                    <Route path={paths.gpsTracking} element={<GpsTrackingPage />} />
                  </Route>

                  {/* Rentals. Viewing is gated separately from creating, so a
                      read-only role can look a contract up without being
                      offered New rental. */}
                  <Route element={<RequirePermission permission="rentals.view" />}>
                    <Route path={paths.rentals} element={<RentalsPage />} />
                    <Route path={paths.rentalDetail} element={<RentalDetailPage />} />
                    <Route element={<RequirePermission permission="rentals.create" />}>
                      <Route path={paths.rentalNew} element={<RentalNewPage />} />
                    </Route>

                    {/* The Calendar reads the same rentals under the same
                        permission: it is a view over the domain, not a second
                        way into it. */}
                    <Route path={paths.calendar} element={<CalendarPage />} />
                  </Route>

                  {/* Customers. Viewing is gated separately from creating, so
                      a read-only role can look somebody up without being
                      offered Add. */}
                  <Route element={<RequirePermission permission="customers.view" />}>
                    <Route path={paths.customers} element={<CustomersPage />} />
                    <Route path={paths.customerDetail} element={<CustomerDetailPage />} />
                    <Route element={<RequirePermission permission="customers.create" />}>
                      <Route path={paths.customerNew} element={<CustomerNewPage />} />
                    </Route>
                  </Route>

                  {/* Costs. Reading the ledger is what most of the desk needs;
                      recording one is a separate permission again. */}
                  <Route element={<RequirePermission permission="expenses.view" />}>
                    <Route path={paths.expenses} element={<ExpensesPage />} />
                    <Route path={paths.expenseDetail} element={<ExpenseDetailPage />} />
                    <Route element={<RequirePermission permission="expenses.create" />}>
                      <Route path={paths.expenseNew} element={<ExpenseNewPage />} />
                    </Route>
                  </Route>

                  {/* Financing. Viewing is a manager's; recording an agreement
                      or a lender payment is an administrator's, because both
                      move a balance the agency owes. */}
                  <Route element={<RequirePermission permission="financing.view" />}>
                    <Route path={paths.financing} element={<FinancingPage />} />
                    <Route path={paths.financingDetail} element={<FinancingDetailPage />} />
                    <Route element={<RequirePermission permission="financing.create" />}>
                      <Route path={paths.financingNew} element={<FinancingNewPage />} />
                    </Route>
                  </Route>

                  {/* Reports. A manager's, like Financing and Tracking: it
                      combines financial, customer and location data, and the
                      front desk needs none of it. */}
                  <Route element={<RequirePermission permission="reports.view" />}>
                    <Route path={paths.reports} element={<ReportsPage />} />
                  </Route>

                  {/* Notifications. No permission of its own: the feed decides
                      per category what this member may be told, so the page is
                      safe for anybody with a membership and shows each person a
                      different list. */}
                  <Route path={paths.notifications} element={<NotificationsPage />} />

                  {/* Team. Every member may see who else is here; the actions
                      that change membership are gated inside the page and, far
                      more importantly, in the database. */}
                  <Route element={<RequirePermission permission="team.view" />}>
                    <Route path={paths.team} element={<TeamPage />} />
                  </Route>

                  {/* Billing. Owner-only, and the database says so too: an
                      administrator who types the URL is refused by
                      billing_overview, not by a missing menu entry. */}
                  <Route element={<RequirePermission permission="billing.manage" />}>
                    <Route path={paths.billing} element={<BillingPage />} />
                    <Route path={paths.billingReturn} element={<BillingReturnPage />} />
                  </Route>

                  {upcomingModules.map(({ path, ...module }) => {
                    const permission = permissionForPath.get(path)
                    const element = <ModulePage {...module} />

                    return permission ? (
                      <Route key={path} element={<RequirePermission permission={permission} />}>
                        <Route path={path} element={element} />
                      </Route>
                    ) : (
                      <Route key={path} path={path} element={element} />
                    )
                  })}

                  {/*
                   * The catch-all lives inside the shell rather than at the top
                   * level, so an unknown path is still subject to RequireAuth:
                   * a signed-out visitor is sent to sign in, a signed-in one
                   * gets a not-found page with navigation still around them.
                   */}
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </Router>
  )
}
