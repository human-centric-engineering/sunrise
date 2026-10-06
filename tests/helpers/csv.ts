/**
 * Split CSV text into records and cells the way a spreadsheet reads it.
 *
 * Quote-aware: a cell is quoted only when its first character is `"`;
 * a CR or LF inside a quoted cell is data, and `""` inside it is one
 * literal quote. A `"` later in an unquoted cell is a literal character,
 * as spreadsheets read it. Outside quotes, CRLF, a lone LF
 * and a lone CR each end a record — Excel, LibreOffice Calc and Google
 * Sheets all accept a bare CR as a record separator, so a test that
 * splits on `\n` or `\r\n` alone cannot see a record the export split
 * by accident (#768). Throws on an unclosed quoted cell rather than
 * folding the rest of the text into it.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;
  // Whether the current record has consumed anything, so a last record
  // holding one empty cell (`""`) is kept rather than dropped.
  let inRecord = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\r' && ch !== '\n') inRecord = true;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
      inRecord = false;
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new Error('parseCsvRecords: unclosed quoted cell');
  if (inRecord) {
    record.push(cell);
    records.push(record);
  }
  return records;
}
