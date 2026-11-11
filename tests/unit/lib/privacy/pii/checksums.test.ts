/**
 * The checks tier A relies on to report an identifier at full confidence.
 * Each is tested against values known to be valid and values known to fail,
 * including a single changed digit, which is the case a checksum exists for.
 */
import { describe, expect, it } from 'vitest';
import {
  isPlausibleUkDrivingLicence,
  isValidCardNumber,
  isValidIban,
  isValidNhsNumber,
  isValidNino,
  isValidUkVat,
  passesLuhn,
} from '@/lib/privacy/pii/checksums';

describe('isValidNhsNumber', () => {
  it.each(['9434765919', '6999100438', '4505577104'])('accepts %s', (n) => {
    expect(isValidNhsNumber(n)).toBe(true);
  });

  it.each([
    ['9434765918', 'last digit changed'],
    ['9434765910', 'last digit changed'],
    ['6999100439', 'last digit changed'],
    ['1234567890', 'check digit would be 10, never issued'],
    ['943476591', 'nine digits'],
    ['94347659190', 'eleven digits'],
    ['943 476 5919', 'separators not removed'],
    ['943476591a', 'not a digit'],
  ])('rejects %s (%s)', (n) => {
    expect(isValidNhsNumber(n)).toBe(false);
  });

  it('accepts a check digit of 0, which a remainder of 11 maps to', () => {
    // 1·10+0·9+…: chosen so 11 - (sum % 11) === 11.
    expect(isValidNhsNumber('4010232137')).toBe(true);
  });
});

describe('passesLuhn and isValidCardNumber', () => {
  it.each([
    '4111111111111111', // Visa
    '4012888888881881', // Visa
    '5555555555554444', // Mastercard
    '2223003122003222', // Mastercard 2-series
    '378282246310005', // Amex
    '6011111111111117', // Discover
    '3566002020360505', // JCB
  ])('accepts the test card %s', (n) => {
    expect(passesLuhn(n)).toBe(true);
    expect(isValidCardNumber(n)).toBe(true);
  });

  it.each([
    ['4111111111111112', 'last digit changed'],
    ['5555555555554443', 'last digit changed'],
    ['378282246310006', 'last digit changed'],
  ])('rejects %s (%s)', (n) => {
    expect(passesLuhn(n)).toBe(false);
    expect(isValidCardNumber(n)).toBe(false);
  });

  it('rejects a Luhn-valid number that belongs to no card scheme', () => {
    // 1 is not a scheme prefix: this is an order reference that happens to pass.
    expect(passesLuhn('1234567812345670')).toBe(true);
    expect(isValidCardNumber('1234567812345670')).toBe(false);
  });

  it('rejects a scheme prefix at a length that scheme does not issue', () => {
    // Amex is 15 digits; a Luhn-valid 16-digit 37… is not an Amex.
    expect(passesLuhn('3782822463100052')).toBe(true);
    expect(isValidCardNumber('3782822463100052')).toBe(false);
  });

  it('rejects input that is not digits', () => {
    expect(passesLuhn('4111-1111')).toBe(false);
    expect(passesLuhn('7')).toBe(false);
    expect(isValidCardNumber('4111 1111 1111 1111')).toBe(false);
  });
});

describe('isValidIban', () => {
  it.each([
    'GB82WEST12345698765432',
    'GB50MIDL40756734478723',
    'DE89370400440532013000',
    'FR1420041010050500013M02606',
    'IE29AIBK93115212345678',
    'NO9386011117947', // the shortest in the table
  ])('accepts %s', (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it.each([
    ['GB82WEST12345698765433', 'last digit changed'],
    ['GB83WEST12345698765432', 'check digits changed'],
    ['DE89370400440532013001', 'last digit changed'],
    ['GB82WEST1234569876543', 'one short for GB'],
    ['GB82WEST123456987654321', 'one long for GB'],
    ['gb82west12345698765432', 'lower case'],
    ['GB82 WEST 1234 5698 7654 32', 'separators not removed'],
  ])('rejects %s (%s)', (iban) => {
    expect(isValidIban(iban)).toBe(false);
  });

  it('checks a country not in the length table by its checksum alone', () => {
    // Brazil (BR) is not in IBAN_LENGTHS; its example IBAN is 29 characters.
    expect(isValidIban('BR1800360305000010009795493C1')).toBe(true);
    expect(isValidIban('BR1800360305000010009795493C2')).toBe(false);
  });
});

describe('isValidNino', () => {
  it.each(['AB123456C', 'TJ331536A', 'EP509054B', 'AB123456'])('accepts %s', (n) => {
    expect(isValidNino(n)).toBe(true);
  });

  it.each([
    ['DA123456C', 'D is never a first letter'],
    ['QQ123456C', 'Q is never used (HMRC documentation example)'],
    ['AO123456C', 'O is never a second letter'],
    ['GB123456C', 'GB prefix never issued'],
    ['ZZ123456C', 'ZZ prefix never issued'],
    ['AB123456E', 'suffix beyond D'],
    ['AB12345C', 'five digits'],
    ['ab123456c', 'lower case'],
  ])('rejects %s (%s)', (n) => {
    expect(isValidNino(n)).toBe(false);
  });
});

describe('isValidUkVat', () => {
  it('accepts a number valid under the older modulus 97 series', () => {
    // HMRC's documentation example: 8·9+7·9+…+2·9 = 315, + 73 = 388 = 4·97.
    expect(isValidUkVat('999999973')).toBe(true);
  });

  it('accepts a number valid under the 9755 series issued since 2010', () => {
    expect(isValidUkVat('086832870')).toBe(true);
  });

  it('accepts a twelve-digit branch number by its first nine', () => {
    expect(isValidUkVat('999999973001')).toBe(true);
  });

  it.each([
    ['999999974', 'last digit changed'],
    ['086832871', 'last digit changed'],
    ['99999997', 'eight digits'],
    ['9999999730', 'ten digits'],
  ])('rejects %s (%s)', (n) => {
    expect(isValidUkVat(n)).toBe(false);
  });
});

describe('isPlausibleUkDrivingLicence', () => {
  it('accepts a licence whose encoded date is possible', () => {
    expect(isPlausibleUkDrivingLicence('MORGA753116SM9IJ')).toBe(true);
  });

  it("accepts a woman's licence, whose month has 50 added", () => {
    expect(isPlausibleUkDrivingLicence('MORGA757116SM9IJ')).toBe(true);
  });

  it.each([
    ['MORGA713116SM9IJ', 'month 13'],
    ['MORGA700116SM9IJ', 'month 00'],
    ['MORGA753326SM9IJ', 'day 32'],
    ['MORGA753006SM9IJ', 'day 00'],
    ['MORGA763116SM9IJ', 'month 63'],
    ['MORGA753116SM9I', 'fifteen characters'],
  ])('rejects %s (%s)', (n) => {
    expect(isPlausibleUkDrivingLicence(n)).toBe(false);
  });
});
