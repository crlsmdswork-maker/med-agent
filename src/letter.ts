// Gera a carta de defesa em PDF (vai como primeira evidência na Woovi).
import PDFDocument from "pdfkit";
import type { WooviDispute } from "./woovi.js";

export function renderDefensePdf(dispute: WooviDispute, letter: string, attachmentList: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(14).text("Defesa em MED: contestação de devolução Pix", { align: "left" });
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("#555")
      .text(`endToEndId: ${dispute.endToEndId}`)
      .text(`Valor: R$ ${(dispute.value / 100).toFixed(2).replace(".", ",")}`)
      .text(`Gerado em: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
    doc.moveDown();
    doc.fillColor("#000").fontSize(11).text(letter, { align: "justify", lineGap: 2 });
    if (attachmentList.length) {
      doc.moveDown();
      doc.fontSize(11).text("Documentos anexos:");
      attachmentList.forEach((a, i) => doc.fontSize(10).text(`${i + 1}. ${a}`));
    }
    doc.end();
  });
}
