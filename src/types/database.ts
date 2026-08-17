/**
 * TypeScript contract for the Supabase schema.
 *
 * Hand-authored to mirror `supabase/migrations/*.sql` exactly. Once you have the
 * Supabase CLI linked to the project you can regenerate it instead:
 *
 *     supabase gen types typescript --linked > src/types/database.ts
 *
 * Type mapping notes:
 *   - `bigint` (all `*_minor` columns) arrives as a JSON number. See
 *     `src/lib/money/money.ts` for why that is exact for our value range.
 *   - `timestamptz` arrives as an ISO 8601 string.
 *   - `date` arrives as `YYYY-MM-DD` with no zone — read it with
 *     `parseIsoDate(value, agencyTimeZone)`, never `new Date(value)`.
 *   - Generated columns (`display_name`, `balance_due_minor`, `payment_status`)
 *     appear in Row but never in Insert or Update.
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export type OrgRole = 'owner' | 'admin' | 'manager' | 'staff'
export type MemberStatus = 'active' | 'suspended'
/**
 * Every state a vehicle can be *shown* in. Only the operational subset is
 * stored — see VehicleOperationalStatus.
 */
export type VehicleStatus = 'available' | 'rented' | 'reserved' | 'maintenance' | 'unavailable'

/**
 * What an agency actually decides about a vehicle, and all `vehicles.status` may
 * hold (enforced by the vehicles_status_is_operational check constraint).
 * 'rented' and 'reserved' are derived from contracts, never written.
 */
export type VehicleOperationalStatus = 'available' | 'maintenance' | 'unavailable'

export const VEHICLE_OPERATIONAL_STATUSES: readonly VehicleOperationalStatus[] = [
  'available',
  'maintenance',
  'unavailable',
]
export type FuelType =
  'petrol' | 'diesel' | 'hybrid' | 'plug_in_hybrid' | 'electric' | 'lpg' | 'cng' | 'other'
export type TransmissionType = 'manual' | 'automatic'
export type CustomerType = 'individual' | 'company'
export type IdentityDocumentType = 'national_id' | 'passport' | 'residence_permit' | 'other'

/** What a customer can present. Driving licences share the table with identity documents. */
export type CustomerDocumentType =
  'national_id' | 'passport' | 'residence_permit' | 'driver_license' | 'other'

export const CUSTOMER_DOCUMENT_TYPES: readonly CustomerDocumentType[] = [
  'national_id',
  'passport',
  'residence_permit',
  'driver_license',
  'other',
]
export type RentalStatus = 'draft' | 'reserved' | 'active' | 'completed' | 'cancelled'
export type RentalPaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overpaid'
export type RentalDriverRole = 'primary' | 'additional'
export type PaymentDirection = 'inbound' | 'outbound'
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'online' | 'other'

export type GpsProvider = 'wialon'
export type GpsConnectionStatus =
  | 'never_connected'
  | 'healthy'
  | 'auth_error'
  | 'unreachable'
  | 'rate_limited'
  | 'provider_error'
  | 'disabled'
export type GpsUnitAvailability = 'present' | 'missing' | 'archived'
export type GpsMovementState = 'moving' | 'stopped'
export type GpsAssignmentRole = 'primary' | 'secondary'
export type GpsSyncOutcome =
  | 'success'
  | 'partial'
  | 'auth_error'
  | 'unreachable'
  | 'rate_limited'
  | 'provider_error'
  | 'aborted'
/** Derived from position age against the agency's own thresholds. */
export type GpsPositionFreshness = 'fresh' | 'stale' | 'very_stale' | 'unknown' | 'future'
/** Whether OUR synchronisation works — not whether the device is online. */
export type GpsSyncHealth =
  | 'healthy'
  | 'never_synced'
  | 'auth_error'
  | 'unreachable'
  | 'rate_limited'
  | 'provider_error'
  | 'disabled'
/** Telemetry a device is KNOWN to report. Absence means unknown, not absent. */
export type GpsCapability =
  | 'position'
  | 'speed'
  | 'heading'
  | 'altitude'
  | 'satellites'
  | 'ignition'
  | 'odometer'
  | 'engine_hours'
  | 'connectivity'
  | 'history'

export type VehicleAcquisitionMethod = 'cash' | 'financed' | 'leased' | 'other'
export type LenderKind =
  'bank' | 'finance_company' | 'leasing_company' | 'dealer' | 'private' | 'other'
export type FinancingAgreementType = 'loan' | 'lease' | 'installment_plan' | 'other'
export type FinancingAgreementStatus = 'draft' | 'active' | 'paid_off' | 'closed' | 'cancelled'
/** simple: only the payment and the dates are known. amortizing: the split is. */
export type FinancingMode = 'simple' | 'amortizing'
export type FinancingFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
export type FinancingPaymentPurpose = 'installment' | 'extra' | 'payoff' | 'fee'
export type FinancingPaymentStatus = 'recorded' | 'voided'
export type FinancingDocumentKind =
  'agreement' | 'statement' | 'payoff_letter' | 'receipt' | 'other'
export type FinancingChangeKind = 'correction' | 'status' | 'void'
export type FinancingInstallmentState =
  'upcoming' | 'due_today' | 'partially_paid' | 'paid' | 'overdue' | 'closed'
/** A deposit is the customer's money held; only a rental charge is revenue. */
export type PaymentPurpose = 'rental_charge' | 'deposit'
export type ContractStatus = 'issued' | 'signed' | 'superseded' | 'voided'
export type RentalConditionPhase = 'pickup' | 'return'
export type RentalChargeKind =
  | 'base_rental'
  | 'additional_driver'
  | 'delivery'
  | 'collection'
  | 'child_seat'
  | 'insurance'
  | 'cleaning'
  | 'late_return'
  | 'fuel'
  | 'damage'
  | 'adjustment'
  | 'discount'
  | 'other'
export const RENTAL_CHARGE_KINDS: readonly RentalChargeKind[] = [
  'base_rental',
  'additional_driver',
  'delivery',
  'collection',
  'child_seat',
  'insurance',
  'cleaning',
  'late_return',
  'fuel',
  'damage',
  'adjustment',
  'discount',
  'other',
]
export type ExpenseAllocation = 'overhead' | 'vehicle' | 'rental'
export type ExpenseStatus = 'recorded' | 'voided'
export type ExpenseSource = 'manual' | 'import' | 'financing'
export type ExpenseDocumentKind = 'receipt' | 'invoice' | 'supporting' | 'other'
export type ExpenseChangeKind = 'correction' | 'void'

/** @deprecated Replaced by organization-scoped expense_categories rows. */
export type ExpenseCategory =
  | 'fuel'
  | 'maintenance'
  | 'repair'
  | 'insurance'
  | 'registration'
  | 'tax'
  | 'fine'
  | 'cleaning'
  | 'tolls'
  | 'parking'
  | 'accessories'
  | 'financing'
  | 'salary'
  | 'rent'
  | 'marketing'
  | 'other'
export type VehicleDocumentType =
  | 'insurance'
  | 'registration'
  | 'technical_inspection'
  | 'road_tax'
  | 'permit'
  | 'purchase_invoice'
  | 'lease_agreement'
  | 'other'

/*
 * Row shapes are declared as type ALIASES, not interfaces, and that is load
 * bearing. Supabase's GenericTable requires Row/Insert/Update to satisfy
 * Record<string, unknown>; TypeScript grants that implicit index signature to
 * object type aliases but never to interfaces. Declaring these as interfaces
 * silently collapses every query result to `never`.
 */
type ProfileRow = {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  avatar_path: string | null
  locale: string
  created_at: string
  updated_at: string
}

type OrganizationRow = {
  id: string
  name: string
  slug: string
  legal_name: string | null
  tax_identifier: string | null
  default_currency: string
  time_zone: string
  country_code: string | null
  locale: string
  email: string | null
  phone: string | null
  website: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  logo_path: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

type OrganizationMemberRow = {
  id: string
  organization_id: string
  user_id: string
  role: OrgRole
  status: MemberStatus
  job_title: string | null
  invited_by: string | null
  joined_at: string
  created_at: string
  updated_at: string
}

type OrganizationSettingsRow = {
  organization_id: string
  date_format: string
  time_format: string
  first_day_of_week: number
  distance_unit: string
  volume_unit: string
  default_deposit_minor: number
  rental_reference_prefix: string
  rental_reference_next: number
  rental_reference_include_year: boolean
  compliance_reminder_lead_days: number
  /** Agency-authored contract wording. The product ships no legal text. */
  contract_terms: string | null
  fuel_policy: string | null
  mileage_policy: string | null
  late_return_policy: string | null
  damage_policy: string | null
  deposit_policy: string | null
  contract_footer: string | null
  /** Bumped by a trigger whenever any of the wording above changes. */
  terms_version: number
  /** Basis points. 20% is 2000. No jurisdiction is assumed. */
  tax_rate_bps: number
  tax_label: string | null
  created_at: string
  updated_at: string
}

type VehicleRow = {
  id: string
  organization_id: string
  make: string
  model: string
  model_year: number | null
  registration_plate: string
  vin: string | null
  color: string | null
  fuel_type: FuelType | null
  transmission: TransmissionType | null
  seats: number | null
  doors: number | null
  category: string | null
  odometer: number
  odometer_updated_at: string | null
  daily_rate_minor: number
  currency: string
  status: VehicleOperationalStatus
  insurance_expires_on: string | null
  inspection_expires_on: string | null
  registration_expires_on: string | null
  next_service_on: string | null
  next_service_odometer: number | null
  acquired_on: string | null
  acquisition_price_minor: number | null
  acquisition_currency: string | null
  acquisition_method: VehicleAcquisitionMethod | null
  acquisition_supplier: string | null
  acquisition_notes: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

type VehicleDocumentRow = {
  id: string
  organization_id: string
  vehicle_id: string
  document_type: VehicleDocumentType
  document_number: string | null
  issuer: string | null
  issued_on: string | null
  expires_on: string | null
  file_path: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

type CustomerRow = {
  id: string
  organization_id: string
  customer_type: CustomerType
  first_name: string | null
  last_name: string | null
  company_name: string | null
  /** Generated column. */
  display_name: string
  email: string | null
  phone: string | null
  secondary_phone: string | null
  date_of_birth: string | null
  /** Nationality, distinct from the address country. */
  nationality_country_code: string | null
  preferred_locale: string | null
  /** Generated: digits only, for matching. Never displayed. */
  phone_normalized: string
  /** Generated: lowercased and trimmed. */
  email_normalized: string
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country_code: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

type VehicleImageRow = {
  id: string
  organization_id: string
  vehicle_id: string
  storage_path: string
  thumbnail_path: string | null
  content_type: 'image/png' | 'image/jpeg' | 'image/webp'
  byte_size: number
  width: number | null
  height: number | null
  is_primary: boolean
  sort_order: number
  caption: string | null
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

/**
 * public.vehicle_fleet — the fleet read model.
 * Vehicle columns plus occupancy derived from contracts. Read-only.
 */
type VehicleFleetRow = {
  vehicle_id: string
  organization_id: string
  make: string
  model: string
  model_year: number | null
  registration_plate: string
  vin: string | null
  color: string | null
  category: string | null
  fuel_type: FuelType | null
  transmission: TransmissionType | null
  seats: number | null
  odometer: number
  daily_rate_minor: number
  currency: string
  insurance_expires_on: string | null
  inspection_expires_on: string | null
  registration_expires_on: string | null
  next_service_on: string | null
  notes: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  operational_status: VehicleOperationalStatus
  current_rental_id: string | null
  current_rental_reference: string | null
  current_customer_id: string | null
  current_rental_ends_at: string | null
  next_rental_id: string | null
  next_rental_reference: string | null
  next_customer_id: string | null
  next_rental_starts_at: string | null
  effective_status: VehicleStatus
  is_available_now: boolean
  acquisition_method: VehicleAcquisitionMethod | null
  acquired_on: string | null
  acquisition_price_minor: number | null
  acquisition_currency: string | null
  acquisition_supplier: string | null
  acquisition_notes: string | null
}

export type FleetStatusCountsRow = {
  total: number
  available: number
  rented: number
  reserved: number
  maintenance: number
  unavailable: number
  archived: number
}

export type VehicleUsageRow = {
  rentals_count: number
  expenses_count: number
  financing_count: number
  documents_count: number
  images_count: number
  can_delete: boolean
}

type CustomerDocumentRow = {
  id: string
  organization_id: string
  customer_id: string
  document_type: CustomerDocumentType
  document_number: string
  /** Generated: uppercase alphanumerics only. Used for duplicate detection. */
  document_number_normalized: string
  issuing_country: string | null
  issued_on: string | null
  expires_on: string | null
  license_classes: string[] | null
  notes: string | null
  file_path: string | null
  file_name: string | null
  file_mime_type: string | null
  file_size_bytes: number | null
  uploaded_by: string | null
  uploaded_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * public.customer_directory — the customer list read model.
 * Carries validity and rental context, and deliberately no document numbers.
 */
type CustomerDirectoryRow = {
  customer_id: string
  organization_id: string
  customer_type: CustomerType
  display_name: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  email: string | null
  phone: string | null
  secondary_phone: string | null
  date_of_birth: string | null
  nationality_country_code: string | null
  country_code: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  address_line1: string | null
  address_line2: string | null
  preferred_locale: string | null
  notes: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  identity_document_count: number
  document_count: number
  identity_expires_on: string | null
  driver_license_id: string | null
  driver_license_country: string | null
  driver_license_issued_on: string | null
  driver_license_expires_on: string | null
  driver_license_classes: string[] | null
  has_driver_license: boolean
  rental_count: number
  first_rental_at: string | null
  last_rental_ends_at: string | null
  active_rental_id: string | null
  active_rental_reference: string | null
  active_rental_ends_at: string | null
  upcoming_rental_id: string | null
  upcoming_rental_reference: string | null
  upcoming_rental_starts_at: string | null
  outstanding_currency_count: number
  /** Null unless exactly one currency is involved — never a mixed-currency total. */
  outstanding_minor: number | null
  outstanding_currency: string | null
}

export type CustomerRentalSummaryRow = {
  rental_count: number
  completed_count: number
  cancelled_count: number
  first_rental_at: string | null
  last_rental_ends_at: string | null
  active_rental_id: string | null
  upcoming_rental_id: string | null
}

export type CustomerFinancialSummaryRow = {
  currency: string
  rental_count: number
  charged_minor: number
  paid_minor: number
  outstanding_minor: number
  deposits_held_minor: number
}

export type CustomerDuplicateRow = {
  customer_id: string
  display_name: string
  archived_at: string | null
  match_reason: string
  match_strength: 'strong' | 'weak'
}

export type CustomerUsageRow = {
  rentals_count: number
  driver_on_count: number
  payments_count: number
  documents_count: number
  can_delete: boolean
}

type RentalRow = {
  id: string
  organization_id: string
  reference: string
  vehicle_id: string
  customer_id: string
  status: RentalStatus
  starts_at: string
  ends_at: string
  pickup_location: string | null
  return_location: string | null
  currency: string
  daily_rate_minor: number
  billable_days: number | null
  subtotal_minor: number
  extras_minor: number
  discount_minor: number
  tax_minor: number
  total_minor: number
  deposit_minor: number
  /** Rental charges settled. Deposits are excluded — see deposit_held_minor. */
  amount_paid_minor: number
  /** Refundable deposit actually held. Derived from payments; never revenue. */
  deposit_held_minor: number
  /** Generated column. */
  balance_due_minor: number
  /** Generated column. */
  payment_status: RentalPaymentStatus
  /** The rate applied to this contract, frozen against later agency changes. */
  tax_rate_bps: number
  tax_label: string | null
  pickup_odometer: number | null
  return_odometer: number | null
  pickup_fuel_percent: number | null
  return_fuel_percent: number | null
  picked_up_at: string | null
  returned_at: string | null
  pickup_condition_notes: string | null
  return_condition_notes: string | null
  pickup_recorded_by: string | null
  return_recorded_by: string | null
  confirmed_at: string | null
  /** The return date first agreed, kept when the hire is extended. */
  original_ends_at: string | null
  extension_count: number
  notes: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancellation_reason: string | null
  completed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * The frozen contract document.
 *
 * Written once by rental_issue_contract() and never updated, so the PDF renders
 * from this rather than from live rows: correcting a surname or re-plating a
 * vehicle must not silently rewrite an agreement somebody already signed.
 */
export type ContractSnapshot = {
  issued_at: string
  version: number
  contract_number: string
  agency: {
    name: string
    legal_name: string | null
    tax_identifier: string | null
    email: string | null
    phone: string | null
    website: string | null
    address_line1: string | null
    address_line2: string | null
    city: string | null
    region: string | null
    postal_code: string | null
    country_code: string | null
    logo_path: string | null
    time_zone: string
    locale: string
  }
  vehicle: {
    id: string
    make: string
    model: string
    model_year: number | null
    registration_plate: string
    vin: string | null
    color: string | null
    fuel_type: FuelType | null
    transmission: TransmissionType | null
    seats: number | null
  }
  renter: {
    id: string
    display_name: string
    customer_type: CustomerType
    email: string | null
    phone: string | null
    date_of_birth: string | null
    nationality_country_code: string | null
    address_line1: string | null
    address_line2: string | null
    city: string | null
    region: string | null
    postal_code: string | null
    country_code: string | null
    identity_documents: ReadonlyArray<{
      document_type: CustomerDocumentType
      document_number: string
      issuing_country: string | null
      expires_on: string | null
    }>
  }
  drivers: ReadonlyArray<{
    customer_id: string
    display_name: string
    role: RentalDriverRole
    license_number: string | null
    license_country: string | null
    license_expires_on: string | null
    license_classes: string[] | null
  }>
  rental: {
    starts_at: string
    ends_at: string
    original_ends_at: string | null
    pickup_location: string | null
    return_location: string | null
    billable_days: number | null
    daily_rate_minor: number
    notes: string | null
  }
  pricing: {
    currency: string
    subtotal_minor: number
    discount_minor: number
    tax_minor: number
    tax_rate_bps: number
    tax_label: string | null
    total_minor: number
    deposit_minor: number
    line_items: ReadonlyArray<{
      kind: RentalChargeKind
      description: string
      quantity: number
      unit_amount_minor: number
      amount_minor: number
      is_taxable: boolean
    }>
  }
  handover: {
    picked_up_at: string | null
    pickup_odometer: number | null
    pickup_fuel_percent: number | null
    pickup_condition_notes: string | null
    returned_at: string | null
    return_odometer: number | null
    return_fuel_percent: number | null
    return_condition_notes: string | null
  }
  terms: {
    version: number
    contract_terms: string | null
    fuel_policy: string | null
    mileage_policy: string | null
    late_return_policy: string | null
    damage_policy: string | null
    deposit_policy: string | null
    footer: string | null
  }
  units: { distance: string; volume: string }
}

/** One row of the rentals list, with the joined facts the screen shows. */
type RentalBoardRow = {
  id: string
  organization_id: string
  reference: string
  status: RentalStatus
  starts_at: string
  ends_at: string
  pickup_location: string | null
  return_location: string | null
  currency: string
  total_minor: number
  amount_paid_minor: number
  balance_due_minor: number
  deposit_minor: number
  deposit_held_minor: number
  payment_status: RentalPaymentStatus
  picked_up_at: string | null
  returned_at: string | null
  extension_count: number
  created_at: string
  vehicle_id: string
  vehicle_make: string
  vehicle_model: string
  vehicle_model_year: number | null
  vehicle_plate: string
  customer_id: string
  customer_name: string
  customer_type: CustomerType
  primary_driver_id: string | null
  primary_driver_name: string | null
  /** The renter pays; the primary driver drives. Often, but not always, one person. */
  renter_is_not_driver: boolean
  driver_count: number
  is_overdue: boolean
  contract_version: number | null
  contract_status: ContractStatus | null
  contract_pdf_path: string | null
  contract_signed_at: string | null
}

/**
 * public.rental_schedule — the fleet timeline's read model.
 *
 * Narrower than the board on purpose: a schedule block cannot show a charge
 * breakdown. It carries the two facts a timeline cannot derive for itself —
 * whether the hire is late, and what that vehicle is committed to next.
 */
type RentalScheduleRow = {
  id: string
  organization_id: string
  reference: string
  status: RentalStatus
  starts_at: string
  ends_at: string
  original_ends_at: string | null
  pickup_location: string | null
  return_location: string | null
  picked_up_at: string | null
  returned_at: string | null
  extension_count: number

  currency: string
  total_minor: number
  balance_due_minor: number
  deposit_held_minor: number
  payment_status: RentalPaymentStatus

  vehicle_id: string
  vehicle_make: string
  vehicle_model: string
  vehicle_plate: string

  customer_id: string
  customer_name: string
  primary_driver_id: string | null
  primary_driver_name: string | null
  renter_is_not_driver: boolean
  driver_count: number

  /** Active, past its return time, and not yet returned. Derived, never stored. */
  is_overdue: boolean

  next_rental_id: string | null
  next_rental_reference: string | null
  next_rental_starts_at: string | null
  /** Minutes between this hire ending and the next beginning; negative is impossible. */
  turnaround_minutes: number | null

  contract_version: number | null
  contract_status: ContractStatus | null
  /** A contract exists and has not been superseded, so a move must amend it. */
  has_live_contract: boolean
}

type RentalConflictRow = {
  rental_id: string
  reference: string
  status: RentalStatus
  starts_at: string
  ends_at: string
  customer_name: string
}

export type RentalUsageRow = {
  line_item_count: number
  payment_count: number
  contract_count: number
  photo_count: number
  driver_count: number
  can_delete: boolean
}

type RentalLineItemRow = {
  id: string
  organization_id: string
  rental_id: string
  kind: RentalChargeKind
  description: string
  quantity: number
  unit_amount_minor: number
  /** Signed: a discount line is negative. */
  amount_minor: number
  currency: string
  is_taxable: boolean
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

type RentalContractRow = {
  id: string
  organization_id: string
  rental_id: string
  version: number
  contract_number: string
  /** The frozen document. Rendered from this alone; never rewritten. */
  snapshot: ContractSnapshot
  terms_version: number
  status: ContractStatus
  issued_at: string
  issued_by: string | null
  signed_at: string | null
  renter_signature_path: string | null
  renter_signature_name: string | null
  agency_signature_path: string | null
  agency_signature_name: string | null
  pdf_path: string | null
  pdf_generated_at: string | null
  pdf_sha256: string | null
  pdf_byte_size: number | null
  superseded_at: string | null
  supersede_reason: string | null
  created_at: string
  updated_at: string
}

type RentalConditionPhotoRow = {
  id: string
  organization_id: string
  rental_id: string
  phase: RentalConditionPhase
  storage_path: string
  content_type: string
  byte_size: number
  caption: string | null
  uploaded_by: string | null
  uploaded_at: string
}

type RentalDriverRow = {
  id: string
  organization_id: string
  rental_id: string
  customer_id: string
  driver_role: RentalDriverRole
  license_number: string | null
  license_country: string | null
  license_expires_on: string | null
  created_at: string
  updated_at: string
}

type PaymentRow = {
  id: string
  organization_id: string
  rental_id: string | null
  customer_id: string | null
  direction: PaymentDirection
  purpose: PaymentPurpose
  method: PaymentMethod
  amount_minor: number
  currency: string
  paid_at: string
  reference: string | null
  notes: string | null
  recorded_by: string | null
  /** Reversal, not deletion. Voided entries stay visible and count nowhere. */
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  created_at: string
  updated_at: string
}

type ExpenseRow = {
  id: string
  organization_id: string
  /** Set only for an allocation of 'vehicle'; a rental cost reads its car through the hire. */
  vehicle_id: string | null
  rental_id: string | null
  category_id: string
  vendor_id: string | null
  allocation: ExpenseAllocation
  status: ExpenseStatus
  source: ExpenseSource
  description: string | null
  /** Gross total paid. The tax below is part of it, never added to it. */
  amount_minor: number
  tax_amount_minor: number
  tax_rate_bps: number | null
  tax_label: string | null
  currency: string
  /** The business date. `created_at` is when the receipt was typed in. */
  incurred_on: string
  payment_method: PaymentMethod | null
  reference: string | null
  notes: string | null
  odometer: number | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  /** Reserved for the Financing module; always null for a hand-recorded cost. */
  financing_plan_id: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
}

type ExpenseCategoryRow = {
  id: string
  organization_id: string
  name: string
  description: string | null
  /** Stable handle for the seeded set, so a rename cannot break anything. */
  system_key: string | null
  is_system: boolean
  default_allocation: ExpenseAllocation | null
  sort_order: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

type ExpenseVendorRow = {
  id: string
  organization_id: string
  name: string
  /** Generated: upper-cased with runs of whitespace collapsed. */
  name_normalized: string
  email: string | null
  phone: string | null
  tax_identifier: string | null
  address: string | null
  notes: string | null
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

type ExpenseAttachmentRow = {
  id: string
  organization_id: string
  expense_id: string
  kind: ExpenseDocumentKind
  storage_path: string
  file_name: string
  content_type: string
  byte_size: number
  sha256: string | null
  uploaded_by: string | null
  uploaded_at: string
}

/**
 * public.expense_ledger — one cost with its category, vendor, vehicle and
 * contract already resolved. The vehicle on a rental cost is read through the
 * hire, so the two can never disagree.
 */
type ExpenseLedgerRow = {
  id: string
  organization_id: string
  incurred_on: string
  description: string | null
  amount_minor: number
  tax_amount_minor: number
  net_amount_minor: number
  tax_rate_bps: number | null
  tax_label: string | null
  currency: string
  status: ExpenseStatus
  source: ExpenseSource
  allocation: ExpenseAllocation
  payment_method: PaymentMethod | null
  reference: string | null
  notes: string | null
  odometer: number | null
  category_id: string
  category_name: string
  category_system_key: string | null
  category_archived: boolean
  vendor_id: string | null
  vendor_name: string | null
  vendor_archived: boolean
  effective_vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_archived: boolean
  rental_id: string | null
  rental_reference: string | null
  attachment_count: number
  voided_at: string | null
  void_reason: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
}

/** One row per currency: this product never adds two together. */
export type ExpenseSummaryRow = {
  currency: string
  total_minor: number
  overhead_minor: number
  vehicle_minor: number
  rental_minor: number
  tax_minor: number
  expense_count: number
  voided_count: number
}

export type ExpenseCategoryBreakdownRow = {
  category_id: string
  category_name: string
  currency: string
  total_minor: number
  expense_count: number
}

/**
 * Revenue less the costs directly attributable to one vehicle. Excludes agency
 * overhead, financing and depreciation — a contribution, not a profit.
 */
export type VehicleOperatingSummaryRow = {
  currency: string
  rental_revenue_minor: number
  direct_expense_minor: number
  vehicle_expense_minor: number
  rental_expense_minor: number
  operating_contribution_minor: number
  rental_count: number
  expense_count: number
}

export type RentalExpenseSummaryRow = {
  currency: string
  total_minor: number
  expense_count: number
}

export type DuplicateExpenseRow = {
  expense_id: string
  incurred_on: string
  description: string | null
  amount_minor: number
  currency: string
  vendor_name: string | null
  match_reason: string
  match_strength: string
}

/**
 * One material edit: what moved, from what, to what, by whom, when.
 * Written by a trigger; the application can only read it.
 */
type ExpenseChangeEventRow = {
  id: string
  organization_id: string
  expense_id: string
  kind: ExpenseChangeKind
  changes: Record<string, { from: unknown; to: unknown }>
  changed_by: string | null
  changed_at: string
  reason: string | null
}

export type DuplicateVendorRow = {
  vendor_id: string
  name: string
  archived_at: string | null
  match_reason: string
  match_strength: string
}

export type ExpenseUsageRow = {
  expense_count: number
  can_delete: boolean
}

/**
 * One financing arrangement for one vehicle.
 *
 * The nullable money columns are the point of the whole module. A NULL rate,
 * financed amount, instalment or balloon means the agency has not said — which
 * is a different fact from zero, and every total downstream treats it as one.
 */
type FinancingAgreementRow = {
  id: string
  organization_id: string
  vehicle_id: string
  lender_id: string
  agreement_type: FinancingAgreementType
  agreement_status: FinancingAgreementStatus
  mode: FinancingMode
  reference: string | null
  currency: string
  financed_amount_minor: number | null
  down_payment_amount_minor: number | null
  rate_bps: number | null
  installment_amount_minor: number | null
  installments_count: number | null
  payment_frequency: FinancingFrequency
  schedule_anchor_day: number
  balloon_minor: number | null
  starts_on: string
  ends_on: string | null
  first_payment_on: string | null
  payoff_on: string | null
  closure_reason: string | null
  schedule_revision: number
  notes: string | null
  activated_at: string | null
  closed_at: string | null
  closed_by: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
}

type LenderRow = {
  id: string
  organization_id: string
  name: string
  name_normalized: string
  kind: LenderKind
  email: string | null
  phone: string | null
  tax_identifier: string | null
  /** The agreement or customer number quoted to the lender. Never a credential. */
  account_reference: string | null
  address: string | null
  notes: string | null
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
}

type FinancingInstallmentRow = {
  id: string
  organization_id: string
  agreement_id: string
  sequence: number
  due_on: string
  expected_total_minor: number
  /** NULL when the split is unknown, which is normal for a payment plan. */
  expected_principal_minor: number | null
  expected_interest_minor: number | null
  expected_fees_minor: number
  remaining_principal_minor: number | null
  is_balloon: boolean
  revision: number
  created_at: string
}

/** principal + interest + fees + unallocated = amount, enforced by the database. */
type FinancingPaymentRow = {
  id: string
  organization_id: string
  agreement_id: string
  installment_id: string | null
  purpose: FinancingPaymentPurpose
  status: FinancingPaymentStatus
  paid_on: string
  currency: string
  amount_minor: number
  principal_minor: number
  interest_minor: number
  fees_minor: number
  unallocated_minor: number
  method: PaymentMethod | null
  reference: string | null
  notes: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  recorded_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
}

type FinancingDocumentRow = {
  id: string
  organization_id: string
  agreement_id: string
  kind: FinancingDocumentKind
  storage_path: string
  file_name: string
  content_type: string
  byte_size: number
  sha256: string | null
  document_on: string | null
  reference: string | null
  uploaded_by: string | null
  uploaded_at: string
}

type FinancingChangeEventRow = {
  id: string
  organization_id: string
  agreement_id: string
  payment_id: string | null
  kind: FinancingChangeKind
  changes: Record<string, { from: unknown; to: unknown }>
  reason: string | null
  changed_by: string | null
  changed_at: string
}

/** One instalment with what has actually been allocated to it. */
export type FinancingInstallmentStatusRow = {
  id: string
  organization_id: string
  agreement_id: string
  sequence: number
  due_on: string
  expected_total_minor: number
  expected_principal_minor: number | null
  expected_interest_minor: number | null
  expected_fees_minor: number
  remaining_principal_minor: number | null
  is_balloon: boolean
  revision: number
  currency: string
  agreement_status: FinancingAgreementStatus
  paid_minor: number
  principal_paid_minor: number
  interest_paid_minor: number
  fees_paid_minor: number
  unallocated_paid_minor: number
  payment_count: number
  outstanding_minor: number
  is_overdue: boolean
  state: FinancingInstallmentState
}

export type FinancingAgreementOverviewRow = FinancingAgreementRow & {
  vehicle_plate: string
  vehicle_make: string
  vehicle_model: string
  vehicle_archived: boolean
  lender_name: string
  lender_kind: LenderKind
  lender_archived: boolean
  cash_paid_minor: number
  principal_paid_minor: number
  interest_paid_minor: number
  fees_paid_minor: number
  unallocated_minor: number
  payment_count: number
  /** Interest plus fees. Never principal, never the unallocated part. */
  financing_cost_minor: number
  /** False when some payment's composition is unknown. */
  cost_complete: boolean
  /** NULL whenever the arithmetic cannot support a figure. */
  remaining_principal_minor: number | null
  principal_known: boolean
  scheduled_total_minor: number
  remaining_scheduled_minor: number
  overdue_minor: number
  overdue_count: number
  installment_rows: number
  next_due_on: string | null
  next_due_minor: number | null
}

export type FinancingProjectedInstallment = {
  sequence: number
  due_on: string
  expected_total_minor: number
  expected_principal_minor: number | null
  expected_interest_minor: number | null
  remaining_principal_minor: number | null
  is_balloon: boolean
}

export type FinancingDueObligationRow = {
  installment_id: string
  agreement_id: string
  vehicle_id: string
  vehicle_plate: string
  vehicle_make: string
  vehicle_model: string
  lender_name: string
  reference: string | null
  currency: string
  sequence: number
  due_on: string
  expected_total_minor: number
  outstanding_minor: number
  is_balloon: boolean
  is_overdue: boolean
  days_until_due: number
  state: FinancingInstallmentState
}

export type VehicleFinancingSummaryRow = {
  currency: string
  agreement_count: number
  active_agreement_count: number
  cash_paid_minor: number
  principal_paid_minor: number
  interest_paid_minor: number
  fees_paid_minor: number
  unallocated_minor: number
  financing_cost_minor: number
  cost_complete: boolean
  remaining_principal_minor: number | null
  principal_known: boolean
  overdue_minor: number
  next_due_on: string | null
  next_due_minor: number | null
}

export type OrganizationFinancingSummaryRow = {
  currency: string
  agreement_count: number
  active_agreement_count: number
  draft_agreement_count: number
  cash_paid_minor: number
  principal_paid_minor: number
  interest_paid_minor: number
  fees_paid_minor: number
  unallocated_minor: number
  financing_cost_minor: number
  cost_complete: boolean
  remaining_principal_minor: number | null
  /** Active agreements whose balance cannot be derived. Never counted as zero. */
  unknown_principal_count: number
  overdue_minor: number
  overdue_count: number
  due_soon_minor: number
  due_soon_count: number
}

export type DuplicateLenderRow = {
  lender_id: string
  name: string
  archived_at: string | null
  match_reason: string
  match_strength: string
}

export type DuplicateFinancingPaymentRow = {
  payment_id: string
  paid_on: string
  amount_minor: number
  reference: string | null
  match_reason: string
  match_strength: string
}

export type FinancingUsageRow = {
  agreement_count: number
  can_delete: boolean
}

/**
 * A linked telematics account. Carries no credential: the token lives in
 * Supabase Vault and its reference lives in a table the browser cannot name.
 */
type GpsProviderConnectionRow = {
  id: string
  organization_id: string
  provider: GpsProvider
  label: string
  base_url: string
  status: GpsConnectionStatus
  /** Bumped on rotation and disconnect, so a superseded sync cannot report health. */
  generation: number
  account_label: string | null
  unit_count: number | null
  last_verified_at: string | null
  last_sync_started_at: string | null
  last_sync_success_at: string | null
  last_sync_duration_ms: number | null
  last_error_category: string | null
  last_error_message: string | null
  last_error_at: string | null
  disabled_at: string | null
  disabled_by: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
}

type GpsUnitRow = {
  id: string
  organization_id: string
  connection_id: string
  /** Opaque, always text: a provider's integers do not get to lose precision. */
  external_id: string
  name: string
  device_uid: string | null
  hardware: string | null
  availability: GpsUnitAvailability
  capabilities: GpsCapability[]
  metadata: Record<string, unknown>
  first_seen_at: string
  last_seen_at: string
  missing_since: string | null
  created_at: string
  updated_at: string
}

type GpsUnitAssignmentRow = {
  id: string
  organization_id: string
  vehicle_id: string
  unit_id: string
  role: GpsAssignmentRole
  assigned_at: string
  assigned_by: string | null
  unassigned_at: string | null
  unassigned_by: string | null
  note: string | null
}

/** One row per device: the last known position, never a telemetry archive. */
type GpsPositionRow = {
  unit_id: string
  organization_id: string
  observed_at: string
  received_at: string
  latitude: number | null
  longitude: number | null
  position_valid: boolean
  speed_kph: number | null
  heading_deg: number | null
  altitude_m: number | null
  satellites: number | null
  ignition: boolean | null
  movement: GpsMovementState | null
  provider_online: boolean | null
  odometer_km: number | null
  engine_hours: number | null
  metadata: Record<string, unknown>
  updated_at: string
}

type GpsSyncRunRow = {
  id: string
  organization_id: string
  connection_id: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  outcome: GpsSyncOutcome | null
  unit_count: number | null
  position_count: number | null
  skipped_count: number | null
  error_category: string | null
  error_message: string | null
  triggered_by: string | null
}

/**
 * The map and list read model. Carries no customer identity — who is driving is
 * asked of Rentals, separately, when an authorised person opens a panel.
 */
export type GpsFleetRow = {
  vehicle_id: string
  organization_id: string
  vehicle_make: string
  vehicle_model: string
  vehicle_plate: string
  vehicle_archived: boolean
  assignment_id: string
  assigned_at: string
  unit_id: string
  unit_external_id: string
  unit_name: string
  unit_availability: GpsUnitAvailability
  capabilities: GpsCapability[]
  connection_id: string
  connection_label: string
  provider: GpsProvider
  connection_status: GpsConnectionStatus
  observed_at: string | null
  received_at: string | null
  latitude: number | null
  longitude: number | null
  position_valid: boolean | null
  speed_kph: number | null
  heading_deg: number | null
  altitude_m: number | null
  satellites: number | null
  ignition: boolean | null
  movement: GpsMovementState | null
  odometer_km: number | null
  engine_hours: number | null
  /** What the provider says about connectivity. NULL is unknown, not offline. */
  provider_online: boolean | null
  position_freshness: GpsPositionFreshness
  sync_health: GpsSyncHealth
  position_age_seconds: number | null
  current_rental_id: string | null
  current_rental_reference: string | null
  current_rental_ends_at: string | null
  vehicle_status: VehicleStatus
}

export type GpsUnitInventoryRow = {
  id: string
  organization_id: string
  connection_id: string
  connection_label: string
  provider: GpsProvider
  external_id: string
  name: string
  device_uid: string | null
  hardware: string | null
  availability: GpsUnitAvailability
  capabilities: GpsCapability[]
  first_seen_at: string
  last_seen_at: string
  missing_since: string | null
  assignment_id: string | null
  assigned_at: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  last_position_at: string | null
  provider_online: boolean | null
}

export type GpsAttentionSignalRow = {
  signal: 'connection_unhealthy' | 'position_stale' | 'no_position' | 'device_missing'
  severity: 'info' | 'warning' | 'critical'
  vehicle_id: string | null
  vehicle_plate: string | null
  unit_id: string | null
  connection_id: string | null
  detail: string
  since: string | null
}

/** A bounded historical track, fetched through the adapter and never stored. */
export type GpsTrackPoint = {
  observedAt: string
  latitude: number
  longitude: number
  speedKph?: number
  headingDeg?: number
  altitudeM?: number
  satellites?: number
}

export type GpsTrack = {
  points: GpsTrackPoint[]
  totalPoints: number
  truncated: boolean
  from: string
  to: string
}

// -----------------------------------------------------------------------------
// SaaS Billing & Subscriptions
//
// What an agency pays US. Not a rental payment, not a deposit, not a financing
// instalment — those live in their own modules and share nothing with these.
// -----------------------------------------------------------------------------

/** Stripe's own eight subscription statuses, spelled as Stripe spells them. */
export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'

/**
 * What the product does about it — a different question from what Stripe says.
 *
 * `platform_unconfigured` is this deployment today: billing has not launched, so
 * access is normal. It is not a subscription and must never be shown as one.
 * `restricted` is unreachable: no restriction policy has been decided.
 */
export type BillingAccessState = 'platform_unconfigured' | 'normal' | 'attention' | 'restricted'

export type BillingInterval = 'day' | 'week' | 'month' | 'year'

export type StripeMode = 'test' | 'live'

export type BillingEventKind =
  | 'customer_created'
  | 'checkout_started'
  | 'checkout_completed'
  | 'subscription_activated'
  | 'subscription_updated'
  | 'plan_changed'
  | 'payment_failed'
  | 'payment_recovered'
  | 'cancellation_scheduled'
  | 'cancellation_reverted'
  | 'subscription_ended'
  | 'reconciled'
  | 'anomaly_detected'

export type BillingOverviewRow = {
  access_state: BillingAccessState
  platform_configured: boolean
  stripe_configured: boolean
  catalog_configured: boolean
  mode: StripeMode | null

  has_customer: boolean
  billing_email: string | null

  subscription_id: string | null
  status: StripeSubscriptionStatus | null
  plan_key: string | null
  plan_name: string | null
  currency: string | null
  amount_minor: number | null
  billing_interval: BillingInterval | null
  interval_count: number | null
  current_period_start: string | null
  current_period_end: string | null
  cancel_scheduled: boolean
  cancel_effective_at: string | null
  canceled_at: string | null
  ended_at: string | null
  trial_end: string | null
  payment_failed_at: string | null
  latest_invoice_status: string | null
  synced_at: string | null

  pending_checkout: boolean
  pending_checkout_at: string | null

  /** Facts, not limits: nothing enforces a ceiling on either. */
  active_members: number
  active_vehicles: number
}

export type BillingPlanRow = {
  plan_key: string
  display_name: string
  description: string | null
  currency: string
  amount_minor: number
  billing_interval: BillingInterval
  interval_count: number
  entitlements: Json
  is_current: boolean
}

export type BillingHistoryRow = {
  kind: BillingEventKind
  occurred_at: string
  summary: string
  plan_key: string | null
  actor_label: string
}

// -----------------------------------------------------------------------------
// Notifications & Reminders
//
// Nothing here is a sentence. A notification is a typed `kind` plus the facts
// it is about, and the interface writes the words — so wording can change, and
// a second language can be added, without rewriting anything that was stored.
// -----------------------------------------------------------------------------

export type NotificationCategory =
  'rentals' | 'compliance' | 'financing' | 'gps' | 'team' | 'billing'

/** Operational urgency, not decoration. */
export type NotificationSeverity = 'info' | 'attention' | 'urgent'

export type NotificationKind =
  | 'rental_pickup_due'
  | 'rental_return_due'
  | 'rental_return_overdue'
  | 'rental_balance_outstanding'
  | 'vehicle_compliance_due'
  | 'vehicle_compliance_expired'
  | 'financing_due'
  | 'financing_overdue'
  | 'gps_connection_unhealthy'
  | 'gps_position_stale'
  | 'team_invitation_accepted'
  | 'team_ownership_transferred'
  | 'team_role_changed'
  | 'team_member_removed'
  | 'billing_subscription_activated'
  | 'billing_payment_failed'
  | 'billing_payment_recovered'
  | 'billing_cancellation_scheduled'
  | 'billing_subscription_ended'
  | 'billing_plan_changed'
  | 'billing_attention_required'

/** Which slice of the feed to ask for. */
export type NotificationScope = 'active' | 'unread' | 'attention' | 'all'

export type NotificationRow = {
  /**
   * The episode this row is. Deterministic and derived from the source facts,
   * so read state survives a refresh and a materially new episode — a
   * rescheduled pickup, an escalation from due to overdue — gets its own.
   */
  fingerprint: string
  kind: NotificationKind
  category: NotificationCategory
  severity: NotificationSeverity
  subject_id: string | null
  subject_label: string | null
  secondary_id: string | null
  secondary_label: string | null
  /** The business instant this is about, never when the row was generated. */
  occurred_at: string | null
  due_on: string | null
  amount_minor: number | null
  currency: string | null
  action_path: string | null
  context: Json
  read_at: string | null
  dismissed_at: string | null
  snoozed_until: string | null
  total_count: number
}

export type NotificationPreferenceRow = {
  category: NotificationCategory
  muted: boolean
  available: boolean
}

// -----------------------------------------------------------------------------
// Team, invitations & membership
//
// Nothing here carries a token. `create_team_invitation` and
// `resend_team_invitation` return one, once, and it is never stored, never
// listed, and never returned again.
// -----------------------------------------------------------------------------

export type InvitationDelivery =
  | 'pending'
  /** An email API took the message. NOT a claim that anybody received it. */
  | 'accepted_by_provider'
  | 'failed'
  /** No provider configured; an administrator took a one-time link instead. */
  | 'manual_link'
  | 'not_configured'

/** Derived from accepted_at, revoked_at and expires_at. Never stored. */
export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked'

export type TeamEventKind =
  | 'invitation_created'
  | 'invitation_resent'
  | 'invitation_revoked'
  | 'invitation_accepted'
  | 'invitation_link_revealed'
  | 'role_changed'
  | 'member_removed'
  | 'member_left'
  | 'ownership_transferred'

export type TeamMemberRow = {
  user_id: string
  display_name: string
  email: string | null
  role: OrgRole
  joined_at: string
  job_title: string | null
  is_self: boolean
}

export type TeamInvitationRow = {
  id: string
  email: string
  role: OrgRole
  state: InvitationState
  created_at: string
  expires_at: string
  last_sent_at: string | null
  send_count: number
  delivery_state: InvitationDelivery
  delivery_detail: string | null
  invited_by_name: string
  revoke_reason: string | null
  accepted_at: string | null
  /** Null until something has actually been sent. */
  resend_available_at: string | null
  total_count: number
}

export type TeamEventRow = {
  id: string
  event: TeamEventKind
  occurred_at: string
  actor_name: string
  target_name: string
  target_email: string | null
  previous_role: OrgRole | null
  new_role: OrgRole | null
  detail: string | null
  total_count: number
}

export type TeamSeatSummaryRow = {
  active_members: number
  owners: number
  admins: number
  managers: number
  staff: number
  open_invitations: number
  owner_user_id: string | null
}

/** The one-time result of minting or rotating an invitation token. */
export type TeamInvitationIssueRow = {
  invitation_id: string | null
  token: string | null
  expires_at: string | null
  outcome: 'created' | 'reissued' | 'already_member'
}

export type TeamInvitationMessageRow = {
  organization_name: string
  email: string
  role: OrgRole
  invited_by_name: string
  expires_at: string
}

export type AcceptInvitationRow = {
  organization_id: string
  organization_name: string
  role: OrgRole
  outcome: 'joined' | 'already_member'
}

// -----------------------------------------------------------------------------
// Reports & Fleet Analytics
//
// Every money figure below is per currency, because nothing in this product
// converts between them. A row is one currency's answer; two rows are two
// answers, never a total.
// -----------------------------------------------------------------------------

/** Period flows. Revenue is rental-charge cash; deposits are reported apart from it. */
export type ReportBusinessSummaryRow = {
  currency: string
  is_default_currency: boolean
  rental_revenue_minor: number
  rental_charges_in_minor: number
  rental_refunds_out_minor: number
  deposit_in_minor: number
  deposit_out_minor: number
  operating_expense_minor: number
  operating_expense_tax_minor: number
  operating_result_minor: number
  financing_cash_paid_minor: number
  financing_principal_minor: number
  financing_cost_minor: number
  financing_unallocated_minor: number
  /** False when some payment's composition was never stated. Cost is then a floor. */
  financing_cost_complete: boolean
  /** Operating result less financing cash. A management figure, not a profit. */
  after_financing_minor: number
  rental_payment_count: number
  expense_count: number
  financing_payment_count: number
}

/** Balances as at `computed_at`. Deliberately not period-filtered. */
export type ReportPositionSummaryRow = {
  currency: string
  is_default_currency: boolean
  computed_at: string
  outstanding_minor: number
  outstanding_rental_count: number
  deposits_held_minor: number
  deposits_rental_count: number
  /** NULL where the arithmetic cannot support a figure. Never render as zero. */
  remaining_principal_minor: number | null
  principal_known_count: number
  principal_unknown_count: number
  financing_overdue_minor: number
  financing_overdue_count: number
}

export type ReportSeriesRow = {
  bucket_start: string
  rental_revenue_minor: number
  operating_expense_minor: number
  operating_result_minor: number
  financing_cash_minor: number
}

export type ReportFleetRow = {
  vehicle_id: string
  registration_plate: string
  make: string
  model: string
  model_year: number | null
  archived_at: string | null
  acquired_on: string | null
  currency: string
  rental_revenue_minor: number
  vehicle_expense_minor: number
  rental_expense_minor: number
  direct_expense_minor: number
  operating_contribution_minor: number
  currency_conflict: boolean
  financing_cash_minor: number
  financing_cost_minor: number
  financing_cost_complete: boolean
  after_financing_minor: number
  hires_started: number
  hires_completed: number
  rented_days: number
  in_service_days: number
  /** NULL when the vehicle was not in service at all during the window. */
  utilisation_bps: number | null
  distance_units: number
  expense_count: number
  outstanding_minor: number
}

export type ReportUtilisationRow = {
  bucket_start: string
  vehicle_days_available: number
  vehicle_days_rented: number
  hires_started: number
  utilisation_bps: number | null
}

export type ReportExpenseDimension = 'category' | 'vendor' | 'allocation'

export type ReportExpenseRow = {
  dimension_id: string | null
  dimension_key: string | null
  dimension_label: string
  dimension_archived: boolean
  currency: string
  gross_minor: number
  tax_minor: number
  net_minor: number
  expense_count: number
  last_incurred_on: string | null
}

export type ReportRentalOperationsRow = {
  created: number
  confirmed: number
  started: number
  picked_up: number
  returned: number
  completed: number
  cancelled: number
  returned_late: number
  active_now: number
  reserved_now: number
  avg_billable_days: number | null
  avg_actual_hours: number | null
  extensions: number
  cancellation_bps: number | null
}

export type ReportRentalValueRow = {
  currency: string
  completed_count: number
  completed_total_minor: number
  avg_completed_value_minor: number | null
  avg_daily_value_minor: number | null
  revenue_minor: number
}

export type ReportCustomerCohortRow = {
  renters_in_period: number
  first_time_renters: number
  returning_renters: number
  repeat_rate_bps: number | null
  rentals_in_period: number
  rentals_per_renter: number | null
  customers_total: number
}

/** A reporting projection: a name and money, never a contact detail. */
export type ReportCustomerBalanceRow = {
  customer_id: string
  display_name: string
  customer_type: CustomerType
  archived_at: string | null
  currency: string
  rental_count: number
  charged_minor: number
  paid_minor: number
  outstanding_minor: number
  deposits_held_minor: number
  last_rental_starts_at: string | null
  total_rows: number
}

export type ReportCustomerRevenueRow = {
  customer_id: string
  display_name: string
  customer_type: CustomerType
  currency: string
  rental_count: number
  revenue_minor: number
}

export type ReportFinancingRow = {
  agreement_id: string
  reference: string | null
  vehicle_id: string
  registration_plate: string
  vehicle_archived: boolean
  lender_id: string
  lender_name: string
  agreement_type: FinancingAgreementType
  mode: FinancingMode
  currency: string
  cash_paid_minor: number
  principal_paid_minor: number
  financing_cost_minor: number
  unallocated_minor: number
  cost_complete: boolean
  remaining_principal_minor: number | null
  principal_known: boolean
  overdue_minor: number
  overdue_count: number
  next_due_on: string | null
  next_due_minor: number | null
}

/** A stamped snapshot. This deployment has no scheduler, so there is no history. */
export type ReportGpsCoverageRow = {
  computed_at: string
  fresh_minutes: number
  stale_minutes: number
  vehicles_total: number
  vehicles_tracked: number
  vehicles_untracked: number
  positions_fresh: number
  positions_stale: number
  positions_very_stale: number
  positions_future: number
  positions_unknown: number
  link_online: number
  link_offline: number
  /** The provider said nothing. Not the same as offline. */
  link_unreported: number
  devices_total: number
  devices_assigned: number
  devices_spare: number
  devices_missing: number
  connections_total: number
  connections_healthy: number
  last_sync_success_at: string | null
}

export type ReportComplianceRow = {
  document_kind: 'insurance' | 'inspection' | 'registration'
  lead_days: number
  expired: number
  due_soon: number
  valid: number
  /** No date on file. A data gap, counted apart from a breach. */
  unrecorded: number
}

export type OrganizationOverviewRow = {
  currency: string
  time_zone: string
  fleet_total: number
  fleet_available: number
  fleet_rented: number
  fleet_reserved: number
  fleet_maintenance: number
  fleet_unavailable: number
  customers_total: number
  rentals_total: number
  rentals_active: number
  rentals_upcoming: number
  rentals_completed_in_period: number
  revenue_minor: number
  expenses_minor: number
  profit_minor: number
  outstanding_minor: number
  deposits_held_minor: number
  excluded_currency_records: number
}

export type FinancialSeriesRow = {
  bucket_start: string
  revenue_minor: number
  expenses_minor: number
}

/** Columns a client may set on insert; the rest are defaulted or generated. */
type Insertable<Row, Required extends keyof Row, Omitted extends keyof Row = never> = Pick<
  Row,
  Required
> &
  Partial<Omit<Row, Required | Omitted>>

/** Columns a client may change; identity, provenance and generated columns are frozen by triggers. */
type Updatable<Row, Frozen extends keyof Row> = Partial<Omit<Row, Frozen>>

type ManagedColumns = 'created_at' | 'updated_at'
type GeneratedRentalColumns = 'balance_due_minor' | 'payment_status' | 'amount_paid_minor'

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow
        Insert: Insertable<ProfileRow, 'id', ManagedColumns>
        Update: Updatable<ProfileRow, 'id' | ManagedColumns>
        Relationships: []
      }
      organizations: {
        Row: OrganizationRow
        Insert: Insertable<OrganizationRow, 'name' | 'slug', 'id' | ManagedColumns>
        Update: Updatable<OrganizationRow, 'id' | 'slug' | 'created_by' | ManagedColumns>
        Relationships: []
      }
      organization_members: {
        Row: OrganizationMemberRow
        Insert: Insertable<
          OrganizationMemberRow,
          'organization_id' | 'user_id',
          'id' | ManagedColumns
        >
        Update: Updatable<
          OrganizationMemberRow,
          'id' | 'organization_id' | 'user_id' | ManagedColumns
        >
        Relationships: []
      }
      organization_settings: {
        Row: OrganizationSettingsRow
        Insert: Insertable<OrganizationSettingsRow, 'organization_id', ManagedColumns>
        Update: Updatable<OrganizationSettingsRow, 'organization_id' | ManagedColumns>
        Relationships: []
      }
      vehicles: {
        Row: VehicleRow
        Insert: Insertable<
          VehicleRow,
          'organization_id' | 'make' | 'model' | 'registration_plate' | 'currency',
          'id' | ManagedColumns
        >
        Update: Updatable<VehicleRow, 'id' | 'organization_id' | 'created_by' | ManagedColumns>
        Relationships: []
      }
      vehicle_documents: {
        Row: VehicleDocumentRow
        Insert: Insertable<
          VehicleDocumentRow,
          'organization_id' | 'vehicle_id' | 'document_type',
          'id' | ManagedColumns
        >
        Update: Updatable<
          VehicleDocumentRow,
          'id' | 'organization_id' | 'created_by' | ManagedColumns
        >
        Relationships: []
      }
      customer_documents: {
        Row: CustomerDocumentRow
        Insert: Insertable<
          CustomerDocumentRow,
          'organization_id' | 'customer_id' | 'document_type' | 'document_number',
          'id' | 'document_number_normalized' | ManagedColumns
        >
        Update: Updatable<
          CustomerDocumentRow,
          | 'id'
          | 'organization_id'
          | 'customer_id'
          | 'document_number_normalized'
          | 'created_by'
          | ManagedColumns
        >
        Relationships: []
      }
      vehicle_images: {
        Row: VehicleImageRow
        Insert: Insertable<
          VehicleImageRow,
          'organization_id' | 'vehicle_id' | 'storage_path' | 'content_type' | 'byte_size',
          'id' | ManagedColumns
        >
        Update: Updatable<
          VehicleImageRow,
          'id' | 'organization_id' | 'vehicle_id' | 'storage_path' | 'uploaded_by' | ManagedColumns
        >
        Relationships: []
      }
      customers: {
        Row: CustomerRow
        Insert: Insertable<
          CustomerRow,
          'organization_id',
          'id' | 'display_name' | 'phone_normalized' | 'email_normalized' | ManagedColumns
        >
        Update: Updatable<
          CustomerRow,
          | 'id'
          | 'organization_id'
          | 'display_name'
          | 'phone_normalized'
          | 'email_normalized'
          | 'created_by'
          | ManagedColumns
        >
        Relationships: []
      }
      rentals: {
        Row: RentalRow
        Insert: Insertable<
          RentalRow,
          'organization_id' | 'vehicle_id' | 'customer_id' | 'starts_at' | 'ends_at' | 'currency',
          'id' | 'reference' | GeneratedRentalColumns | ManagedColumns
        >
        Update: Updatable<
          RentalRow,
          | 'id'
          | 'organization_id'
          | 'reference'
          | 'created_by'
          | GeneratedRentalColumns
          | ManagedColumns
        >
        Relationships: []
      }
      rental_line_items: {
        Row: RentalLineItemRow
        Insert: Insertable<
          RentalLineItemRow,
          'organization_id' | 'rental_id' | 'description' | 'amount_minor',
          'id' | 'currency' | ManagedColumns
        >
        Update: Updatable<
          RentalLineItemRow,
          'id' | 'organization_id' | 'rental_id' | 'currency' | 'created_by' | ManagedColumns
        >
        Relationships: []
      }
      rental_contracts: {
        Row: RentalContractRow
        Insert: Insertable<
          RentalContractRow,
          'organization_id' | 'rental_id' | 'version' | 'contract_number' | 'snapshot',
          'id' | ManagedColumns
        >
        // Everything identifying the document is restored by a trigger on
        // update; only signature and PDF metadata are meant to be written here.
        Update: Updatable<
          RentalContractRow,
          | 'id'
          | 'organization_id'
          | 'rental_id'
          | 'version'
          | 'contract_number'
          | 'snapshot'
          | 'terms_version'
          | 'issued_at'
          | 'issued_by'
          | ManagedColumns
        >
        Relationships: []
      }
      rental_condition_photos: {
        Row: RentalConditionPhotoRow
        Insert: Insertable<
          RentalConditionPhotoRow,
          'organization_id' | 'rental_id' | 'phase' | 'storage_path' | 'content_type' | 'byte_size',
          'id' | 'uploaded_at'
        >
        Update: never
        Relationships: []
      }
      rental_drivers: {
        Row: RentalDriverRow
        Insert: Insertable<
          RentalDriverRow,
          'organization_id' | 'rental_id' | 'customer_id',
          'id' | ManagedColumns
        >
        Update: Updatable<RentalDriverRow, 'id' | 'organization_id' | 'rental_id' | ManagedColumns>
        Relationships: []
      }
      payments: {
        Row: PaymentRow
        Insert: Insertable<
          PaymentRow,
          'organization_id' | 'amount_minor' | 'currency',
          'id' | ManagedColumns
        >
        Update: Updatable<PaymentRow, 'id' | 'organization_id' | 'recorded_by' | ManagedColumns>
        Relationships: []
      }
      expenses: {
        Row: ExpenseRow
        Insert: Insertable<
          ExpenseRow,
          | 'organization_id'
          | 'category_id'
          | 'allocation'
          | 'amount_minor'
          | 'currency'
          | 'incurred_on',
          'id' | ManagedColumns
        >
        Update: Updatable<
          ExpenseRow,
          | 'id'
          | 'organization_id'
          | 'created_by'
          | 'voided_at'
          | 'voided_by'
          | 'financing_plan_id'
          | ManagedColumns
        >
        Relationships: []
      }
      expense_categories: {
        Row: ExpenseCategoryRow
        Insert: Insertable<ExpenseCategoryRow, 'organization_id' | 'name', 'id' | ManagedColumns>
        Update: Updatable<ExpenseCategoryRow, 'id' | 'organization_id' | ManagedColumns>
        Relationships: []
      }
      expense_vendors: {
        Row: ExpenseVendorRow
        Insert: Insertable<
          ExpenseVendorRow,
          'organization_id' | 'name',
          'id' | 'name_normalized' | ManagedColumns
        >
        Update: Updatable<
          ExpenseVendorRow,
          'id' | 'organization_id' | 'name_normalized' | 'created_by' | ManagedColumns
        >
        Relationships: []
      }
      expense_change_events: {
        Row: ExpenseChangeEventRow
        // Written only by app.record_expense_change(); there is no grant for it.
        Insert: never
        Update: never
        Relationships: []
      }
      expense_attachments: {
        Row: ExpenseAttachmentRow
        Insert: Insertable<
          ExpenseAttachmentRow,
          | 'organization_id'
          | 'expense_id'
          | 'storage_path'
          | 'file_name'
          | 'content_type'
          | 'byte_size',
          'id' | 'uploaded_at'
        >
        Update: never
        Relationships: []
      }
      financing_agreements: {
        Row: FinancingAgreementRow
        Insert: Insertable<
          FinancingAgreementRow,
          | 'organization_id'
          | 'vehicle_id'
          | 'lender_id'
          | 'currency'
          | 'starts_on'
          | 'schedule_anchor_day',
          'id' | ManagedColumns
        >
        Update: Updatable<
          FinancingAgreementRow,
          'id' | 'organization_id' | 'created_by' | ManagedColumns
        >
        Relationships: []
      }
      lenders: {
        Row: LenderRow
        Insert: Insertable<
          LenderRow,
          'organization_id' | 'name',
          'id' | 'name_normalized' | ManagedColumns
        >
        Update: Updatable<
          LenderRow,
          'id' | 'organization_id' | 'name_normalized' | 'created_by' | ManagedColumns
        >
        Relationships: []
      }
      financing_installments: {
        Row: FinancingInstallmentRow
        // Written only by financing_generate_schedule(); the application reads.
        Insert: never
        Update: never
        Relationships: []
      }
      financing_payments: {
        Row: FinancingPaymentRow
        Insert: Insertable<
          FinancingPaymentRow,
          'organization_id' | 'agreement_id' | 'paid_on' | 'currency' | 'amount_minor',
          'id' | ManagedColumns
        >
        Update: Updatable<
          FinancingPaymentRow,
          'id' | 'organization_id' | 'agreement_id' | 'recorded_by' | ManagedColumns
        >
        Relationships: []
      }
      financing_documents: {
        Row: FinancingDocumentRow
        Insert: Insertable<
          FinancingDocumentRow,
          | 'organization_id'
          | 'agreement_id'
          | 'storage_path'
          | 'file_name'
          | 'content_type'
          | 'byte_size',
          'id' | 'uploaded_at'
        >
        Update: never
        Relationships: []
      }
      gps_provider_connections: {
        Row: GpsProviderConnectionRow
        // Created and updated only by the trusted server-side integration.
        Insert: never
        Update: never
        Relationships: []
      }
      gps_units: {
        Row: GpsUnitRow
        Insert: never
        Update: never
        Relationships: []
      }
      gps_unit_assignments: {
        Row: GpsUnitAssignmentRow
        Insert: Insertable<GpsUnitAssignmentRow, 'organization_id' | 'vehicle_id' | 'unit_id', 'id'>
        Update: Updatable<GpsUnitAssignmentRow, 'id' | 'organization_id' | 'vehicle_id' | 'unit_id'>
        Relationships: []
      }
      gps_positions: {
        Row: GpsPositionRow
        // A position is evidence, not an assertion: only trusted server-side
        // code may write one.
        Insert: never
        Update: never
        Relationships: []
      }
      gps_sync_runs: {
        Row: GpsSyncRunRow
        Insert: never
        Update: never
        Relationships: []
      }
      financing_change_events: {
        Row: FinancingChangeEventRow
        // Written only by a trigger; there is no grant for anything else.
        Insert: never
        Update: never
        Relationships: []
      }
      /*
       * `notifications` was removed in 20260822100000. Its replacement is not a
       * table a client reads: conditions are derived on every call and personal
       * state is reached only through typed functions, so there is nothing here
       * to declare.
       */
    }
    Views: {
      vehicle_fleet: {
        Row: VehicleFleetRow
        Relationships: []
      }
      customer_directory: {
        Row: CustomerDirectoryRow
        Relationships: []
      }
      rental_board: {
        Row: RentalBoardRow
        Relationships: []
      }
      rental_schedule: {
        Row: RentalScheduleRow
        Relationships: []
      }
      expense_ledger: {
        Row: ExpenseLedgerRow
        Relationships: []
      }
      financing_agreement_overview: {
        Row: FinancingAgreementOverviewRow
        Relationships: []
      }
      financing_installment_status: {
        Row: FinancingInstallmentStatusRow
        Relationships: []
      }
      gps_fleet: {
        Row: GpsFleetRow
        Relationships: []
      }
      gps_unit_inventory: {
        Row: GpsUnitInventoryRow
        Relationships: []
      }
    }
    Functions: {
      create_organization: {
        Args: {
          p_name: string
          p_country?: string | null
          p_currency?: string | null
          p_time_zone?: string | null
          p_locale?: string | null
        }
        Returns: OrganizationRow
      }
      organization_overview: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: OrganizationOverviewRow[]
      }
      organization_financial_series: {
        Args: {
          p_organization_id: string
          p_from: string
          p_to: string
          p_granularity?: 'day' | 'week' | 'month'
        }
        Returns: FinancialSeriesRow[]
      }
      is_valid_time_zone: {
        Args: { p_time_zone: string }
        Returns: boolean
      }
      fleet_status_counts: {
        Args: { p_organization_id: string }
        Returns: FleetStatusCountsRow[]
      }
      vehicle_usage: {
        Args: { p_vehicle_id: string }
        Returns: VehicleUsageRow[]
      }
      customer_rental_summary: {
        Args: { p_customer_id: string }
        Returns: CustomerRentalSummaryRow[]
      }
      customer_financial_summary: {
        Args: { p_customer_id: string }
        Returns: CustomerFinancialSummaryRow[]
      }
      customer_usage: {
        Args: { p_customer_id: string }
        Returns: CustomerUsageRow[]
      }
      find_customer_duplicates: {
        Args: {
          p_organization_id: string
          p_email?: string | null
          p_phone?: string | null
          p_documents?: Json
          p_exclude_customer_id?: string | null
        }
        Returns: CustomerDuplicateRow[]
      }
      rental_billable_days: {
        Args: { p_starts_at: string; p_ends_at: string }
        Returns: number
      }
      rental_period_conflicts: {
        Args: {
          p_vehicle_id: string
          p_starts_at: string
          p_ends_at: string
          p_exclude_rental_id?: string | null
        }
        Returns: RentalConflictRow[]
      }
      organization_expense_summary: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ExpenseSummaryRow[]
      }
      expense_category_breakdown: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ExpenseCategoryBreakdownRow[]
      }
      vehicle_operating_summary: {
        Args: { p_vehicle_id: string; p_from: string; p_to: string }
        Returns: VehicleOperatingSummaryRow[]
      }
      rental_expense_summary: {
        Args: { p_rental_id: string }
        Returns: RentalExpenseSummaryRow[]
      }
      expense_void: {
        Args: { p_expense_id: string; p_reason?: string | null }
        Returns: ExpenseRow
      }
      find_duplicate_vendors: {
        Args: {
          p_organization_id: string
          p_name: string
          p_tax_identifier?: string | null
          p_exclude_vendor_id?: string | null
        }
        Returns: DuplicateVendorRow[]
      }
      find_duplicate_expenses: {
        Args: {
          p_organization_id: string
          p_vendor_id?: string | null
          p_reference?: string | null
          p_amount_minor?: number | null
          p_currency?: string | null
          p_incurred_on?: string | null
          p_exclude_expense_id?: string | null
        }
        Returns: DuplicateExpenseRow[]
      }
      expense_category_usage: {
        Args: { p_category_id: string }
        Returns: ExpenseUsageRow[]
      }
      financing_annuity_payment: {
        Args: {
          p_financed_minor: number
          p_rate_bps: number
          p_installments: number
          p_frequency: FinancingFrequency
          p_balloon_minor?: number
        }
        Returns: number
      }
      financing_projected_schedule: {
        Args: {
          p_mode: FinancingMode
          p_financed_minor: number | null
          p_rate_bps: number | null
          p_installments: number | null
          p_installment_minor: number | null
          p_first_payment_on: string
          p_anchor_day: number
          p_frequency: FinancingFrequency
          p_balloon_minor?: number
        }
        Returns: FinancingProjectedInstallment[]
      }
      financing_due_obligations: {
        Args: { p_organization_id: string; p_within_days?: number }
        Returns: FinancingDueObligationRow[]
      }
      vehicle_financing_summary: {
        Args: { p_vehicle_id: string; p_from: string; p_to: string }
        Returns: VehicleFinancingSummaryRow[]
      }
      organization_financing_summary: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: OrganizationFinancingSummaryRow[]
      }
      financing_generate_schedule: {
        Args: { p_agreement_id: string }
        Returns: number
      }
      financing_activate_agreement: {
        Args: { p_agreement_id: string }
        Returns: FinancingAgreementRow
      }
      financing_record_payment: {
        Args: {
          p_agreement_id: string
          p_paid_on: string
          p_amount_minor: number
          p_installment_id?: string | null
          p_principal_minor?: number | null
          p_interest_minor?: number | null
          p_fees_minor?: number | null
          p_purpose?: FinancingPaymentPurpose
          p_method?: PaymentMethod | null
          p_reference?: string | null
          p_notes?: string | null
        }
        Returns: FinancingPaymentRow
      }
      financing_void_payment: {
        Args: { p_payment_id: string; p_reason?: string | null }
        Returns: FinancingPaymentRow
      }
      financing_close_agreement: {
        Args: {
          p_agreement_id: string
          p_status: FinancingAgreementStatus
          p_reason?: string | null
          p_payoff_on?: string | null
        }
        Returns: FinancingAgreementRow
      }
      find_duplicate_lenders: {
        Args: {
          p_organization_id: string
          p_name: string
          p_tax_identifier?: string | null
          p_exclude_lender_id?: string | null
        }
        Returns: DuplicateLenderRow[]
      }
      find_duplicate_financing_payments: {
        Args: {
          p_agreement_id: string
          p_paid_on: string
          p_amount_minor: number
          p_reference?: string | null
          p_exclude_payment_id?: string | null
        }
        Returns: DuplicateFinancingPaymentRow[]
      }
      gps_assign_unit: {
        Args: { p_vehicle_id: string; p_unit_id: string; p_note?: string | null }
        Returns: GpsUnitAssignmentRow
      }
      gps_unassign_unit: {
        Args: { p_assignment_id: string }
        Returns: GpsUnitAssignmentRow
      }
      gps_attention_signals: {
        Args: { p_organization_id: string }
        Returns: GpsAttentionSignalRow[]
      }
      gps_resolve_tracked_vehicle: {
        Args: { p_vehicle_id: string }
        Returns: Array<{
          organization_id: string
          vehicle_id: string
          unit_id: string
          unit_external_id: string
          connection_id: string
          provider: GpsProvider
          base_url: string
          connection_status: GpsConnectionStatus
          generation: number
        }>
      }
      lender_usage: {
        Args: { p_lender_id: string }
        Returns: FinancingUsageRow[]
      }
      expense_vendor_usage: {
        Args: { p_vendor_id: string }
        Returns: ExpenseUsageRow[]
      }
      billing_access: {
        Args: { p_organization_id: string }
        Returns: BillingAccessState
      }
      billing_overview: {
        Args: { p_organization_id: string }
        Returns: BillingOverviewRow[]
      }
      billing_available_plans: {
        Args: { p_organization_id: string }
        Returns: BillingPlanRow[]
      }
      billing_history: {
        Args: { p_organization_id: string; p_limit?: number }
        Returns: BillingHistoryRow[]
      }
      billing_set_email: {
        Args: { p_organization_id: string; p_email: string | null }
        Returns: undefined
      }
      notification_feed: {
        Args: {
          p_organization_id: string
          p_scope?: NotificationScope
          p_limit?: number
          p_offset?: number
        }
        Returns: NotificationRow[]
      }
      notification_unread_count: {
        Args: { p_organization_id: string }
        Returns: number
      }
      notification_mark_read: {
        Args: { p_organization_id: string; p_fingerprint: string }
        Returns: void
      }
      notification_mark_all_read: {
        Args: { p_organization_id: string }
        Returns: number
      }
      notification_dismiss: {
        Args: { p_organization_id: string; p_fingerprint: string }
        Returns: void
      }
      notification_snooze: {
        Args: { p_organization_id: string; p_fingerprint: string; p_until: string }
        Returns: void
      }
      notification_preferences_for: {
        Args: { p_organization_id: string }
        Returns: NotificationPreferenceRow[]
      }
      notification_preference_set: {
        Args: {
          p_organization_id: string
          p_category: NotificationCategory
          p_muted: boolean
        }
        Returns: void
      }
      team_directory: {
        Args: { p_organization_id: string }
        Returns: TeamMemberRow[]
      }
      team_invitations: {
        Args: {
          p_organization_id: string
          p_include_history?: boolean
          p_limit?: number
          p_offset?: number
        }
        Returns: TeamInvitationRow[]
      }
      team_events: {
        Args: { p_organization_id: string; p_limit?: number; p_offset?: number }
        Returns: TeamEventRow[]
      }
      team_seat_summary: {
        Args: { p_organization_id: string }
        Returns: TeamSeatSummaryRow[]
      }
      team_invitation_message: {
        Args: { p_invitation_id: string }
        Returns: TeamInvitationMessageRow[]
      }
      create_team_invitation: {
        Args: { p_organization_id: string; p_email: string; p_role: OrgRole }
        Returns: TeamInvitationIssueRow[]
      }
      resend_team_invitation: {
        Args: { p_invitation_id: string }
        Returns: TeamInvitationIssueRow[]
      }
      revoke_team_invitation: {
        Args: { p_invitation_id: string; p_reason?: string | null }
        Returns: void
      }
      record_invitation_delivery: {
        Args: { p_invitation_id: string; p_state: InvitationDelivery; p_detail?: string | null }
        Returns: void
      }
      accept_team_invitation: {
        Args: { p_token: string }
        Returns: AcceptInvitationRow[]
      }
      change_team_member_role: {
        Args: { p_organization_id: string; p_user_id: string; p_role: OrgRole }
        Returns: void
      }
      remove_team_member: {
        Args: { p_organization_id: string; p_user_id: string }
        Returns: void
      }
      leave_organization: {
        Args: { p_organization_id: string }
        Returns: void
      }
      transfer_organization_ownership: {
        Args: { p_organization_id: string; p_user_id: string; p_outgoing_role?: OrgRole }
        Returns: void
      }
      report_business_summary: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ReportBusinessSummaryRow[]
      }
      report_position_summary: {
        Args: { p_organization_id: string }
        Returns: ReportPositionSummaryRow[]
      }
      report_financial_series: {
        Args: {
          p_organization_id: string
          p_from: string
          p_to: string
          p_granularity: string
          p_currency: string
        }
        Returns: ReportSeriesRow[]
      }
      report_fleet_performance: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ReportFleetRow[]
      }
      report_utilisation_series: {
        Args: {
          p_organization_id: string
          p_from: string
          p_to: string
          p_granularity: string
        }
        Returns: ReportUtilisationRow[]
      }
      report_expense_breakdown: {
        Args: {
          p_organization_id: string
          p_from: string
          p_to: string
          p_dimension: ReportExpenseDimension
        }
        Returns: ReportExpenseRow[]
      }
      report_rental_operations: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ReportRentalOperationsRow[]
      }
      report_rental_values: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ReportRentalValueRow[]
      }
      report_customer_cohorts: {
        Args: { p_organization_id: string; p_from: string; p_to: string }
        Returns: ReportCustomerCohortRow[]
      }
      report_customer_balances: {
        Args: {
          p_organization_id: string
          p_currency?: string | null
          p_limit?: number
          p_offset?: number
        }
        Returns: ReportCustomerBalanceRow[]
      }
      report_customer_revenue: {
        Args: { p_organization_id: string; p_from: string; p_to: string; p_limit?: number }
        Returns: ReportCustomerRevenueRow[]
      }
      report_financing_position: {
        Args: { p_organization_id: string }
        Returns: ReportFinancingRow[]
      }
      report_gps_coverage: {
        Args: { p_organization_id: string }
        Returns: ReportGpsCoverageRow[]
      }
      report_compliance_summary: {
        Args: { p_organization_id: string; p_lead_days?: number | null }
        Returns: ReportComplianceRow[]
      }
      rental_is_overdue: {
        Args: { p_status: RentalStatus; p_ends_at: string; p_returned_at: string | null }
        Returns: boolean
      }
      rental_reschedule: {
        Args: {
          p_rental_id: string
          p_starts_at: string
          p_ends_at: string
          p_vehicle_id?: string | null
          p_amend_contract?: boolean
        }
        Returns: RentalRow
      }
      rental_usage: {
        Args: { p_rental_id: string }
        Returns: RentalUsageRow[]
      }
      rental_confirm: {
        Args: { p_rental_id: string }
        Returns: RentalRow
      }
      rental_check_out: {
        Args: {
          p_rental_id: string
          p_odometer: number
          p_fuel_percent?: number | null
          p_notes?: string | null
          p_picked_up_at?: string | null
        }
        Returns: RentalRow
      }
      rental_check_in: {
        Args: {
          p_rental_id: string
          p_odometer: number
          p_fuel_percent?: number | null
          p_notes?: string | null
          p_returned_at?: string | null
        }
        Returns: RentalRow
      }
      rental_complete: {
        Args: { p_rental_id: string }
        Returns: RentalRow
      }
      rental_cancel: {
        Args: { p_rental_id: string; p_reason?: string | null }
        Returns: RentalRow
      }
      rental_extend: {
        Args: {
          p_rental_id: string
          p_new_ends_at: string
          p_charge_minor?: number
          p_charge_description?: string | null
          p_additional_days?: number | null
        }
        Returns: RentalRow
      }
      rental_substitute_vehicle: {
        Args: { p_rental_id: string; p_vehicle_id: string }
        Returns: RentalRow
      }
      rental_record_payment: {
        Args: {
          p_rental_id: string
          p_amount_minor: number
          p_direction: PaymentDirection
          p_purpose: PaymentPurpose
          p_method?: PaymentMethod
          p_paid_at?: string | null
          p_reference?: string | null
          p_notes?: string | null
        }
        Returns: PaymentRow
      }
      rental_void_payment: {
        Args: { p_payment_id: string; p_reason?: string | null }
        Returns: PaymentRow
      }
      rental_issue_contract: {
        Args: { p_rental_id: string; p_reason?: string | null }
        Returns: RentalContractRow
      }
      vehicles_available_between: {
        Args: {
          p_organization_id: string
          p_from: string
          p_to: string
          p_exclude_rental_id?: string | null
        }
        Returns: string[]
      }
    }
    Enums: {
      org_role: OrgRole
      member_status: MemberStatus
      vehicle_status: VehicleStatus
      fuel_type: FuelType
      transmission_type: TransmissionType
      customer_type: CustomerType
      identity_document_type: IdentityDocumentType
      customer_document_type: CustomerDocumentType
      rental_status: RentalStatus
      rental_payment_status: RentalPaymentStatus
      rental_driver_role: RentalDriverRole
      payment_direction: PaymentDirection
      payment_purpose: PaymentPurpose
      payment_method: PaymentMethod
      rental_charge_kind: RentalChargeKind
      rental_condition_phase: RentalConditionPhase
      contract_status: ContractStatus
      expense_category: ExpenseCategory
      expense_allocation: ExpenseAllocation
      expense_status: ExpenseStatus
      expense_source: ExpenseSource
      expense_document_kind: ExpenseDocumentKind
      expense_change_kind: ExpenseChangeKind
      vehicle_document_type: VehicleDocumentType
      vehicle_acquisition_method: VehicleAcquisitionMethod
      lender_kind: LenderKind
      financing_agreement_type: FinancingAgreementType
      financing_agreement_status: FinancingAgreementStatus
      financing_mode: FinancingMode
      financing_frequency: FinancingFrequency
      financing_payment_purpose: FinancingPaymentPurpose
      financing_payment_status: FinancingPaymentStatus
      financing_document_kind: FinancingDocumentKind
      financing_change_kind: FinancingChangeKind
      gps_provider: GpsProvider
      gps_connection_status: GpsConnectionStatus
      gps_unit_availability: GpsUnitAvailability
      gps_movement_state: GpsMovementState
      gps_assignment_role: GpsAssignmentRole
      gps_sync_outcome: GpsSyncOutcome
      notification_category: NotificationCategory
      notification_severity: NotificationSeverity
    }
    CompositeTypes: Record<never, never>
  }
}

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']

export type Organization = Tables<'organizations'>
export type OrganizationMember = Tables<'organization_members'>
export type OrganizationSettings = Tables<'organization_settings'>
export type Profile = Tables<'profiles'>
export type Vehicle = Tables<'vehicles'>
export type Customer = Tables<'customers'>
export type Rental = Tables<'rentals'>
export type Payment = Tables<'payments'>
export type Expense = Tables<'expenses'>
export type FinancingAgreement = Tables<'financing_agreements'>
export type Lender = Tables<'lenders'>
export type FinancingInstallment = Tables<'financing_installments'>
export type FinancingPayment = Tables<'financing_payments'>
export type FinancingDocument = Tables<'financing_documents'>
export type FinancingChangeEvent = Tables<'financing_change_events'>
export type FinancingAgreementOverview =
  Database['public']['Views']['financing_agreement_overview']['Row']
export type FinancingInstallmentStatus =
  Database['public']['Views']['financing_installment_status']['Row']
export type GpsProviderConnection = Tables<'gps_provider_connections'>
export type GpsUnit = Tables<'gps_units'>
export type GpsUnitAssignment = Tables<'gps_unit_assignments'>
export type GpsPosition = Tables<'gps_positions'>
export type GpsSyncRun = Tables<'gps_sync_runs'>
export type GpsFleetEntry = Database['public']['Views']['gps_fleet']['Row']
export type GpsUnitInventory = Database['public']['Views']['gps_unit_inventory']['Row']
export type VehicleDocument = Tables<'vehicle_documents'>
export type VehicleImage = Tables<'vehicle_images'>
export type VehicleFleetEntry = Database['public']['Views']['vehicle_fleet']['Row']
export type CustomerDocument = Tables<'customer_documents'>
export type CustomerDirectoryEntry = Database['public']['Views']['customer_directory']['Row']
export type RentalLineItem = Tables<'rental_line_items'>
export type RentalContract = Tables<'rental_contracts'>
export type RentalConditionPhoto = Tables<'rental_condition_photos'>
export type RentalDriver = Tables<'rental_drivers'>
export type RentalBoardEntry = Database['public']['Views']['rental_board']['Row']
export type RentalScheduleEntry = Database['public']['Views']['rental_schedule']['Row']
export type ExpenseCategoryRecord = Tables<'expense_categories'>
export type ExpenseVendor = Tables<'expense_vendors'>
export type ExpenseAttachment = Tables<'expense_attachments'>
export type ExpenseChangeEvent = Tables<'expense_change_events'>
export type ExpenseLedgerEntry = Database['public']['Views']['expense_ledger']['Row']
export type RentalConflict = RentalConflictRow
