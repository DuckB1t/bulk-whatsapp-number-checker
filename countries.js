/**
 * ISO Country Codes & Calling Prefixes
 * Zero dependency vanilla data dictionary
 */

const COUNTRIES = [
  { code: 'BD', name: 'Bangladesh', dialCode: '880' },
  { code: 'US', name: 'United States / Canada', dialCode: '1' },
  { code: 'IN', name: 'India', dialCode: '91' },
  { code: 'GB', name: 'United Kingdom', dialCode: '44' },
  { code: 'SA', name: 'Saudi Arabia', dialCode: '966' },
  { code: 'AE', name: 'United Arab Emirates', dialCode: '971' },
  { code: 'PK', name: 'Pakistan', dialCode: '92' },
  { code: 'ID', name: 'Indonesia', dialCode: '62' },
  { code: 'NG', name: 'Nigeria', dialCode: '234' },
  { code: 'BR', name: 'Brazil', dialCode: '55' },
  { code: 'MX', name: 'Mexico', dialCode: '52' },
  { code: 'DE', name: 'Germany', dialCode: '49' },
  { code: 'FR', name: 'France', dialCode: '33' },
  { code: 'IT', name: 'Italy', dialCode: '39' },
  { code: 'ES', name: 'Spain', dialCode: '34' },
  { code: 'AU', name: 'Australia', dialCode: '61' },
  { code: 'MY', name: 'Malaysia', dialCode: '60' },
  { code: 'SG', name: 'Singapore', dialCode: '65' },
  { code: 'PH', name: 'Philippines', dialCode: '63' },
  { code: 'VN', name: 'Vietnam', dialCode: '84' },
  { code: 'EG', name: 'Egypt', dialCode: '20' },
  { code: 'ZA', name: 'South Africa', dialCode: '27' },
  { code: 'TR', name: 'Turkey', dialCode: '90' },
  { code: 'JP', name: 'Japan', dialCode: '81' },
  { code: 'KR', name: 'South Korea', dialCode: '82' }
];

function getCountryByCode(code) {
  return COUNTRIES.find(c => c.code === code) || COUNTRIES[0];
}

if (typeof globalThis !== 'undefined') {
  globalThis.COUNTRIES = COUNTRIES;
  globalThis.getCountryByCode = getCountryByCode;
}
