/**
 * Who made this, what it is called, and whose name goes on what.
 *
 * THREE IDENTITIES, KEPT APART
 *
 * 1. THE PRODUCT — Atlas. The software an agency signs into. Its name appears
 *    in the shell, on the sign-in screens and in anything that describes how
 *    the software behaves ("Atlas reads positions from your tracking account").
 *
 * 2. THE CREATOR — Profit Studio. Who wrote this and gives it away. Attribution
 *    belongs on the surfaces that are about the software itself: the sign-in
 *    screens, the page that explains how to monetize it, the document metadata,
 *    the README. It is a publisher credit, not a party to anybody's business.
 *
 * 3. THE AGENCY — whoever is using Atlas. Their name, logo, address, tax
 *    identifier and contract wording. This is the identity that appears on
 *    everything a customer of theirs ever sees.
 *
 * THE RULE THAT MATTERS
 *
 * A rental contract is an agreement between an agency and its renter. Neither
 * Atlas nor Profit Studio is a party to it, so neither belongs in it. The same
 * goes for receipts, customer documents and anything else the agency hands over:
 * those carry `organization.name` and the agency's own logo, never a name from
 * this file. A renter in Casablanca has no idea who Profit Studio is and no
 * reason to find them printed on their car hire agreement.
 *
 * The one deliberate exception is PDF metadata: `creator` and `producer` name
 * the software that generated a file, which is what those fields are for, and
 * they say "Atlas" — the product — rather than the publisher.
 *
 * WHY THIS IS A CONSTANT AND NOT A SETTING
 *
 * A deployment may rename the running application with `VITE_APP_NAME`, and
 * `getAppName()` in env.ts honours that, defaulting to the name below. What is
 * NOT configurable is who wrote it: the attribution is a fact about the
 * project's origin, and a build flag that quietly erased it would be the kind of
 * feature nobody should have to ask for.
 */

export const PRODUCT_BRAND = {
  /** The product. Shown wherever the software names itself. */
  name: 'Atlas',
  /** What it is, in one line, for a page title or a store listing. */
  fullName: 'Atlas — Car Rental Management SaaS',
  /** Who made it and gives it away. Never a party to an agency's paperwork. */
  creator: 'Profit Studio',
  creatorUrl: 'https://profitstudio.app',
  /** The publisher credit, ready to sit under a wordmark. */
  attribution: 'by Profit Studio',
  /** Product and publisher together, for a title tag or an about line. */
  fullNameWithCreator: 'Atlas — Car Rental Management SaaS by Profit Studio',
  /** One sentence on what the product does, for metadata and listings. */
  tagline: 'Fleet rental management',
} as const

export type ProductBrand = typeof PRODUCT_BRAND
