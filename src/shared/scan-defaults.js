export const SCAN_DEFAULTS = Object.freeze({
  maxResults: 10,
  minSimilarityPct: 15,
  maxResultsMin: 1,
  maxResultsMax: 100,
  minSimilarityMin: 0,
  minSimilarityMax: 100
});

const SCANCODE_BASE = 'https://scancode-licensedb.aboutcode.org';
const SPDX_LICENSES_BASE = 'https://spdx.org/licenses';

export const SCAN_ENDPOINTS = Object.freeze({
  scancodeBase: SCANCODE_BASE,
  scancodeIndexJson: `${SCANCODE_BASE}/index.json`,
  scancodeIndexHtml: `${SCANCODE_BASE}/index.html`,
  spdxLicensesBase: SPDX_LICENSES_BASE,
  spdxLicensesJson: `${SPDX_LICENSES_BASE}/licenses.json`,
  spdxExceptionsJson: `${SPDX_LICENSES_BASE}/exceptions.json`
});
