import { Document, Font, Page, StyleSheet, Text, View } from '@react-pdf/renderer'

import { formatDate, formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import type { ContractSnapshot } from '@/types/database'

import { CHARGE_KIND_LABELS, formatTaxRate } from './pricing'

/**
 * The rental contract, as a real PDF.
 *
 * Rendered by @react-pdf/renderer into actual PDF bytes — not a print
 * stylesheet, not a screenshot. The same component produces the file in the
 * browser (`pdf().toBlob()`) and in Node (`renderToBuffer`), which is what
 * makes the output testable rather than merely visible.
 *
 * Everything it draws comes from the contract snapshot and nothing else. A
 * document that read live rows would silently change whenever a surname was
 * corrected or the fleet was repriced, and last month's signed agreement would
 * start saying something nobody signed.
 *
 * No custom fonts are registered: @react-pdf's built-in Helvetica is embedded
 * by the standard, so a contract renders identically without a network fetch,
 * which a legal document opened three years from now depends on.
 */

/**
 * Words are never broken across lines.
 *
 * The default behaviour splits on hyphens, which turns a registration plate
 * into "12345-" / "A-6" and a licence number into two halves. Those are the
 * fields somebody checks a contract against, so a loose line is the better
 * trade.
 */
Font.registerHyphenationCallback((word) => [word])

const ink = '#101614'
const muted = '#5c6b66'
const rule = '#d5ded9'
const wash = '#f2f6f4'

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontSize: 9,
    fontFamily: 'Helvetica',
    color: ink,
    lineHeight: 1.45,
  },

  masthead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottomWidth: 1.5,
    borderBottomColor: ink,
    paddingBottom: 10,
    marginBottom: 16,
  },
  agencyName: { fontSize: 15, fontFamily: 'Helvetica-Bold', letterSpacing: -0.3 },
  agencyLine: { fontSize: 8, color: muted },
  documentTitle: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.4,
    textAlign: 'right',
  },
  contractNumber: { fontSize: 13, fontFamily: 'Helvetica-Bold', textAlign: 'right', marginTop: 3 },
  issuedLine: { fontSize: 7.5, color: muted, textAlign: 'right', marginTop: 1 },

  sectionHeading: {
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 1.2,
    color: muted,
    marginTop: 14,
    marginBottom: 6,
  },

  columns: { flexDirection: 'row', gap: 18 },
  column: { flex: 1 },

  panel: {
    backgroundColor: wash,
    borderRadius: 3,
    padding: 10,
  },

  row: { flexDirection: 'row', marginBottom: 2 },
  rowLabel: { width: 92, color: muted, fontSize: 8 },
  rowValue: { flex: 1, fontSize: 8.5 },
  rowValueStrong: { flex: 1, fontSize: 8.5, fontFamily: 'Helvetica-Bold' },

  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 0.75,
    borderBottomColor: ink,
    paddingBottom: 3,
    marginBottom: 3,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: rule,
    paddingVertical: 3.5,
  },
  cellDescription: { flex: 1, fontSize: 8.5 },
  cellKind: { width: 84, fontSize: 8, color: muted },
  cellQuantity: { width: 34, fontSize: 8.5, textAlign: 'right' },
  cellAmount: { width: 72, fontSize: 8.5, textAlign: 'right' },
  headCell: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6, color: muted },

  totals: { marginTop: 8, alignItems: 'flex-end' },
  totalRow: {
    flexDirection: 'row',
    width: 220,
    justifyContent: 'space-between',
    paddingVertical: 1.5,
  },
  totalLabel: { fontSize: 8.5, color: muted },
  totalValue: { fontSize: 8.5 },
  grandRow: {
    flexDirection: 'row',
    width: 220,
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: ink,
    marginTop: 4,
    paddingTop: 4,
  },
  grandLabel: { fontSize: 10, fontFamily: 'Helvetica-Bold' },
  grandValue: { fontSize: 10, fontFamily: 'Helvetica-Bold' },
  depositNote: { fontSize: 7.5, color: muted, marginTop: 4, width: 220, textAlign: 'right' },

  terms: { fontSize: 7.5, color: ink, lineHeight: 1.5, textAlign: 'justify' },
  policyTitle: { fontSize: 8, fontFamily: 'Helvetica-Bold', marginTop: 6 },

  signatures: { flexDirection: 'row', gap: 28, marginTop: 22 },
  signatureBox: { flex: 1 },
  signatureLine: { borderTopWidth: 0.75, borderTopColor: ink, marginTop: 34, paddingTop: 4 },
  signatureLabel: { fontSize: 7.5, color: muted },

  footer: {
    position: 'absolute',
    bottom: 26,
    left: 44,
    right: 44,
    borderTopWidth: 0.5,
    borderTopColor: rule,
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 7, color: muted },
})

// -----------------------------------------------------------------------------

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={strong ? styles.rowValueStrong : styles.rowValue}>{value}</Text>
    </View>
  )
}

function joinAddress(parts: ReadonlyArray<string | null>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(', ')
}

function vehicleName(vehicle: ContractSnapshot['vehicle']): string {
  return [vehicle.make, vehicle.model, vehicle.model_year ? `(${vehicle.model_year})` : null]
    .filter(Boolean)
    .join(' ')
}

export interface ContractDocumentProps {
  readonly snapshot: ContractSnapshot
}

export function ContractDocument({ snapshot }: ContractDocumentProps) {
  const { agency, vehicle, renter, drivers, rental, pricing, handover, terms, units } = snapshot
  const locale = agency.locale || 'en'
  const zone = { locale, timeZone: agency.time_zone || 'UTC' }
  const cash = (minor: number) => formatMoney(minor, pricing.currency, { locale })

  const policies: ReadonlyArray<[string, string | null]> = [
    ['Fuel', terms.fuel_policy],
    ['Mileage', terms.mileage_policy],
    ['Late return', terms.late_return_policy],
    ['Damage', terms.damage_policy],
    ['Deposit', terms.deposit_policy],
  ]
  const statedPolicies = policies.filter((entry): entry is [string, string] => Boolean(entry[1]))

  return (
    <Document
      title={`Rental agreement ${snapshot.contract_number}`}
      author={agency.name}
      subject={`${vehicleName(vehicle)} — ${renter.display_name}`}
      creator="Atlas"
      producer="Atlas"
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.masthead} fixed={false}>
          <View>
            <Text style={styles.agencyName}>{agency.legal_name || agency.name}</Text>
            <Text style={styles.agencyLine}>
              {joinAddress([
                agency.address_line1,
                agency.address_line2,
                agency.city,
                agency.region,
                agency.postal_code,
                agency.country_code,
              ])}
            </Text>
            <Text style={styles.agencyLine}>
              {[agency.phone, agency.email, agency.website].filter(Boolean).join('  ·  ')}
            </Text>
            {agency.tax_identifier ? (
              <Text style={styles.agencyLine}>Tax ID {agency.tax_identifier}</Text>
            ) : null}
          </View>

          <View>
            <Text style={styles.documentTitle}>RENTAL AGREEMENT</Text>
            <Text style={styles.contractNumber}>{snapshot.contract_number}</Text>
            <Text style={styles.issuedLine}>
              Issued {formatDateTime(new Date(snapshot.issued_at), zone)}
            </Text>
            {snapshot.version > 1 ? (
              <Text style={styles.issuedLine}>Version {snapshot.version}</Text>
            ) : null}
          </View>
        </View>

        {/* Renter and vehicle */}
        <View style={styles.columns}>
          <View style={styles.column}>
            <Text style={styles.sectionHeading}>RENTER</Text>
            <View style={styles.panel}>
              <Row label="Name" value={renter.display_name} strong />
              {renter.date_of_birth ? (
                <Row
                  label="Date of birth"
                  value={formatDate(new Date(`${renter.date_of_birth}T00:00:00Z`), {
                    ...zone,
                    timeZone: 'UTC',
                  })}
                />
              ) : null}
              {renter.nationality_country_code ? (
                <Row label="Nationality" value={renter.nationality_country_code} />
              ) : null}
              {renter.phone ? <Row label="Phone" value={renter.phone} /> : null}
              {renter.email ? <Row label="Email" value={renter.email} /> : null}
              <Row
                label="Address"
                value={
                  joinAddress([
                    renter.address_line1,
                    renter.address_line2,
                    renter.city,
                    renter.region,
                    renter.postal_code,
                    renter.country_code,
                  ]) || '—'
                }
              />
              {renter.identity_documents.map((document) => (
                <Row
                  key={`${document.document_type}-${document.document_number}`}
                  label={document.document_type === 'passport' ? 'Passport' : 'Identification'}
                  value={[
                    document.document_number,
                    document.issuing_country,
                    document.expires_on ? `expires ${document.expires_on}` : null,
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
                />
              ))}
            </View>
          </View>

          <View style={styles.column}>
            <Text style={styles.sectionHeading}>VEHICLE</Text>
            <View style={styles.panel}>
              <Row label="Vehicle" value={vehicleName(vehicle)} strong />
              <Row label="Registration" value={vehicle.registration_plate} />
              {vehicle.vin ? <Row label="VIN" value={vehicle.vin} /> : null}
              {vehicle.color ? <Row label="Colour" value={vehicle.color} /> : null}
              <Row
                label="Specification"
                value={
                  [
                    vehicle.transmission,
                    vehicle.fuel_type,
                    vehicle.seats ? `${vehicle.seats} seats` : null,
                  ]
                    .filter(Boolean)
                    .join('  ·  ') || '—'
                }
              />
            </View>
          </View>
        </View>

        {/* Period */}
        <Text style={styles.sectionHeading}>HIRE PERIOD</Text>
        <View style={styles.columns}>
          <View style={styles.column}>
            <View style={styles.panel}>
              <Row
                label="Collection"
                value={formatDateTime(new Date(rental.starts_at), zone)}
                strong
              />
              <Row label="From" value={rental.pickup_location || agency.city || '—'} />
            </View>
          </View>
          <View style={styles.column}>
            <View style={styles.panel}>
              <Row label="Return" value={formatDateTime(new Date(rental.ends_at), zone)} strong />
              <Row label="To" value={rental.return_location || rental.pickup_location || '—'} />
            </View>
          </View>
        </View>
        {rental.original_ends_at && rental.original_ends_at !== rental.ends_at ? (
          <Text style={[styles.agencyLine, { marginTop: 4 }]}>
            Extended from {formatDateTime(new Date(rental.original_ends_at), zone)}.
          </Text>
        ) : null}

        {/* Drivers */}
        <Text style={styles.sectionHeading}>AUTHORISED DRIVERS</Text>
        <View>
          <View style={styles.tableHead}>
            <Text style={[styles.cellDescription, styles.headCell]}>DRIVER</Text>
            <Text style={[styles.cellKind, styles.headCell]}>ROLE</Text>
            <Text style={[styles.cellDescription, styles.headCell]}>LICENCE</Text>
            <Text style={[styles.cellAmount, styles.headCell]}>EXPIRES</Text>
          </View>
          {drivers.map((driver) => (
            <View key={driver.customer_id} style={styles.tableRow}>
              <Text style={styles.cellDescription}>{driver.display_name}</Text>
              <Text style={styles.cellKind}>
                {driver.role === 'primary' ? 'Primary' : 'Additional'}
              </Text>
              <Text style={styles.cellDescription}>
                {[
                  driver.license_number ?? '—',
                  driver.license_country,
                  driver.license_classes?.length ? driver.license_classes.join('/') : null,
                ]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
              <Text style={styles.cellAmount}>{driver.license_expires_on ?? '—'}</Text>
            </View>
          ))}
        </View>

        {/* Charges */}
        <Text style={styles.sectionHeading}>CHARGES</Text>
        <View>
          <View style={styles.tableHead}>
            <Text style={[styles.cellKind, styles.headCell]}>TYPE</Text>
            <Text style={[styles.cellDescription, styles.headCell]}>DESCRIPTION</Text>
            <Text style={[styles.cellQuantity, styles.headCell]}>QTY</Text>
            <Text style={[styles.cellAmount, styles.headCell]}>AMOUNT</Text>
          </View>
          {pricing.line_items.map((line, index) => (
            <View key={`${line.kind}-${index}`} style={styles.tableRow}>
              <Text style={styles.cellKind}>{CHARGE_KIND_LABELS[line.kind]}</Text>
              <Text style={styles.cellDescription}>{line.description}</Text>
              <Text style={styles.cellQuantity}>{line.quantity}</Text>
              <Text style={styles.cellAmount}>{cash(line.amount_minor)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Rental</Text>
            <Text style={styles.totalValue}>{cash(pricing.subtotal_minor)}</Text>
          </View>
          {pricing.discount_minor > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Discount</Text>
              <Text style={styles.totalValue}>−{cash(pricing.discount_minor)}</Text>
            </View>
          ) : null}
          {pricing.tax_rate_bps > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                {pricing.tax_label || 'Tax'} ({formatTaxRate(pricing.tax_rate_bps)})
              </Text>
              <Text style={styles.totalValue}>{cash(pricing.tax_minor)}</Text>
            </View>
          ) : null}
          <View style={styles.grandRow}>
            <Text style={styles.grandLabel}>Total</Text>
            <Text style={styles.grandValue}>{cash(pricing.total_minor)}</Text>
          </View>
          {pricing.deposit_minor > 0 ? (
            <Text style={styles.depositNote}>
              Refundable deposit {cash(pricing.deposit_minor)}, held separately and returned on
              settlement.
            </Text>
          ) : null}
        </View>

        {/* Condition */}
        {handover.picked_up_at || handover.returned_at ? (
          <>
            <Text style={styles.sectionHeading}>CONDITION AT HANDOVER</Text>
            <View style={styles.columns}>
              <View style={styles.column}>
                <View style={styles.panel}>
                  <Row
                    label="Collected"
                    value={
                      handover.picked_up_at
                        ? formatDateTime(new Date(handover.picked_up_at), zone)
                        : 'Not yet collected'
                    }
                  />
                  <Row
                    label="Odometer"
                    value={
                      handover.pickup_odometer === null
                        ? '—'
                        : `${handover.pickup_odometer.toLocaleString(locale)} ${units.distance}`
                    }
                  />
                  <Row
                    label="Fuel"
                    value={
                      handover.pickup_fuel_percent === null
                        ? '—'
                        : `${handover.pickup_fuel_percent}%`
                    }
                  />
                  {handover.pickup_condition_notes ? (
                    <Row label="Notes" value={handover.pickup_condition_notes} />
                  ) : null}
                </View>
              </View>
              <View style={styles.column}>
                <View style={styles.panel}>
                  <Row
                    label="Returned"
                    value={
                      handover.returned_at
                        ? formatDateTime(new Date(handover.returned_at), zone)
                        : 'Not yet returned'
                    }
                  />
                  <Row
                    label="Odometer"
                    value={
                      handover.return_odometer === null
                        ? '—'
                        : `${handover.return_odometer.toLocaleString(locale)} ${units.distance}`
                    }
                  />
                  <Row
                    label="Fuel"
                    value={
                      handover.return_fuel_percent === null
                        ? '—'
                        : `${handover.return_fuel_percent}%`
                    }
                  />
                  {handover.return_condition_notes ? (
                    <Row label="Notes" value={handover.return_condition_notes} />
                  ) : null}
                </View>
              </View>
            </View>
          </>
        ) : null}

        {/* Terms — the agency's own words, never generated */}
        {terms.contract_terms || statedPolicies.length > 0 ? (
          <View break={false}>
            <Text style={styles.sectionHeading}>TERMS AND CONDITIONS</Text>
            {statedPolicies.map(([label, text]) => (
              <View key={label}>
                <Text style={styles.policyTitle}>{label}</Text>
                <Text style={styles.terms}>{text}</Text>
              </View>
            ))}
            {terms.contract_terms ? (
              <Text style={[styles.terms, { marginTop: statedPolicies.length > 0 ? 8 : 0 }]}>
                {terms.contract_terms}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.signatures}>
          <View style={styles.signatureBox}>
            <View style={styles.signatureLine}>
              <Text style={styles.signatureLabel}>
                Renter — {renter.display_name}, agreeing to the terms above
              </Text>
            </View>
          </View>
          <View style={styles.signatureBox}>
            <View style={styles.signatureLine}>
              <Text style={styles.signatureLabel}>For {agency.name}</Text>
            </View>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {terms.footer || `${agency.name} — ${snapshot.contract_number}`}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}
