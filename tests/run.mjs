/* global document -- used inside page.waitForFunction, which runs in the browser */
// Runs tests/engine.test.html in headless Chrome and reports results.
// Uses the system Chrome (channel "chrome"); set CHROME_PATH to use another Chromium binary.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { startServer } from '../tools/serve.mjs';
import { APP_VERSION } from '../js/version.js';

let failed = 0;

// The version shown in Settings must match package.json.
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.version === APP_VERSION) {
  console.log(`PASS :: app version ${APP_VERSION} matches package.json`);
} else {
  console.log(`FAIL :: js/version.js says ${APP_VERSION} but package.json says ${pkg.version}`);
  failed++;
}

const server = await startServer(0);
const { port } = server.address();
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    console.error('Page error:', e.message);
    failed++;
  });
  await page.goto(`http://127.0.0.1:${port}/tests/engine.test.html`);
  await page.waitForFunction(() => document.getElementById('out')?.textContent.startsWith('DONE'), null, {
    timeout: 30000,
  });
  const lines = (await page.textContent('#out')).split('\n').slice(1);
  for (const line of lines) {
    if (line.startsWith('FAIL')) failed++;
    if (!line.startsWith('INFO')) console.log(line);
  }
  const passed = lines.filter((l) => l.startsWith('PASS')).length;
  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
