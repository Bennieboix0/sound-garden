import { zlibSync } from 'fflate';

/** A4 in PostScript points; scanned pages are fitted into this box. */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

export type PdfImagePage =
  /** 1 bit per pixel, MSB first, rows byte-aligned. Deflated here. */
  | { kind: 'bitonal'; width: number; height: number; data: Uint8Array }
  /** Raw JPEG bytes, embedded directly with DCTDecode. */
  | { kind: 'jpeg'; width: number; height: number; data: Uint8Array };

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Escapes a string for a PDF literal-string token. */
function pdfString(text: string): string {
  const cleaned = text.replace(/[\\()\r\n]/g, (ch) =>
    ch === '\r' || ch === '\n' ? ' ' : `\\${ch}`,
  );
  // Keep to ASCII; anything else risks needing a full encoding declaration.
  return `(${cleaned.replace(/[^\x20-\x7e]/g, '?')})`;
}

function pdfDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * Writes a PDF with one image per page.
 *
 * Hand-rolled rather than pulling in a PDF library: the file this needs to
 * produce is about as simple as PDFs get — a catalog, a page tree, and one
 * image XObject per page — and a scanning feature is not worth several hundred
 * kilobytes in a bundle that has to be precached for offline use.
 */
export function imagesToPdf(
  pages: PdfImagePage[],
  meta: { title?: string; author?: string } = {},
): Blob {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  const chunks: Uint8Array[] = [];
  let length = 0;
  /** Byte offset of each object, indexed by object number. */
  const offsets: number[] = [];
  let nextObject = 1;

  const write = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? ascii(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };

  const reserve = () => nextObject++;

  const beginObject = (number: number) => {
    offsets[number] = length;
    write(`${number} 0 obj\n`);
  };

  const catalogRef = reserve();
  const pagesRef = reserve();
  const infoRef = reserve();
  const pageRefs = pages.map(() => ({
    page: reserve(),
    contents: reserve(),
    image: reserve(),
  }));

  write('%PDF-1.4\n');
  // A binary comment marks the file as containing 8-bit data.
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(catalogRef);
  write(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>\nendobj\n`);

  beginObject(pagesRef);
  write(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs
      .map((r) => `${r.page} 0 R`)
      .join(' ')}] >>\nendobj\n`,
  );

  beginObject(infoRef);
  write(
    `<< /Producer (Sound Garden) /Creator (Sound Garden scanner)` +
      (meta.title ? ` /Title ${pdfString(meta.title)}` : '') +
      (meta.author ? ` /Author ${pdfString(meta.author)}` : '') +
      ` /CreationDate ${pdfString(pdfDate(new Date()))} >>\nendobj\n`,
  );

  pages.forEach((page, index) => {
    const refs = pageRefs[index];

    // Fit the image into an A4 box, preserving its own aspect ratio.
    const scale = Math.min(A4_WIDTH / page.width, A4_HEIGHT / page.height);
    const pageWidth = +(page.width * scale).toFixed(2);
    const pageHeight = +(page.height * scale).toFixed(2);

    beginObject(refs.page);
    write(
      `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /XObject << /Im0 ${refs.image} 0 R >> >> ` +
        `/Contents ${refs.contents} 0 R >>\nendobj\n`,
    );

    // Scale the unit image square up to fill the page.
    const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObject(refs.contents);
    write(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    const body =
      page.kind === 'bitonal' ? zlibSync(page.data, { level: 9 }) : page.data;
    const imageDict =
      page.kind === 'bitonal'
        ? `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${body.length} >>`
        : `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${body.length} >>`;

    beginObject(refs.image);
    write(`${imageDict}\nstream\n`);
    write(body);
    write('\nendstream\nendobj\n');
  });

  const xrefOffset = length;
  const total = nextObject;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  write(xref);
  write(
    `trailer\n<< /Size ${total} /Root ${catalogRef} 0 R /Info ${infoRef} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

/** Encodes a canvas as JPEG bytes for embedding. */
export async function canvasToJpegBytes(
  canvas: HTMLCanvasElement,
  quality = 0.86,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('Could not encode the page as JPEG.');
  return new Uint8Array(await blob.arrayBuffer());
}
