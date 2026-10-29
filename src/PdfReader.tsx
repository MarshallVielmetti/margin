import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./pdf-text-layer.css";
GlobalWorkerOptions.workerSrc = worker;

export async function extractPdf(
  file: File,
  progress: (value: string) => void,
) {
  if (file.size > 32 * 1024 * 1024)
    throw new Error("Choose a PDF smaller than 32 MB.");
  const doc = await getDocument({
    data: await file.arrayBuffer(),
    useSystemFonts: true,
  }).promise;
  try {
    if (doc.numPages > 3000)
      throw new Error("Choose a PDF with fewer than 3,000 pages.");
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      progress(`Reading page ${i} of ${doc.numPages}…`);
      const page = await doc.getPage(i),
        content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join(""),
      );
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

export default function PdfReader({
  sourceId,
  page,
}: {
  sourceId: string;
  page: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    layerRef = useRef<HTMLDivElement>(null),
    containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState(""),
    [width, setWidth] = useState(600);
  useEffect(() => {
    let disposed = false;
    const task = getDocument({
      url: `/api/sources/${sourceId}/file`,
      useSystemFonts: true,
    });
    task.promise
      .then((d) => {
        if (!disposed) setDoc(d);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [sourceId]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(240, entries[0].contentRect.width)),
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!doc) return;
    let disposed = false,
      render:
        | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
        | undefined,
      layer: TextLayer | undefined;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (disposed) return;
      const viewport = pdfPage.getViewport({
        scale: width / pdfPage.getViewport({ scale: 1 }).width,
      });
      const canvas = canvasRef.current!,
        container = layerRef.current!;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = viewport.width * ratio;
      canvas.height = viewport.height * ratio;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(viewport.scale));
      container.style.setProperty(
        "--total-scale-factor",
        String(viewport.scale),
      );
      render = pdfPage.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      await render.promise;
      if (disposed) return;
      layer = new TextLayer({
        textContentSource: await pdfPage.getTextContent(),
        container,
        viewport,
      });
      if (disposed) return;
      await layer.render();
    })().catch((e) => {
      if (!disposed && e.name !== "RenderingCancelledException")
        setError(e.message);
    });
    return () => {
      disposed = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [doc, page, width]);
  return (
    <div ref={containerRef} className="pdf-container">
      {error ? (
        <div className="notice">
          PDF preview unavailable: {error}. Switch to extracted text.
        </div>
      ) : (
        <div className="pdf-page">
          <canvas ref={canvasRef} />
          <div ref={layerRef} className="textLayer" />
        </div>
      )}
    </div>
  );
}
