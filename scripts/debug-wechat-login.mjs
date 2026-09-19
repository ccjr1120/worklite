#!/usr/bin/env node

import { createRequire } from 'node:module';

const DEFAULT_TIMEOUT_MS = 180_000;
const requireApiDependency = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { chromium } = requireApiDependency('playwright');

const options = parseOptions(process.argv.slice(2));
const timeoutMs = parsePositiveInteger(options.get('timeout-ms') ?? process.env.WECHAT_LOGIN_DEBUG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const headless = options.has('headless');

if (options.has('help')) {
  printHelp();
  process.exit(0);
}

console.log(`Opening WeChat MP login in a ${headless ? 'headless' : 'headed'} Chromium window.`);
console.log('Scan the QR code in that window. This script only observes the login transition.');
console.log(`Timeout: ${timeoutMs} ms`);
console.log('');

const browser = await chromium.launch({ headless });
const context = await browser.newContext();
const page = await context.newPage();
const startedAt = Date.now();
const qrPath = `/tmp/worklite-wechat-login-headless-qr-${startedAt}.png`;
let lastSignature = '';
let cookieBeforeAuthenticatedPage = false;
let warnedPrematureClose = false;
let authenticatedChecks = 0;
let qrChangeCount = 0;
let lastQrSource = '';
let lastScanLoginState = '';

try {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') console.log(`${elapsedLabel(startedAt)} console ${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`${elapsedLabel(startedAt)} pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (isLoginTelemetryUrl(request.url())) console.log(`${elapsedLabel(startedAt)} request failed: ${summarizeUrl(request.url())}`);
  });
  page.on('response', (response) => {
    if (isScanLoginPoll(response.url())) {
      if (/^image\//i.test(response.headers()['content-type'] ?? '')) return;
      void response.text().then((body) => {
        const state = summarizeLoginPollBody(body);
        if (state && state !== lastScanLoginState) {
          lastScanLoginState = state;
          console.log(`${elapsedLabel(startedAt)} scan state: ${state} query: ${new URL(response.url()).search} body: ${JSON.stringify(body.slice(0, 300))}`);
        }
      }).catch(() => undefined);
      return;
    }
    if (isLoginTelemetryUrl(response.url()) && !response.ok()) console.log(`${elapsedLabel(startedAt)} response ${response.status()}: ${summarizeUrl(response.url())}`);
  });
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  await showScanLogin(page);
  lastQrSource = (await readQrSource(page)) ?? '';
  if (headless) {
    await captureQr(page, qrPath);
    console.log(`QR screenshot: ${qrPath}`);
    console.log('The file is rewritten in place whenever WeChat refreshes the code, so reopen it before scanning.');
  }

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(1_000);

    const sampledAt = Date.now();
    const cookies = await context.cookies();
    const cookieNames = new Set(cookies.map((cookie) => cookie.name));
    const cookieConfirmation = cookieNames.has('slave_sid') && cookieNames.has('slave_user');
    const pageUrls = context.pages().map((candidate) => candidate.url());
    const authenticatedPages = pageUrls.filter((value) => {
      try {
        const url = new URL(value);
        return url.hostname.endsWith('weixin.qq.com') && url.searchParams.has('token');
      } catch {
        return false;
      }
    });
    const serviceConfirmation = cookieConfirmation || authenticatedPages.length > 0;
    const qrSource = serviceConfirmation ? null : await readQrSource(page);
    if (qrSource && qrSource !== lastQrSource) {
      qrChangeCount += 1;
      lastQrSource = qrSource;
      if (headless) {
        await captureQr(page, qrPath);
        console.log(`${elapsedLabel(startedAt)} QR refreshed, screenshot rewritten: ${qrPath}`);
      }
    }

    if (cookieConfirmation && authenticatedPages.length === 0) cookieBeforeAuthenticatedPage = true;
    authenticatedChecks = authenticatedPages.length > 0 ? authenticatedChecks + 1 : 0;

    const signature = [
      `service=${formatBoolean(serviceConfirmation)}`,
      `authPage=${formatBoolean(authenticatedPages.length > 0)}`,
      `cookies=${formatBoolean(cookieConfirmation)}`,
      `qrChanges=${qrChangeCount}`, `pages=${pageUrls.map((value) => summarizeUrl(value)).join(' | ') || 'none'}`,
    ].join(' ');

    if (signature !== lastSignature) {
      console.log(`[${((sampledAt - startedAt) / 1000).toFixed(0)}s] ${signature}`);
      lastSignature = signature;
    }

    if (serviceConfirmation && authenticatedPages.length === 0 && !warnedPrematureClose) {
      console.log(`${elapsedLabel(startedAt)} Current service logic would close the session before a token page exists.`);
      warnedPrematureClose = true;
    }

    if (authenticatedChecks >= 3) {
      console.log('');
      console.log('Result: token page remained present for 3 consecutive checks.');
      console.log(`Cookie confirmation appeared before authenticated page: ${formatBoolean(cookieBeforeAuthenticatedPage)}`);
      console.log('Close the browser window, or press Ctrl+C if it remains open.');
      await browser.close().catch(() => undefined);
      process.exit(0);
    }
  }

  await page.screenshot({ path: '/tmp/worklite-wechat-login-debug-timeout.png', fullPage: true }).catch(() => undefined);
  console.error(`Login did not produce a stable authenticated page within ${timeoutMs} ms.`);
  console.error('Screenshot: /tmp/worklite-wechat-login-debug-timeout.png');
  process.exitCode = 1;
} catch (error) {
  await page.screenshot({ path: '/tmp/worklite-wechat-login-debug-error.png', fullPage: true }).catch(() => undefined);
  console.error(`Debug login failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Screenshot: /tmp/worklite-wechat-login-debug-error.png');
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') {
      options.set('help', 'true');
      continue;
    }
    const match = /^--([^=]+)=(.*)$/.exec(value);
    if (match) {
      options.set(match[1], match[2]);
      continue;
    }
    if (value.startsWith('--')) {
      const next = values[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options.set(value.slice(2), next);
        index += 1;
        continue;
      }
      options.set(value.slice(2), 'true');
    }
  }
  return options;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Invalid positive integer: ${value}`);
    process.exit(2);
  }
  return parsed;
}

function formatBoolean(value) {
  return value ? 'yes' : 'no';
}

async function showScanLogin(page) {
  const qr = qrLocator(page);
  const toggle = page.locator('a.login__type__container__link_text').first();
  await qr.or(toggle).first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await qr.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) return;
  await toggle.click();
  await qr.waitFor({ state: 'visible', timeout: 20_000 });
}

function qrLocator(page) {
  return page.locator('img.login__type__container__scan__qrcode').first();
}

function readQrSource(page) {
  return qrLocator(page).getAttribute('src', { timeout: 1_000 }).catch(() => null);
}

async function captureQr(page, path) {
  await qrLocator(page).screenshot({ path }).catch(() => undefined);
}

function isLoginTelemetryUrl(value) {
  try {
    const url = new URL(value);
    return /login|qrcode|scan|long|poll/i.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function isScanLoginPoll(value) {
  try {
    return new URL(value).pathname.endsWith('/cgi-bin/scanloginqrcode');
  } catch {
    return false;
  }
}

function summarizeLoginPollBody(value) {
  const status = value.match(/["']?status["']?\s*:\s*["']?(-?\d+)/)?.[1] ?? 'unknown';
  const message = value.match(/["']?err_?msg["']?\s*:\s*["']([^"']*)["']/)?.[1] ?? '';
  return message ? `status=${status} ${message}` : `status=${status}`;
}

function summarizeUrl(value) {
  try {
    const url = new URL(value);
    const token = url.searchParams.has('token') ? '?token=<present>' : '';
    return `${url.hostname}${url.pathname}${token}`;
  } catch {
    return value || 'about:blank';
  }
}

function elapsedLabel(startedAt) {
  return `[${((Date.now() - startedAt) / 1000).toFixed(0)}s]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage: node scripts/debug-wechat-login.mjs [--headless] [--timeout-ms=${DEFAULT_TIMEOUT_MS}]

Opens the real WeChat MP login page in Chromium and reports whether login
produces a token-authenticated page. With --headless, the QR code is saved to a
unique PNG file and rewritten in place on every WeChat refresh.`);
}
