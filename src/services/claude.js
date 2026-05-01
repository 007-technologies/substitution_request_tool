const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

let client;

// Resolve the Anthropic API key in priority order:
//   1. User-supplied key (saved via Settings → Manage API key) — for BYO
//      enterprise customers who want billing on their own Anthropic account
//   2. Bundled key from config.json — the default for Reed-hosted customers
//   3. Empty string — getClient() will throw on first call, surfacing a
//      clear "no API key configured" error to the renderer
//
// Why prefer user-supplied: an enterprise customer who has set a key has
// explicitly opted into BYO billing. Their key wins even if a bundled
// fallback is present.
function resolveApiKey() {
  try {
    const userKeyFile = path.join(global.dataDir || '', 'user-api-key.json');
    if (userKeyFile && fs.existsSync(userKeyFile)) {
      const raw = fs.readFileSync(userKeyFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
        return parsed.apiKey.trim();
      }
    }
  } catch (_) { /* corrupt file — fall through to bundled */ }
  return (global.appConfig && global.appConfig.ANTHROPIC_API_KEY) || '';
}

function getClient() {
  if (client) return client;
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error('No Anthropic API key configured. Open Settings → Manage API key to add one.');
  }
  client = new Anthropic({ apiKey });
  return client;
}

// Resets the cached client. Called after the user saves a new API key so
// the next request picks up the change without an app restart.
function resetClient() {
  client = null;
}

// Per-run cost telemetry. Logs each Claude call with token counts and an
// approximate dollar estimate so we can see what each Skyfall iteration costs
// without leaving the dev console open. Keeps a session-wide running total.
const PRICING_PER_MTOK = {
  // Sonnet 4 — input $3 / output $15 per MTok
  'claude-sonnet-4-20250514': { in: 3.0, out: 15.0 },
  // Haiku 4.5 — input $1 / output $5 per MTok
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
};

const sessionTotals = { in: 0, out: 0, cost: 0 };

function logUsage(label, model, usage) {
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const price = PRICING_PER_MTOK[model] || { in: 0, out: 0 };
  const cost = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;

  sessionTotals.in += inTok;
  sessionTotals.out += outTok;
  sessionTotals.cost += cost;

  console.log(
    `[claude:${label}] ${model} — in=${inTok.toLocaleString()} ` +
    `out=${outTok.toLocaleString()} cost=$${cost.toFixed(4)} ` +
    `| session in=${sessionTotals.in.toLocaleString()} ` +
    `out=${sessionTotals.out.toLocaleString()} ` +
    `total=$${sessionTotals.cost.toFixed(4)}`
  );
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
      // Bumped from 4096 — the new performance_properties array per product
      // makes the response materially larger; truncation causes JSON parse failures.
      max_tokens: 16000,
      system: loadPrompt('extract'),
      messages: [{
        role: 'user',
        content:
          'Please analyze this construction specification text and extract all referenced roofing products and materials. Return the results as JSON.\n\n' +
          normalized.text,
      }],
    }), sendProgress);

  logUsage('extract', 'claude-sonnet-4-20250514', response?.usage);
  const text = response?.content?.[0]?.text;
  if (response?.stop_reason === 'max_tokens') {
    throw new Error(
      'Failed to parse Claude response as JSON. Hit the max_tokens cap on the extract step — output was truncated. Try again with a smaller spec, or raise the cap.'
    );
  }
  const parsed = parseJSON(text);

  // Spec-extraction audit log. Print property count per extracted product so
  // we can see when extract.txt missed structured properties. A spec product
  // with 0 properties is almost always a sign that the extractor missed the
  // structured property text (e.g. spec wrote properties in narrative form
  // and category-specific guidance in extract.txt didn't catch them).
  if (parsed && Array.isArray(parsed.products)) {
    const summary = parsed.products.map((p, i) => {
      const n = (p.performance_properties || []).length;
      const flag = n === 0 ? ' ⚠ no properties extracted' : '';
      return `  ${i + 1}. ${p.manufacturer || '?'} ${p.product_name || '?'} → ${n} properties${flag}`;
    }).join('\n');
    console.log(`[claude:extract] Spec audit (${parsed.products.length} products extracted):\n${summary}`);
  }

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
      // Bumped from 6144 — soprema_properties mirroring spec properties roughly
      // doubles the response size.
      max_tokens: 16000,
      system: loadPrompt('match'),
      messages: [{ role: 'user', content: userMessage }],
    }), sendProgress);

  logUsage('match', 'claude-sonnet-4-20250514', response?.usage);
  if (response?.stop_reason === 'max_tokens') {
    throw new Error(
      'Failed to parse Claude response as JSON. Hit the max_tokens cap on the match step — output was truncated.'
    );
  }
  return parseJSON(response.content[0].text);
}

/**
 * Haiku-powered query bar.
 * Answers natural-language questions about the extracted spec and matched
 * Soprema products. Uses Claude Haiku (fast + cheap) since the context is
 * already small and the answers are conversational, not structured.
 *
 * @param {string} question - user's plain-language question
 * @param {Object} context - { extracted, matched, history }
 * @returns {Promise<{ answer: string }>}
 */
async function askQuestion(question, context = {}) {
  const { extracted = {}, matched = {}, history = [] } = context;

  // Strip citation data — too verbose for a conversational context window
  const leanExtracted = {
    ...extracted,
    sourcePages: undefined,
    products: (extracted.products || []).map(({ citations, ...rest }) => rest),
  };

  const contextBlock =
    '## Extracted Specification\n' +
    JSON.stringify(leanExtracted, null, 2) +
    '\n\n## Matched Soprema Products\n' +
    JSON.stringify(matched, null, 2);

  const systemPrompt =
    'You are a senior Soprema roofing product specialist advising a manufacturer rep. ' +
    'You have deep expertise in commercial roofing systems, bituminous and thermoplastic membranes, ' +
    'insulation, fasteners, and substitution-request standards (CSI 01 25 00). ' +
    'Rules: ' +
    '1. Lead with the direct answer — no preamble. ' +
    '2. Plain English, roofer-friendly. Trades language is fine. ' +
    '3. If a spec requirement may fail compliance, flag it explicitly. ' +
    '4. Keep answers tight — 2–4 sentences unless the question demands more. ' +
    '5. If the answer isn\'t in the provided context, say so directly — do not invent product specs.';

  const messages = [];
  if (Array.isArray(history) && history.length) {
    history.slice(-6).forEach((h) => messages.push(h));
  }
  messages.push({
    role: 'user',
    content: contextBlock + '\n\nQuestion: ' + question,
  });

  const response = await withRateLimitRetry(() =>
    getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: systemPrompt,
      messages,
    })
  );

  logUsage('query', 'claude-haiku-4-5-20251001', response?.usage);
  const text = response?.content?.[0]?.text;
  if (!text) {
    throw new Error('The AI returned an empty response. Please try again.');
  }
  return { answer: text };
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
      // Bumped from 8192 — property_comparison table per substitution + per-row
      // citation data adds substantial output volume.
      max_tokens: 16000,
      system: loadPrompt('subrequest'),
      messages: [{ role: 'user', content: userMessage }],
    }), sendProgress);

  logUsage('subrequest', 'claude-sonnet-4-20250514', response?.usage);
  if (response?.stop_reason === 'max_tokens') {
    throw new Error(
      'Failed to parse Claude response as JSON. Hit the max_tokens cap on the sub-request step — output was truncated.'
    );
  }
  return parseJSON(response.content[0].text);
}

module.exports = {
  extractProducts,
  matchProducts,
  generateSubstitutionRequest,
  askQuestion,
  // Exposed for main.js's API-key management IPC handlers
  resetClient,
  resolveApiKey,
};