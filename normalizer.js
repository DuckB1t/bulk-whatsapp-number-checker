/**
 * Zero-Dependency Pure Vanilla E.164 Phone Normalizer
 */

function normalizePhoneNumber(rawInput, defaultCountryCode = 'BD') {
  if (!rawInput || typeof rawInput !== 'string') {
    return { isValid: false, normalized: '', original: rawInput || '' };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { isValid: false, normalized: '', original: trimmed };
  }

  // Reject alphabetic characters (e.g. "abc", "hello")
  if (/[a-zA-Z]/.test(trimmed)) {
    return { isValid: false, normalized: '', original: trimmed };
  }

  // Find default country dial code
  const countryObj = (typeof getCountryByCode === 'function') ? getCountryByCode(defaultCountryCode) : { dialCode: '880' };
  const dialCode = (countryObj ? countryObj.dialCode : '880').replace('+', '');

  // 1. If starts with '+', keep plus and strip all non-digits after it
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      return { isValid: true, normalized: '+' + digits, original: trimmed };
    }
    return { isValid: false, normalized: '', original: trimmed };
  }

  // 2. Strip all non-digit characters
  const cleanDigits = trimmed.replace(/\D/g, '');
  if (!cleanDigits) {
    return { isValid: false, normalized: '', original: trimmed };
  }

  let finalNormalized = '';

  // 3. Check if cleanDigits already starts with dial code (e.g. 8801712345678).
  //    Require dialCode + at least 6 more digits so single-digit codes like US '1'
  //    don't swallow local numbers (e.g. "1234567" must not become "+1234567").
  if (cleanDigits.startsWith(dialCode) && cleanDigits.length > dialCode.length + 6) {
    finalNormalized = '+' + cleanDigits;
  }
  // 4. If starts with '0' (local trunk prefix), replace leading zero with country dial code
  else if (cleanDigits.startsWith('0')) {
    finalNormalized = '+' + dialCode + cleanDigits.slice(1);
  }
  // 5. Otherwise append country dial code
  else {
    finalNormalized = '+' + dialCode + cleanDigits;
  }

  const numDigits = finalNormalized.slice(1).length;
  const isValid = numDigits >= 7 && numDigits <= 15;

  return {
    isValid,
    normalized: isValid ? finalNormalized : '',
    original: trimmed
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.normalizePhoneNumber = normalizePhoneNumber;
}
