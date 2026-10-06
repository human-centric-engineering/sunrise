/**
 * Quote-aware CSV record splitter for export tests.
 *
 * A naive `split('\n')` / `split('\r\n')` cannot tell a correctly quoted
 * multi-line cell from a record that was split by an unquoted line break,
 * so it passes the bug and fails the fix. This walks the text the way a
 * spreadsheet does: a bare CR, a bare LF or a CRLF pair outside quotes
 * ends a record; inside quotes (RFC 4180 §2.6) they are cell data.
 */
export function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endCell = () => {
    record.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
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
      endCell();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || record.length > 0) endRecord();
  return records;
}
