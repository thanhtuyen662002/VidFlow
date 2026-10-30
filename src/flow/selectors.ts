import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { dataDirectory, resolveInside } from '../paths.ts';

export type SelectorProfile = 'mock' | 'real';
export type Selectors = Record<string, { selector: string; note?: string }>;
export const defaultConfig = new URL('../../config/flow-selectors.json', import.meta.url);
// Shared detection rules for the mock and real profiles. Real DOM selectors still need calibration.
export const flowPatterns = {
  verificationSelector: 'iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="challenge" i]',
  verification: /verify (?:you are human|it's you)|unusual traffic|sign.in challenge|verification required|captcha|please sign.in/i,
  noCredit: /out of credits|insufficient credits|no credits/i,
  rejected: /reject|policy|not allowed/i,
};
const required = ["promptInput","submitButton","modelSelect","aspectRatioSelect","referenceUpload","generateButton","progressIndicator","resultVideo","downloadButton","creditCounter","errorBanner","accountMenu","login-email","login-submit","prompt-input","image-input","generate-button","credit-balance","job-item","job-status","video-result","download-link","error-banner","verify-challenge","verify-clear","prompt-textarea-v2","generate-button-v2"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Custom config paths must stay within VIDFLOW_HOME, including symlink targets. */
export function loadSelectors(path: string | undefined = undefined, profile: SelectorProfile = 'mock'): Selectors {
  if (profile !== 'mock' && profile !== 'real') throw new Error('Profile phải là mock hoặc real');
  const filename = path === undefined ? defaultConfig : resolveInside(dataDirectory(), relative(dataDirectory(), resolve(path)));
  let config: unknown;
  try { config = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('Cấu hình selector không đọc được hoặc JSON không hợp lệ'); }
  if (!object(config)) throw new Error('Cấu hình selector phải là object');
  for (const key of ['mock', 'real']) {
    const entries = config[key];
    if (!object(entries)) throw new Error('Cấu hình selector thiếu profile ' + key);
    for (const name of new Set([...required, ...Object.keys(entries)])) {
      const entry = entries[name];
      if (!object(entry) || typeof entry.selector !== 'string' || (entry.note !== undefined && typeof entry.note !== 'string')) {
        throw new Error('Cấu hình selector không hợp lệ: ' + key + '.' + name);
      }
    }
  }
  return config[profile] as Selectors;
}
