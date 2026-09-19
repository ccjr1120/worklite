#!/usr/bin/env node

// Opens the WeChat article editor in a headed browser using the deployment
// profile's stored session, uploads a cover image, and stops inside the cover
// picker so the crop step can be inspected by hand. It never saves a draft.

import { createDecipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_PATH ?? new URL('../.data/deployment/worklite.db', import.meta.url).pathname;
const COVER_PATH = process.argv[2] ?? '/tmp/cover-check.png';

function decryptSecret(value) {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

readFileSync(COVER_PATH);
const db = new Database(DB_PATH, { readonly: true });
const row = db.prepare("select encrypted_storage_state from wechat_official_accounts where id = 'wechat_official_account_personal'").get();
if (!row?.encrypted_storage_state) {
  console.error('No stored WeChat session. Sign in through the app first.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: false, slowMo: 150 });
const context = await browser.newContext({ storageState: JSON.parse(decryptSecret(row.encrypted_storage_state)) });
const page = await context.newPage();

console.log('Opening WeChat MP home...');
await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
const token = new URL(page.url()).searchParams.get('token');
if (!token) {
  console.error('Session has no editor token. Sign in again through the app.');
  await browser.close();
  process.exit(1);
}

console.log('Opening the article editor...');
await page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&token=${encodeURIComponent(token)}&lang=en_US`, { waitUntil: 'domcontentloaded' });

const titleEditor = page.locator('.ProseMirror').first();
await titleEditor.waitFor({ state: 'visible', timeout: 20_000 });
await titleEditor.click();
await titleEditor.fill('Cover picker inspection');

console.log('Opening the cover picker...');
const cover = page.locator('#js_cover_area');
await cover.waitFor({ state: 'visible', timeout: 20_000 });
await cover.scrollIntoViewIfNeeded();
await cover.click();

const imageLibraryButton = page.locator('#js_cover_area .js_imagedialog:visible, #js_cover_null .js_imagedialog:visible').last();
await imageLibraryButton.waitFor({ state: 'visible', timeout: 10_000 });
await imageLibraryButton.click();

const imageDialog = page.locator('.weui-desktop-dialog_img-picker').last();
await imageDialog.waitFor({ state: 'visible', timeout: 20_000 });

console.log(`Uploading ${COVER_PATH}...`);
const fileInput = imageDialog.locator('.js_upload_btn_container input[type="file"]').last();
await fileInput.setInputFiles(COVER_PATH);

console.log('');
console.log('The browser is now yours. Select the uploaded image, press 下一步, and watch the crop step.');
console.log('Reporting the crop dialog state every 3 seconds. Press Ctrl+C when done.');
console.log('');

const report = async () => {
  const dialogs = await page.evaluate(`(() => Array.from(document.querySelectorAll('.weui-desktop-dialog'))
    .filter((dialog) => dialog.getBoundingClientRect().width > 50)
    .map((dialog) => ({
      size: Math.round(dialog.getBoundingClientRect().width) + 'x' + Math.round(dialog.getBoundingClientRect().height),
      buttons: Array.from(dialog.querySelectorAll('button, a.weui-desktop-btn, [role="button"]')).map((button) => {
        const box = button.getBoundingClientRect();
        const text = (button.textContent || '').replace(/\\s+/g, '') || '(icon)';
        const disabled = button.hasAttribute('disabled') || button.classList.contains('weui-desktop-btn_disabled');
        return text + ' ' + Math.round(box.width) + 'x' + Math.round(box.height) + (disabled ? ' DISABLED' : '');
      }),
      media: Array.from(dialog.querySelectorAll('img, canvas')).map((node) => {
        const box = node.getBoundingClientRect();
        return node.tagName + ' ' + Math.round(box.width) + 'x' + Math.round(box.height);
      }).slice(0, 6),
    })))()`).catch(() => []);
  // Scan the whole page for the uploaded material so the element that actually
  // renders the applied cover can be identified rather than assumed.
  const coverArea = await page.evaluate(`(() => {
    const hits = [];
    for (const node of Array.from(document.querySelectorAll('*'))) {
      const src = node.getAttribute && (node.getAttribute('src') || node.getAttribute('data-src') || '');
      const bg = node.ownerDocument.defaultView.getComputedStyle(node).backgroundImage;
      const value = (src && /mmbiz/.test(src)) ? src : ((bg && /mmbiz/.test(bg)) ? bg : '');
      if (!value) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 20 || box.height < 20) continue;
      let path = node.tagName.toLowerCase();
      if (node.id) path += '#' + node.id;
      else if (node.className && typeof node.className === 'string') path += '.' + node.className.trim().split(/\\s+/).slice(0,2).join('.');
      const parent = node.parentElement;
      const parentPath = parent ? (parent.id ? '#' + parent.id : (typeof parent.className === 'string' ? '.' + parent.className.trim().split(/\\s+/)[0] : parent.tagName)) : '-';
      hits.push(parentPath + ' > ' + path + ' ' + Math.round(box.width) + 'x' + Math.round(box.height));
    }
    const area = document.querySelector('#js_cover_area');
    const inArea = area ? Array.from(area.querySelectorAll('img')).length : -1;
    return 'jsCoverAreaImgs=' + inArea + ' | mmbizNodes: ' + (hits.slice(0,6).join(' ;; ') || 'none');
  })()`).catch(() => 'unavailable');
  console.log(`[${new Date().toLocaleTimeString()}] cover area: ${coverArea}`);
  for (const dialog of dialogs) {
    console.log(`  dialog ${dialog.size} media=[${dialog.media.join(', ')}]`);
    console.log(`    buttons: ${dialog.buttons.join(' | ')}`);
  }
};

setInterval(() => { void report(); }, 3_000);
await report();
