const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const puppeteer = require('puppeteer');

function usableTitle(title) {
  return typeof title === 'string' && title.trim().length > 0 && title.trim().length <= 300;
}

function createCaptureService(storageDir) {
  return async function capturePage(url) {
    let browser;
    const storageName = `${crypto.randomUUID()}.pdf`;
    const outputPath = path.join(storageDir, storageName);
    try {
      browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      const rawTitle = await page.title();
      const name = usableTitle(rawTitle) ? rawTitle.trim() : new URL(url).hostname;
      await page.pdf({ path: outputPath, format: 'A4', printBackground: true });
      const stat = await fs.stat(outputPath);
      return { name, mimeType: 'application/pdf', bytes: stat.size, storagePath: storageName };
    } catch (error) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
      const wrapped = new Error('The page could not be captured. It may block automated browsers, require a sign-in, or have timed out.');
      wrapped.cause = error;
      throw wrapped;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  };
}

module.exports = { createCaptureService };
