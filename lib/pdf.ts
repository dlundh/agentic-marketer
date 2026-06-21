import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from './db';

// ---------------------------------------------------------------------------
// Render a structured report to a real PDF on disk and return its path/size.
// Pure-JS (pdfkit), so no native deps or headless browser required.
// ---------------------------------------------------------------------------

export type PdfSection = { heading: string; body: string; bullets?: string[] };

export type PdfDoc = {
  title: string;
  subtitle?: string;
  sections: PdfSection[];
};

const INK = '#1a1a2e';
const ACCENT = '#5b5bd6';
const MUTED = '#6b7280';

export async function renderPdf(doc: PdfDoc, fileId: string): Promise<{ path: string; size: number; name: string }> {
  const safe = doc.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'report';
  const name = `${safe}.pdf`;
  const filePath = path.join(FILES_DIR, `${fileId}-${name}`);

  await new Promise<void>((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
    const stream = createWriteStream(filePath);
    pdf.pipe(stream);

    // Cover header band
    pdf.rect(0, 0, pdf.page.width, 120).fill(ACCENT);
    pdf.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
      .text('MARKET INTELLIGENCE REPORT', 56, 38, { characterSpacing: 1.5 });
    pdf.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
      .text(doc.title, 56, 58, { width: pdf.page.width - 112 });
    pdf.moveDown();
    pdf.y = 150;

    if (doc.subtitle) {
      pdf.fillColor(MUTED).font('Helvetica-Oblique').fontSize(11)
        .text(doc.subtitle, 56, pdf.y, { width: pdf.page.width - 112 });
      pdf.moveDown(1);
    }
    pdf.fillColor(MUTED).fontSize(9).font('Helvetica')
      .text(`Generated ${new Date().toUTCString()}`);
    pdf.moveDown(1.5);

    for (const s of doc.sections) {
      if (pdf.y > pdf.page.height - 140) pdf.addPage();
      pdf.fillColor(ACCENT).font('Helvetica-Bold').fontSize(14).text(s.heading);
      pdf.moveTo(56, pdf.y + 2).lineTo(pdf.page.width - 56, pdf.y + 2).strokeColor('#e5e7eb').stroke();
      pdf.moveDown(0.6);
      if (s.body?.trim()) {
        pdf.fillColor(INK).font('Helvetica').fontSize(10.5).text(s.body, { align: 'left', lineGap: 3 });
        pdf.moveDown(0.5);
      }
      for (const b of s.bullets ?? []) {
        if (pdf.y > pdf.page.height - 90) pdf.addPage();
        pdf.fillColor(ACCENT).font('Helvetica-Bold').text('•', 60, pdf.y, { continued: true })
          .fillColor(INK).font('Helvetica').text('  ' + b, { lineGap: 2 });
      }
      pdf.moveDown(1);
    }

    // Footer page numbers
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf.fillColor(MUTED).fontSize(8).font('Helvetica')
        .text(`Agentic Marketer  ·  page ${i + 1} of ${range.count}`,
          56, pdf.page.height - 40, { width: pdf.page.width - 112, align: 'center' });
    }

    pdf.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

  const { statSync } = await import('node:fs');
  return { path: filePath, size: statSync(filePath).size, name };
}
