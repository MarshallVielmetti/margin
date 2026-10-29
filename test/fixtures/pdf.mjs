export function pdfFixture() {
  const streams = [
    "BT /F1 18 Tf 55 725 Td (Fixed points and completeness) Tj /F1 12 Tf 0 -45 Td (Definition 1. A contraction mapping) Tj 0 -22 Td (A map shrinks distances in a complete metric space.) Tj 40 -30 Td (d\(Tx,Ty\) <= q d\(x,y\), q < 1) Tj -40 -35 Td (The metric space is complete and the contraction has a fixed point.) Tj ET",
    "BT /F1 18 Tf 55 725 Td (Theorem 2. Existence of a fixed point) Tj /F1 12 Tf 0 -45 Td (A contraction on a complete metric space has a unique fixed point.) Tj 0 -25 Td (The proof uses the contraction in Definition 1.) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  ];
  for (let i = 0; i < 2; i++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(streams[i])} >>\nstream\n${streams[i]}\nendstream`,
    );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
