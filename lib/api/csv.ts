/**
 * CSV escaping with formula-injection protection.
 *
 * RFC 4180 quoting rules cover commas, quotes, and newlines — they do
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
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escape a single value for inclusion in a CSV row. Applies both
 * formula-injection neutralisation (leading-character prefix) and
 * RFC 4180 quoting (for commas, quotes, newlines).
 */
export function csvEscape(value: string): string {
  const neutralised =
    value.length > 0 && FORMULA_TRIGGERS.includes(value.charAt(0)) ? `'${value}` : value;
  if (neutralised.includes(',') || neutralised.includes('"') || neutralised.includes('\n')) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}
