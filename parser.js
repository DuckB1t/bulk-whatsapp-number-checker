/**
 * Input Parser (Textarea, TXT, CSV)
 * Zero dependencies, pure vanilla JavaScript
 */

function parseImportContent(rawText, defaultCountryCode = 'BD') {
  if (!rawText || typeof rawText !== 'string') {
    return {
      totalImported: 0,
      duplicatesCount: 0,
      invalidCount: 0,
      validCount: 0,
      items: []
    };
  }

  // Split by linebreaks, commas, semicolons, or tabs
  const tokens = rawText
    .split(/[\r\n,;\t]+/)
    .map(t => t.trim())
    .filter(Boolean);

  const totalImported = tokens.length;
  const seenNormalized = new Set();
  let duplicatesCount = 0;
  let invalidCount = 0;
  const items = [];

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];

    const normResult = (typeof normalizePhoneNumber === 'function')
      ? normalizePhoneNumber(raw, defaultCountryCode)
      : { isValid: true, normalized: raw };

    if (!normResult.isValid) {
      invalidCount++;
      items.push({
        id: i,
        original: raw,
        normalized: normResult.normalized || raw,
        status: 'INVALID',
        checkedAt: null,
        notes: 'Invalid phone number format'
      });
      continue;
    }

    const normKey = normResult.normalized;
    if (seenNormalized.has(normKey)) {
      duplicatesCount++;
      // PRD Rule 11: Remove duplicates, preserve first occurrence
      continue;
    }

    seenNormalized.add(normKey);
    items.push({
      id: i,
      original: raw,
      normalized: normKey,
      status: 'PENDING',
      checkedAt: null,
      notes: ''
    });
  }

  const validCount = items.filter(it => it.status === 'PENDING').length;

  return {
    totalImported,
    duplicatesCount,
    invalidCount,
    validCount,
    items
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.parseImportContent = parseImportContent;
}
