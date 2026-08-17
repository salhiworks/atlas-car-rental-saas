import { describe, expect, it } from 'vitest'

import {
  CurrencyMismatchError,
  addMoney,
  formatMoney,
  getCurrencyFractionDigits,
  minorToDecimalString,
  money,
  multiplyMoney,
  parseMoneyToMinor,
  subtractMoney,
  sumMoney,
} from './money'

describe('currency precision', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['MAD', 2],
    ['JPY', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['TND', 3],
  ])('knows %s has %i minor digits', (currency, digits) => {
    expect(getCurrencyFractionDigits(currency)).toBe(digits)
  })

  it('falls back to two digits for an unknown code', () => {
    expect(getCurrencyFractionDigits('ZZZ')).toBe(2)
  })
})

describe('arithmetic', () => {
  it('adds and subtracts without floating point drift', () => {
    // The canonical float failure: 0.1 + 0.2 !== 0.3.
    const total = addMoney(money(10, 'EUR'), money(20, 'EUR'))
    expect(total.amountMinor).toBe(30)

    // A thousand ten-cent payments must come to exactly 100.00.
    const payments = Array.from({ length: 1000 }, () => money(10, 'EUR'))
    expect(sumMoney(payments, 'EUR').amountMinor).toBe(10_000)
  })

  it('refuses to combine different currencies', () => {
    expect(() => addMoney(money(100, 'EUR'), money(100, 'USD'))).toThrow(CurrencyMismatchError)
    expect(() => subtractMoney(money(100, 'EUR'), money(100, 'MAD'))).toThrow(CurrencyMismatchError)
  })

  it('rounds a multiplication half away from zero', () => {
    // 4 days at 12.505 per day would be a fraction of a cent.
    expect(multiplyMoney(money(1250, 'EUR'), 1.5).amountMinor).toBe(1875)
    expect(multiplyMoney(money(333, 'EUR'), 3).amountMinor).toBe(999)
    expect(multiplyMoney(money(1, 'EUR'), 0.5).amountMinor).toBe(1)
    expect(multiplyMoney(money(-1, 'EUR'), 0.5).amountMinor).toBe(-1)
  })

  it('rejects a non-integer amount outright', () => {
    expect(() => money(12.5, 'EUR')).toThrow(TypeError)
  })

  it('rejects an amount beyond safe integer precision', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'EUR')).toThrow()
  })
})

describe('parsing what people actually type', () => {
  it.each([
    ['1234.56', 'EUR', 123456],
    ['1,234.56', 'EUR', 123456],
    ['1 234,56', 'EUR', 123456],
    ['1.234,56', 'EUR', 123456],
    ['€12.30', 'EUR', 1230],
    ['12', 'EUR', 1200],
    ['0.05', 'EUR', 5],
    ['.5', 'EUR', 50],
    ['-45', 'EUR', -4500],
    ['1500', 'JPY', 1500],
    ['1500.7', 'JPY', 1501],
    ['12.345', 'KWD', 12345],
  ])('parses %s as %s -> %i minor units', (input, currency, expected) => {
    expect(parseMoneyToMinor(input, currency)).toBe(expected)
  })

  it('reads a separator before exactly three digits as grouping in a two-decimal currency', () => {
    // "1,500" and "1.500" almost always mean one thousand five hundred.
    expect(parseMoneyToMinor('1,500', 'EUR')).toBe(150_000)
    expect(parseMoneyToMinor('1.500', 'EUR')).toBe(150_000)
    expect(parseMoneyToMinor('1,50', 'EUR')).toBe(150)
  })

  it('reads the same shape as a fraction in a three-decimal currency', () => {
    // KWD has three minor digits, so "12.345" is twelve dinars 345 fils.
    expect(parseMoneyToMinor('12.345', 'KWD')).toBe(12_345)
    expect(parseMoneyToMinor('12.345', 'EUR')).toBe(1_234_500)
  })

  it('rounds excess precision half-up rather than truncating', () => {
    expect(parseMoneyToMinor('1.0050', 'EUR')).toBe(101)
    expect(parseMoneyToMinor('1.0049', 'EUR')).toBe(100)
    expect(parseMoneyToMinor('9.9990', 'EUR')).toBe(1000)
    expect(parseMoneyToMinor('1.2345', 'KWD')).toBe(1235)
  })

  it.each([[''], ['   '], ['abc'], ['--']])('returns null for unusable input %s', (input) => {
    expect(parseMoneyToMinor(input, 'EUR')).toBeNull()
  })

  it('round-trips through the decimal string form', () => {
    for (const amount of [0, 1, 99, 100, 123456, -4500]) {
      const text = minorToDecimalString(amount, 'EUR')
      expect(parseMoneyToMinor(text, 'EUR')).toBe(amount)
    }
  })
})

describe('decimal string rendering', () => {
  it.each([
    [123456, 'EUR', '1234.56'],
    [5, 'EUR', '0.05'],
    [0, 'EUR', '0.00'],
    [-4500, 'EUR', '-45.00'],
    [1500, 'JPY', '1500'],
    [12345, 'KWD', '12.345'],
  ])('renders %i %s as %s', (amount, currency, expected) => {
    expect(minorToDecimalString(amount, currency)).toBe(expected)
  })
})

describe('display formatting', () => {
  it('places the amount at the right scale for the currency', () => {
    // Exact symbol and separator placement is Intl's business and varies by
    // platform; the digits are ours.
    expect(formatMoney(123456, 'EUR', { locale: 'en' })).toContain('1,234.56')
    expect(formatMoney(1500, 'JPY', { locale: 'en' })).toContain('1,500')
    expect(formatMoney(12345, 'KWD', { locale: 'en' })).toContain('12.345')
  })

  it('omits the symbol when asked, for input adornments', () => {
    const formatted = formatMoney(123456, 'EUR', { locale: 'en', withoutSymbol: true })
    expect(formatted).toBe('1,234.56')
  })

  it('still renders a figure for an unrecognised currency code', () => {
    const formatted = formatMoney(123456, 'ZZZ', { locale: 'en' })
    expect(formatted).toContain('1,234.56')
    expect(formatted).toContain('ZZZ')
  })
})
