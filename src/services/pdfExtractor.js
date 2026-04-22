const pdfParse = require('pdf-parse');

const ROOFING_KEYWORDS = [
  'membrane', 'roofing', 'cap sheet', 'base sheet', 'insulation',
  'vapor barrier', 'vapour barrier', 'flashing', 'adhesive', 'primer',
  'fastener', 'coverboard', 'cover board', 'recovery board', 'tapered',
  'sbs', 'app', 'tpo', 'epdm', 'pvc', 'modified bitumen', 'built-up',
  'polyiso', 'polyisocyanurate', 'mineral surface', 'granule surface',
  'siplast', 'johns manville', 'carlisle', 'firestone', 'gaf', 'soprema',
  'henry', 'grace', 'versico', 'mulehide', 'iko', 'polyglass', 'tremco',
  '07 5', '07 6', '07 7', '0750', '0752', '0753', '0754', '0755',
  'section 07', 'division 07',
  'waterproof', 'watertight', 'drainage', 'drain', 'scupper', 'parapet',
  'deck', 'substrate', 'assembly', 'system', 'ply', 'torch', 'heat weld',
  'self-adhered', 'self adhered', 'cold applied', 'hot applied',
  'astm d', 'ul class', 'fm approved', 'class a', 'fire rated',
];

const CHAR_LIMIT = 60000;

function detectSectionTitle(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 15)) {
    if (
      /^\d{2}\s?\d{2}\s?\d{2}/.test(line) ||
      /^\d{2}\s\d{2}\s\d{2}/.test(line) ||
      /^section\s+\d{2}/i.test(line) ||
      /^division\s+\d{2}/i.test(line)
    ) {
      return line;
    }
  }

  return 'Unknown Section';
}

function truncateStructuredPages(pages, charLimit = CHAR_LIMIT) {
  const result = [];
  let totalChars = 0;

  for (const page of pages) {
    const pageOverhead =
      `[PAGE ${page.pageNumber}]\n[SECTION ${page.sectionTitle}]\n`.length;

    if (totalChars + pageOverhead >= charLimit) {
      break;
    }

    const remaining = charLimit - totalChars - pageOverhead;
    if (remaining <= 0) break;

    let text = page.text;
    let truncated = false;

    if (text.length > remaining) {
      text = text.substring(0, remaining).trim();
      truncated = true;
    }

    result.push({
      pageNumber: page.pageNumber,
      sectionTitle: page.sectionTitle,
      text,
      truncated,
    });

    totalChars += pageOverhead + text.length;

    if (truncated) break;
  }

  return result;
}

/**
 * Extract pages from the PDF using pdf-parse's pagerender callback.
 * This gives us the actual PDF page index for every page, which is far more
 * reliable than splitting on \f characters (which many PDFs omit).
 */
async function getRawPages(pdfBuffer) {
  const pageTexts = [];

  const options = {
    pagerender(pageData) {
      return pageData.getTextContent().then((textContent) => {
        // Join text items, preserving line breaks where vertical gap is large
        let lastY = null;
        let text = '';
        for (const item of textContent.items) {
          if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
            text += '\n';
          }
          text += item.str;
          lastY = item.transform[5];
        }
        pageTexts.push({
          pageNumber: pageData.pageIndex + 1,
          text: text.trim(),
        });
        return text;
      });
    },
  };

  let numPages;
  try {
    const data = await pdfParse(pdfBuffer, options);
    numPages = data.numpages || pageTexts.length;
  } catch (err) {
    throw new Error(
      'Could not read PDF: ' +
        err.message +
        '. Make sure the file is a valid, text-based (not scanned) PDF.'
    );
  }

  return { numPages, pageTexts };
}

async function parseRelevantRoofingPages(pdfBuffer) {
  const { numPages, pageTexts } = await getRawPages(pdfBuffer);

  const pages = pageTexts.filter((p) => p.text.length > 40);

  if (pages.length === 0) {
    throw new Error(
      'No readable text found in this PDF. It may be a scanned document. Please use a text-based PDF.'
    );
  }

  const relevantSet = new Set();

  pages.forEach((page, i) => {
    const lower = page.text.toLowerCase();
    const isRelevant = ROOFING_KEYWORDS.some((kw) => lower.includes(kw));

    if (isRelevant) {
      if (i > 0) relevantSet.add(i - 1);
      relevantSet.add(i);
      if (i < pages.length - 1) relevantSet.add(i + 1);
    }
  });

  let selectedPages;

  if (relevantSet.size > 0) {
    const sorted = [...relevantSet].sort((a, b) => a - b);
    selectedPages = sorted.map((i) => pages[i]);
  } else {
    selectedPages = pages;
  }

  const structuredPages = selectedPages.map((page) => ({
    pageNumber: page.pageNumber,
    sectionTitle: detectSectionTitle(page.text),
    text: page.text,
  }));

  const truncatedPages = truncateStructuredPages(structuredPages, CHAR_LIMIT);
  const wasTruncated =
    truncatedPages.length < structuredPages.length ||
    truncatedPages.some((page) => page.truncated);

  return {
    numPages,
    wasTruncated,
    pages: truncatedPages,
  };
}

async function extractRoofingPages(pdfBuffer) {
  const result = await parseRelevantRoofingPages(pdfBuffer);
  return result.pages;
}

async function extractRoofingText(pdfBuffer) {
  const result = await parseRelevantRoofingPages(pdfBuffer);

  let extractedText = result.pages
    .map((page) => {
      return `[PAGE ${page.pageNumber}]\n[SECTION ${page.sectionTitle}]\n${page.text}`;
    })
    .join('\n\n--- PAGE BREAK ---\n\n');

  if (result.wasTruncated) {
    extractedText += `\n\n[Document truncated. Total pages: ${result.numPages}.]`;
  }

  return extractedText;
}

module.exports = {
  extractRoofingText,
  extractRoofingPages,
};