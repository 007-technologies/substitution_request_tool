const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

let client;

function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: global.appConfig.ANTHROPIC_API_KEY });
  return client;
}

function loadPrompt(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'prompts', name + '.txt'),
    'utf-8'
  );
}

/**
 * Call an async fn with automatic retry on 429 rate-limit errors.
 * Waits the time the API suggests (Retry-After header) or falls back to 65s.
 */
async function withRateLimitRetry(fn, sendProgress) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.status === 429 || (err?.message || '').includes('rate_limit');
      if (!is429 || attempt === MAX_RETRIES) throw err;

      // Pull wait time from error headers or default to 65s
      const retryAfter = parseInt(err?.headers?.['retry-after'] || '65', 10);
      const waitSec = Math.max(retryAfter, 5);

      if (sendProgress) {
        for (let s = waitSec; s > 0; s--) {
          sendProgress(`Rate limit reached — retrying in ${s}s…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      } else {
        await new Promise(r => setTimeout(r, waitSec * 1000));
      }
    }
  }
}

function parseJSON(text) {
  let cleaned = text.trim();

  // Strip markdown fences
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) cleaned = fenced[1];

  // Find the outermost { } or [ ] block
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const block = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (block) cleaned = block[1];
  }

  // Attempt 1: parse as-is
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    // Attempt 2: remove trailing commas before } or ]
    const noTrailing = cleaned.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(noTrailing);
    } catch (e2) {
      // Attempt 3: sanitize unescaped control characters inside string values
      const sanitized = noTrailing.replace(
        /"((?:[^"\\]|\\[\s\S])*)"/g,
        (match, content) =>
          '"' +
          content.replace(/[\x00-\x1F\x7F]/g, (c) => {
            const map = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\b': '\\b' };
            return map[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
          }) +
          '"'
      );
      try {
        return JSON.parse(sanitized);
      } catch (e3) {
        // All attempts failed — throw the original error with context
        throw new Error(
          `Failed to parse Claude response as JSON.\n` +
          `Original error: ${e1.message}\n` +
          `Response preview: ${cleaned.slice(0, 300)}`
        );
      }
    }
  }
}

function normalizeSpecInput(specInput) {
  if (Array.isArray(specInput)) {
    return {
      pages: specInput,
      text: buildClaudeSpecContext(specInput),
    };
  }

  if (specInput && typeof specInput === 'object' && Array.isArray(specInput.pages)) {
    return {
      pages: specInput.pages,
      text: buildClaudeSpecContext(specInput.pages),
    };
  }

  return {
    pages: [],
    text: String(specInput || ''),
  };
}

function buildClaudeSpecContext(pages) {
  return pages
    .map((page) => {
      const pageNumber = page.pageNumber ?? '?';
      const sectionTitle = page.sectionTitle || 'Unknown Section';
      const text = page.text || '';

      return `[PAGE ${pageNumber}]
[SECTION ${sectionTitle}]
${text}`;
    })
    .join('\n\n--- PAGE BREAK ---\n\n');
}

function normalizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s\-./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCitationForText(searchText, pages) {
  if (!searchText || !pages || !pages.length) return null;

  const normalizedNeedle = normalizeSearchText(searchText);
  if (!normalizedNeedle || normalizedNeedle.length < 3) return null;

  const searchVariants = [normalizedNeedle];

  const words = normalizedNeedle
    .split(' ')
    .map((w) => w.trim())
    .filter(Boolean);

  if (words.length >= 2) {
    searchVariants.push(words.slice(0, 2).join(' '));
    searchVariants.push(words.slice(0, 3).join(' '));
  }

  for (const page of pages) {
    const originalText = page.text || '';
    const normalizedPageText = normalizeSearchText(originalText);

    for (const variant of searchVariants) {
      if (!variant || variant.length < 3) continue;

      const index = normalizedPageText.indexOf(variant);
      if (index !== -1) {
        const rawLower = originalText.toLowerCase();
        const rawNeedle = variant.toLowerCase();
        let rawIndex = rawLower.indexOf(rawNeedle);

        if (rawIndex === -1) {
          rawIndex = Math.max(0, Math.floor(originalText.length * (index / Math.max(normalizedPageText.length, 1))));
        }

        const start = Math.max(0, rawIndex - 120);
        const end = Math.min(originalText.length, rawIndex + variant.length + 180);

        const quote = originalText
          .slice(start, end)
          .replace(/\s+/g, ' ')
          .trim();

        return {
          pageNumber: page.pageNumber ?? '?',
          sectionTitle: page.sectionTitle || 'Unknown Section',
          quote,
        };
      }
    }
  }

  return null;
}

function buildSearchCandidates(item) {
  const candidates = [];

  const possibleFields = [
    'specifiedProduct',
    'productName',
    'name',
    'product',
    'material',
    'manufacturer',
    'brand',
    'description',
  ];

  for (const field of possibleFields) {
    if (typeof item[field] === 'string' && item[field].trim()) {
      candidates.push(item[field].trim());
    }
  }

  if (
    typeof item.manufacturer === 'string' &&
    item.manufacturer.trim() &&
    typeof item.productName === 'string' &&
    item.productName.trim()
  ) {
    candidates.unshift(`${item.manufacturer.trim()} ${item.productName.trim()}`);
  }

  return [...new Set(candidates)];
}

function annotateArrayItemsWithCitations(items, pages) {
  return items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }

    const clone = { ...item };

    if (!clone.citations || !Array.isArray(clone.citations) || clone.citations.length === 0) {
      const candidates = buildSearchCandidates(clone);

      for (const candidate of candidates) {
        const citation = findCitationForText(candidate, pages);
        if (citation) {
          clone.citations = [citation];
          break;
        }
      }
    }

    for (const key of Object.keys(clone)) {
      if (Array.isArray(clone[key])) {
        clone[key] = annotateArrayItemsWithCitations(clone[key], pages);
      } else if (clone[key] && typeof clone[key] === 'object') {
        clone[key] = annotateNestedObjectWithCitations(clone[key], pages);
      }
    }

    return clone;
  });
}

function annotateNestedObjectWithCitations(obj, pages) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  const clone = { ...obj };

  for (const key of Object.keys(clone)) {
    if (Array.isArray(clone[key])) {
      clone[key] = annotateArrayItemsWithCitations(clone[key], pages);
    } else if (clone[key] && typeof clone[key] === 'object') {
      clone[key] = annotateNestedObjectWithCitations(clone[key], pages);
    }
  }

  return clone;
}

function annotateExtractedDataWithCitations(parsed, pages) {
  if (!pages || !pages.length) return parsed;

  if (Array.isArray(parsed)) {
    return annotateArrayItemsWithCitations(parsed, pages);
  }

  if (parsed && typeof parsed === 'object') {
    const annotated = annotateNestedObjectWithCitations(parsed, pages);

    if (!annotated.sourcePages || !Array.isArray(annotated.sourcePages)) {
      annotated.sourcePages = pages.map((page) => ({
        pageNumber: page.pageNumber ?? '?',
        sectionTitle: page.sectionTitle || 'Unknown Section',
      }));
    }

    return annotated;
  }

  return parsed;
}

async function extractProducts(specInput, sendProgress) {
  const normalized = normalizeSpecInput(specInput);

  const response = await withRateLimitRetry(() =>
    getClient().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: loadPrompt('extract'),
      messages: [{
        role: 'user',
        content:
          'Please analyze this construction specification text and extract all referenced roofing products and materials. Return the results as JSON.\n\n' +
          normalized.text,
      }],
    }), sendProgress);

  const parsed = parseJSON(response.content[0].text);
  return annotateExtractedDataWithCitations(parsed, normalized.pages);
}

async function matchProducts(extracted, condensedCatalog, documentsList, sendProgress) {
  const userMessage =
    '## Extracted Products from Specification\n' +
    JSON.stringify(extracted, null, 2) +
    '\n\n## Soprema Product Catalog\n' +
    condensedCatalog +
    '\n\n## Available Soprema Documents\n' +
    documentsList +
    '\n\nPlease match each competitor product to the best Soprema replacement. Return the results as JSON.';

  const response = await withRateLimitRetry(() =>
    getClient().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 6144,
      system: loadPrompt('match'),
      messages: [{ role: 'user', content: userMessage }],
    }), sendProgress);

  return parseJSON(response.content[0].text);
}

async function generateSubstitutionRequest(matchedData, projectInfo, sendProgress) {
  const userMessage =
    '## Project Information\n' +
    JSON.stringify(projectInfo, null, 2) +
    '\n\n## Matched Soprema Products\n' +
    JSON.stringify(matchedData, null, 2);

  const response = await withRateLimitRetry(() =>
    getClient().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: loadPrompt('subrequest'),
      messages: [{ role: 'user', content: userMessage }],
    }), sendProgress);

  return parseJSON(response.content[0].text);
}

module.exports = {
  extractProducts,
  matchProducts,
  generateSubstitutionRequest,
};