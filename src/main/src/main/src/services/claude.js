const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic({ apiKey: global.appConfig?.ANTHROPIC_API_KEY });

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', `${name}.txt`), 'utf-8');
}

function parseJSON(text) {
  const match = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) return JSON.parse(match[1]);
  return JSON.parse(text);
}

async function extractProducts(pdfBuffer) {
  const base64Pdf = pdfBuffer.toString('base64');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: loadPrompt('extract'),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf }
        },
        {
          type: 'text',
          text: 'Please analyze this construction specification and extract all referenced products...'
        }
      ]
    }]
  });
  return parseJSON(response.content[0].text);
}

async function matchProducts(extracted, condensedCatalog, documentsList) {
  const userMessage = `## Extracted Products\n${JSON.stringify(extracted)}\n## Soprema Catalog\n${condensedCatalog}\n## Documents\n${documentsList}`;
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: loadPrompt('match'),
    messages: [{ role: 'user', content: userMessage }]
  });
  return parseJSON(response.content[0].text);
}

/**
 * Step 3: Generate a complete Substitution Request Form based on the
 * matched products (from Step 2) and user-provided project information.
 *
 * @param {Object} matchedData   - The output from matchProducts()
 * @param {Object} projectInfo   - { projectName, specSection, addressedTo, submittedBy, date }
 * @returns {Object}             - Structured substitution request form data
 */
async function generateSubstitutionRequest(matchedData, projectInfo) {
  const userMessage = `## Project Information\n${JSON.stringify(projectInfo, null, 2)}\n\n## Matched Soprema Products (from spec analysis)\n${JSON.stringify(matchedData, null, 2)}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: loadPrompt('subrequest'),
    messages: [{ role: 'user', content: userMessage }]
  });

  return parseJSON(response.content[0].text);
}

module.exports = { extractProducts, matchProducts, generateSubstitutionRequest };
