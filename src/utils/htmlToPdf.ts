import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

interface HtmlToPdfOptions {
  filename: string;
  margin?: number; // inches
  orientation?: "portrait" | "landscape";
  format?: "letter" | "a4";
  scale?: number;
  imageQuality?: number;
}

/**
 * Convert an HTML element to a PDF and trigger download.
 * Uses jsPDF v3 + html2canvas (no vulnerable html2pdf.js).
 */
export async function htmlElementToPdf(
  element: HTMLElement,
  options: HtmlToPdfOptions
): Promise<void> {
  const {
    filename,
    margin = 0.35,
    orientation = "portrait",
    format = "letter",
    scale = 2,
    imageQuality = 0.92,
  } = options;

  const canvas = await html2canvas(element, {
    scale,
    useCORS: true,
    logging: false,
    scrollY: 0,
  });

  const imgData = canvas.toDataURL("image/jpeg", imageQuality);
  const pdf = new jsPDF({ unit: "in", format, orientation });

  const pageW = pdf.internal.pageSize.getWidth() - margin * 2;
  const pageH = pdf.internal.pageSize.getHeight() - margin * 2;
  const imgW = pageW;
  const imgH = (canvas.height * imgW) / canvas.width;

  let yOffset = 0;
  let firstPage = true;

  while (yOffset < imgH) {
    if (!firstPage) pdf.addPage();
    firstPage = false;
    pdf.addImage(imgData, "JPEG", margin, margin - yOffset, imgW, imgH);
    yOffset += pageH;
  }

  pdf.save(filename);
}

/**
 * Convert an HTML element to a PDF Blob (for upload/attachment).
 */
export async function htmlElementToPdfBlob(
  element: HTMLElement,
  options: HtmlToPdfOptions
): Promise<Blob> {
  const {
    margin = 0.35,
    orientation = "portrait",
    format = "letter",
    scale = 2,
    imageQuality = 0.92,
  } = options;

  const canvas = await html2canvas(element, {
    scale,
    useCORS: true,
    logging: false,
    scrollY: 0,
  });

  const imgData = canvas.toDataURL("image/jpeg", imageQuality);
  const pdf = new jsPDF({ unit: "in", format, orientation });

  const pageW = pdf.internal.pageSize.getWidth() - margin * 2;
  const pageH = pdf.internal.pageSize.getHeight() - margin * 2;
  const imgW = pageW;
  const imgH = (canvas.height * imgW) / canvas.width;

  let yOffset = 0;
  let firstPage = true;

  while (yOffset < imgH) {
    if (!firstPage) pdf.addPage();
    firstPage = false;
    pdf.addImage(imgData, "JPEG", margin, margin - yOffset, imgW, imgH);
    yOffset += pageH;
  }

  return pdf.output("blob");
}
