/**
 * Split CSV text into records and cells the way a spreadsheet reads it.
 *
 * Quote-aware: a CR or LF inside a double-quoted cell is data, and `""`
 * inside quotes is one literal quote. Outside quotes, CRLF, a lone LF
 * and a lone CR each end a record — Excel, LibreOffice Calc and Google
 * Sheets all accept a bare CR as a record separator, so a test that
 * splits on `\n` or `\r\n` alone cannot see a record the export split
 * by accident (#768).
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
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
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}
