/**
 * Builds a spec-valid EPUB in memory, for testing the EPUB parser against a
 * real archive rather than against a mock of the library that reads it.
 *
 * **Why this exists.** `tests/unit/.../epub-parser.test.ts` mocked `epub2`
 * wholesale and asserted against the mock — including a `parse()` that returned
 * a resolved promise, which the real library does not. So the suite was green
 * while every EPUB ingested in production produced an empty document (#606).
 * A mock can only ever confirm the shape its author believed in; this builds
 * the input the library actually has to read.
 *
 * **Why it writes the ZIP by hand.** The archive has to be constructed
 * independently of the code under test, and the only ZIP implementations in the
 * tree are transitive deps of the EPUB library itself — so reaching for one
 * would couple the fixture to the thing it is meant to check, and break when
 * that dependency changes. It has already earned this: the library was swapped
 * from `epub2` to `epub` (#601/#614) and every test built on this fixture passed
 * unchanged, because none of them knew which library was underneath. The writer
 * supports
 * the two methods an EPUB actually uses: `mimetype` STORED and first, as the
 * spec requires, and everything else DEFLATE, as every real book is.
 *
 * **The DEFLATE part is load-bearing — do not "simplify" it away.** Measured
 * against `epub2@3.0.2` (the library at the time): with a stored-only archive,
 * `parse()` populated `metadata`, `flow` and `toc` synchronously, so the missing
 * `await` was invisible and only half of #606 reproduced. Deflate an entry and
 * the same call returned with all three still empty — the real-book behaviour,
 * and the one that made every ingested EPUB come back as
 * `{ sections: 0, warnings: [] }` with the filename as its title. A stored-only
 * fixture would have let a half-fix pass. The current library does not have that
 * bug, which is exactly why the fixture should keep being able to catch it.
 */

import { crc32, deflateRawSync } from 'zlib';

interface ZipEntry {
  name: string;
  data: Buffer;
  /** DEFLATE this entry rather than storing it. `mimetype` must never be. */
  deflate?: boolean;
}

/** A chapter as authored, before it is rendered to XHTML. */
export interface EpubChapter {
  /** Manifest/spine id, and the id the parser reads back off `flow`. */
  id: string;
  /** Title as it appears in the NCX table of contents. */
  title: string;
  /** Body markup, inserted verbatim inside `<body>`. */
  bodyHtml: string;
}

export interface EpubFixtureOptions {
  title?: string;
  creator?: string;
  language?: string;
  publisher?: string;
  chapters?: EpubChapter[];
  /** Omit the NCX from the manifest and spine — a book with no table of contents. */
  omitToc?: boolean;
}

const DOS_TIME = 0; // Fixed timestamp: the bytes must not vary between runs.

function localHeader(entry: ZipEntry, crc: number, payload: Buffer): Buffer {
  const name = Buffer.from(entry.name, 'utf-8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(entry.deflate ? 8 : 0, 8); // 8 = deflate, 0 = stored
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(payload.length, 18); // compressed size
  header.writeUInt32LE(entry.data.length, 22); // uncompressed size
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, name]);
}

function centralHeader(entry: ZipEntry, crc: number, offset: number, payload: Buffer): Buffer {
  const name = Buffer.from(entry.name, 'utf-8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); // central directory header signature
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0, 8); // flags
  header.writeUInt16LE(entry.deflate ? 8 : 0, 10); // 8 = deflate, 0 = stored
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_TIME, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(payload.length, 20); // compressed size
  header.writeUInt32LE(entry.data.length, 24); // uncompressed size
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30); // extra length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(offset, 42); // local header offset
  return Buffer.concat([header, name]);
}

/**
 * Minimal ZIP writer — STORED or DEFLATE per entry, written in the order given.
 *
 * Both methods are exercised because real EPUBs are deflated while `mimetype`
 * must be stored, and "does the parser survive an inflate step" is not a
 * question a stored-only fixture can answer.
 */
function zipWrite(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // CRC is always over the UNCOMPRESSED bytes, whichever method is used.
    const crc = crc32(entry.data);
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const header = localHeader(entry, crc, payload);
    parts.push(header, payload);
    central.push(centralHeader(entry, crc, offset, payload));
    offset += header.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuf, end]);
}

function xhtml(chapter: EpubChapter): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${chapter.title}</title></head>
<body>
${chapter.bodyHtml}
</body>
</html>`;
}

/** The two chapters used when a test does not care about the contents. */
export const DEFAULT_CHAPTERS: EpubChapter[] = [
  {
    id: 'chapter-one',
    title: 'The First Chapter',
    bodyHtml:
      '<h1>The First Chapter</h1>\n<p>It was a bright cold day in April, and the clocks were striking thirteen.</p>',
  },
  {
    id: 'chapter-two',
    title: 'The Second Chapter',
    bodyHtml:
      '<h1>The Second Chapter</h1>\n<p>The hallway smelt of boiled cabbage and old rag mats.</p>',
  },
];

/**
 * Assemble an EPUB 2 archive as a Buffer.
 *
 * The layout is the ordinary one: `mimetype` first and stored, a
 * `META-INF/container.xml` pointing at `OEBPS/content.opf`, an NCX table of
 * contents, and one XHTML file per chapter.
 */
export function buildEpub(options: EpubFixtureOptions = {}): Buffer {
  const {
    title = 'Sunrise Probe Book',
    creator = 'A Test Author',
    language = 'en',
    publisher = 'Sunrise Press',
    chapters = DEFAULT_CHAPTERS,
    omitToc = false,
  } = options;

  const uid = 'urn:uuid:11111111-2222-3333-4444-555555555555';

  const manifestItems = [
    ...(omitToc ? [] : ['<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>']),
    ...chapters.map(
      (c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`
    ),
  ].join('\n    ');

  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ');

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:creator opf:role="aut">${creator}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:publisher>${publisher}</dc:publisher>
    <dc:identifier id="BookId">${uid}</dc:identifier>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine${omitToc ? '' : ' toc="ncx"'}>
    ${spineItems}
  </spine>
</package>`;

  const navPoints = chapters
    .map(
      (c, i) => `<navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${c.title}</text></navLabel>
      <content src="${c.id}.xhtml"/>
    </navPoint>`
    )
    .join('\n    ');

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uid}"/></head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const entries: ZipEntry[] = [
    // The spec requires `mimetype` first and uncompressed. Everything after it
    // is deflated, which is what a real book looks like.
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf-8') },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml, 'utf-8'), deflate: true },
    { name: 'OEBPS/content.opf', data: Buffer.from(contentOpf, 'utf-8'), deflate: true },
    ...(omitToc
      ? []
      : [{ name: 'OEBPS/toc.ncx', data: Buffer.from(tocNcx, 'utf-8'), deflate: true }]),
    ...chapters.map((c) => ({
      name: `OEBPS/${c.id}.xhtml`,
      data: Buffer.from(xhtml(c), 'utf-8'),
      deflate: true,
    })),
  ];

  return zipWrite(entries);
}
