// Client-side PDF rasterization using pdf.js. Renders each page of an uploaded
// case deck to a high-resolution WebP blob (~2x display resolution) so the
// interviewer case viewer can serve crisp per-page images in full screen.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Load a File/Blob into a pdf.js document. Returns the document (has numPages).
export async function loadPdfDocument(file) {
  const data = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data }).promise;
}

// Render a single page to a WebP blob at the given scale (2 = 2x resolution).
export async function renderPageToBlob(pdfDoc, pageNumber, scale = 2) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');

  await page.render({ canvasContext: context, viewport }).promise;

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode page image'))),
      'image/webp',
      0.92
    );
  });

  // Free the canvas.
  canvas.width = 0;
  canvas.height = 0;

  return { blob, width: viewport.width, height: viewport.height };
}
