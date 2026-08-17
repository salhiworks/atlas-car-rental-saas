import { describe, expect, it } from 'vitest'

import { PRODUCT_BRAND } from './brand'

/**
 * The three identities, and the line between them.
 *
 * This file exists because the rule is easy to state and easy to erode: the
 * product is Atlas, the publisher is Profit Studio, and the agency is whoever
 * signed in. Only the third ever reaches a renter. A future change that renames
 * the product to the publisher, or quietly drops the attribution, should fail
 * here rather than in somebody's contract.
 */
describe('the product brand', () => {
  it('keeps Atlas as the product and Profit Studio as the publisher', () => {
    expect(PRODUCT_BRAND.name).toBe('Atlas')
    expect(PRODUCT_BRAND.creator).toBe('Profit Studio')
    expect(PRODUCT_BRAND.fullName).toBe('Atlas — Car Rental Management SaaS')
    expect(PRODUCT_BRAND.fullNameWithCreator).toBe(
      'Atlas — Car Rental Management SaaS by Profit Studio',
    )
  })

  it('never folds the publisher into the product name', () => {
    // The names the product must not drift into.
    for (const wrong of [
      'Profit Studio Rental Manager',
      'Profit Studio SaaS',
      'Profit Studio Fleet Manager',
    ]) {
      expect(PRODUCT_BRAND.name).not.toBe(wrong)
      expect(PRODUCT_BRAND.fullName).not.toBe(wrong)
    }
    // The product name stands alone: the credit is a separate field.
    expect(PRODUCT_BRAND.name).not.toContain(PRODUCT_BRAND.creator)
    expect(PRODUCT_BRAND.fullName).not.toContain(PRODUCT_BRAND.creator)
  })

  it('states the credit as an attribution rather than an owner', () => {
    expect(PRODUCT_BRAND.attribution).toBe('by Profit Studio')
    expect(PRODUCT_BRAND.fullNameWithCreator).toContain(PRODUCT_BRAND.fullName)
    expect(PRODUCT_BRAND.fullNameWithCreator).toContain(PRODUCT_BRAND.attribution)
  })

  it('points at a real https home for the publisher', () => {
    const url = new URL(PRODUCT_BRAND.creatorUrl)
    expect(url.protocol).toBe('https:')
    expect(url.hostname).toBe('profitstudio.app')
  })
})
