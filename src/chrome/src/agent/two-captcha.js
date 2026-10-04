// 2Captcha API v2: https://2captcha.com/api-docs
import { getJsonCaptchaBalance, solveJsonCaptcha } from './captcha-json-api.js';
const API_BASE = 'https://api.2captcha.com';

export const getTwoCaptchaBalance = apiKey => getJsonCaptchaBalance(API_BASE, '2Captcha', apiKey);

// Translate the existing normalized task to 2Captcha's case-sensitive types
// and fields. Never forward CapSolver-specific task names or affiliate IDs.
export function buildTwoCaptchaTask(task) {
  const { websiteURL, websiteKey } = task;
  switch (task.type) {
    case 'ReCaptchaV2TaskProxyLess':
    case 'ReCaptchaV2EnterpriseTaskProxyLess': {
      const enterprise = task.type.includes('Enterprise');
      return {
        type: enterprise ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless',
        websiteURL, websiteKey,
        ...(task.isInvisible != null ? { isInvisible: task.isInvisible } : {}),
        ...(task.userAgent ? { userAgent: task.userAgent } : {}),
        ...(enterprise && task.enterprisePayload ? { enterprisePayload: task.enterprisePayload } : {}),
        ...(!enterprise && task.recaptchaDataSValue ? { recaptchaDataSValue: task.recaptchaDataSValue } : {}),
      };
    }
    case 'ReCaptchaV3TaskProxyLess':
    case 'ReCaptchaV3EnterpriseTaskProxyLess':
      return {
        type: 'RecaptchaV3TaskProxyless', websiteURL, websiteKey,
        minScore: task.minScore || 0.3, pageAction: task.pageAction,
        isEnterprise: task.type.includes('Enterprise'),
      };
    case 'AntiTurnstileTaskProxyLess':
      return {
        type: 'TurnstileTaskProxyless', websiteURL, websiteKey,
        ...(task.userAgent ? { userAgent: task.userAgent } : {}),
        ...(task.metadata?.action ? { action: task.metadata.action } : {}),
        ...(task.metadata?.cdata ? { data: task.metadata.cdata } : {}),
        ...(task.metadata?.chlPageData ? { pagedata: task.metadata.chlPageData } : {}),
      };
    case 'ImageToTextTask':
      return { type: 'ImageToTextTask', body: task.body, ...(task.case != null ? { case: task.case } : {}) };
    default:
      // hCaptcha is not listed in the current 2Captcha API v2 documentation.
      throw new Error(`2Captcha does not support this CAPTCHA type in WebBrain: ${task.type}`);
  }
}

export const solveWithTwoCaptcha = (apiKey, task) => solveJsonCaptcha(API_BASE, '2Captcha', apiKey, buildTwoCaptchaTask(task));
