/**
 * CSV escaping with formula-injection protection.
 *
 * RFC 4180 quoting rules cover commas, quotes, and line breaks — they do
 * NOT cover the leading characters spreadsheet applications interpret
 * as the start of a formula. Excel, LibreOffice Calc and Google Sheets
 * all evaluate cells that begin with `=`, `+`, `-`, `@`, tab (`\t`) or
 * carriage return (`\r`), which lets a malicious value placed anywhere
 * in an exported CSV invoke `HYPERLINK()` for data exfiltration,
 * `cmd|...!A1` for OS command execution on Windows + DDE-enabled
 * spreadsheets, or any number of other side-channels.
 *
 * Mitigation: prefix any cell whose first character is one of those
 * triggers with a single quote. The leading quote is treated as a
 * literal text marker by every major spreadsheet and is rendered as
 * the original string when the cell is read by a CSV parser.
 *
 * The prefix only inspects a cell's first character, so a line break in
 * the middle of an unquoted cell would let the submitter start a record
 * (and a cell) of their own. Spreadsheets treat a lone CR as a record
 * break, so `\r` is quoted exactly like `\n`: inside quotes it is cell
 * data (RFC 4180 §2.6) and a later `=` is mid-cell, which nothing evaluates.
 *
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escape a single value for inclusion in a CSV row. Applies both
 * formula-injection neutralisation (leading-character prefix) and
 * RFC 4180 quoting (for commas, quotes, CR/LF).
 */
export function csvEscape(value: string): string {
  const neutralised =
    value.length > 0 && FORMULA_TRIGGERS.includes(value.charAt(0)) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}
