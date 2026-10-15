import fs from 'fs';
import path from 'path';
import os from 'os';

function emit(type, data) {
  process.stdout.write(JSON.stringify({ type, ...data }) + '\n');
}

function emitLog(level, message) {
  emit('log', { level, message, timestamp: new Date().toISOString() });
}

async function readStdinPayload() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (err) {
        reject(new Error(`Failed to parse stdin JSON: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

async function getChromium() {
  try {
    const pw = await import('playwright');
    if (pw.chromium) return pw.chromium;
  } catch {}

  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || (userProfile ? `${userProfile}\\AppData\\Roaming` : '');
  const localAppData = process.env.LOCALAPPDATA || (userProfile ? `${userProfile}\\AppData\\Local` : '');

  const candidates = [
    appData ? `${appData}\\npm\\node_modules\\playwright\\index.mjs` : '',
    appData ? `${appData}\\npm\\node_modules\\playwright\\index.js` : '',
    localAppData ? `${localAppData}\\npm\\node_modules\\playwright\\index.mjs` : '',
    localAppData ? `${localAppData}\\npm\\node_modules\\playwright\\index.js` : '',
    'C:\\Program Files\\nodejs\\node_modules\\playwright\\index.js',
    'C:\\Program Files\\Heist Bridge\\resources\\engine\\node_modules\\playwright\\index.mjs',
    'C:\\Program Files\\Heist Bridge\\resources\\engine\\node_modules\\playwright\\index.js'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const mod = await import(`file://${candidate.replace(/\\/g, '/')}`);
        const chrom = mod.chromium || mod.default?.chromium;
        if (chrom) return chrom;
      } catch {}
    }
  }

  throw new Error('Package "playwright" belum terinstall di PC Windows. Jalankan "npm install -g playwright" di PC Windows.');
}

function getChromiumLaunchOptions(headless = true) {
  const options = {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };

  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      options.executablePath = candidate;
      break;
    }
  }

  return options;
}

async function main() {
  let payload;
  try {
    payload = await readStdinPayload();
  } catch (err) {
    emit('finished', { success: false, message: `Invalid input: ${err.message}` });
    process.exit(1);
  }

  const {
    title = 'ATM Test Result',
    category = 'Result',
    hubBaseUrl = 'https://mobilerndhub.sec.samsung.net/hub/site/gcim/board/submission/write',
    boardSrl = '',
    archivePath = '',
    archiveBase64 = '',
    archiveFilename = 'ATM_results.zip',
    cookies = [],
    username = '',
    password = '',
    headless = true
  } = payload;

  emitLog('info', `Starting submission for "${title}"`);
  emitLog('info', `Target URL: ${hubBaseUrl} (headless: ${headless})`);

  let tempFilePath = null;
  let browser = null;

  try {
    if (archiveBase64 && !archivePath) {
      tempFilePath = path.join(os.tmpdir(), `heist_upload_${Date.now()}_${archiveFilename}`);
      fs.writeFileSync(tempFilePath, Buffer.from(archiveBase64, 'base64'));
    } else if (archivePath && fs.existsSync(archivePath)) {
      tempFilePath = archivePath;
    }

    const chromium = await getChromium();
    const launchOpts = getChromiumLaunchOptions(headless);
    browser = await chromium.launch(launchOpts);

    const contextOptions = {};
    if (Array.isArray(cookies) && cookies.length > 0) {
      // Normalize cookies for Playwright storage state format
      contextOptions.storageState = {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
          path: c.path || '/',
          expires: c.expires || -1,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: c.sameSite || 'None'
        })),
        origins: [{ origin: 'https://mobilerndhub.sec.samsung.net', localStorage: [] }]
      };
      emitLog('info', `Injected ${cookies.length} session cookies`);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const writeUrl = (hubBaseUrl.includes('/board/') && hubBaseUrl.includes('/write'))
      ? hubBaseUrl
      : boardSrl
        ? `${hubBaseUrl.replace(/\/$/, '')}/index.php?mid=board&act=dispBoardWrite&board_srl=${boardSrl}`
        : hubBaseUrl;

    emitLog('info', `Navigating to ${writeUrl}...`);
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    emitLog('info', `Page loaded. Active URL: ${page.url()}`);

    let currentUrl = page.url();
    if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso') || currentUrl.toLowerCase().includes('adfs')) {
      emitLog('warn', `Redirected to SSO login: ${currentUrl}`);

      if (username && password) {
        emitLog('info', `Attempting auto-fill login for user "${username}"...`);
        const userInput = page.locator('#userNameInput, input[name="UserName"], input[name="user_id"], input[name="username"], input[name="login_id"], input[id*="user" i], input[type="text"]').first();
        const passInput = page.locator('#passwordInput, input[name="Password"], input[name="password"], input[name="passwd"], input[id*="pass" i], input[type="password"]').first();

        if (await userInput.isVisible({ timeout: 5000 }) && await passInput.isVisible({ timeout: 5000 })) {
          await userInput.fill(username);
          await passInput.fill(password);
          const submitBtn = page.locator('#submitButton, span#submitButton, button#submitButton, input[type="submit"], button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("로그인")').first();
          if (await submitBtn.isVisible({ timeout: 3000 })) {
            await submitBtn.click();
          } else {
            await passInput.press('Enter');
          }
          emitLog('info', 'Credentials submitted, waiting for SSO redirection...');
          try {
            await page.waitForURL((url) => !url.href.includes('sts.secsso.net') && !url.href.includes('/adfs/'), { timeout: 20000 });
          } catch {}
          await page.waitForTimeout(4000);
        }
      }

      currentUrl = page.url();
      if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso') || currentUrl.toLowerCase().includes('adfs')) {
        throw new Error('Session SSO expired or requires 2FA verification.');
      }

      try {
        const refreshedCookies = await context.cookies();
        if (refreshedCookies && refreshedCookies.length > 0) {
          emit('cookies_updated', { cookies: refreshedCookies });
        }
      } catch {}
    }

    // Set Category
    emitLog('info', `Filling Category: "${category}"...`);
    try {
      const catInput = page.locator('input[name="category_srl"], #category_combo input, select[name="category_srl"]').first();
      if (await catInput.isVisible({ timeout: 2500 })) {
        await catInput.fill(category);
      }
    } catch {}

    // Set Title
    emitLog('info', `Filling Title: "${title}"...`);
    const titleInput = page.locator('input[name="title"], #title, input.x-form-text[name="title"]').first();
    if (await titleInput.isVisible({ timeout: 3000 })) {
      await titleInput.fill(title);
    } else {
      emitLog('warn', 'Title input element not found with standard selector.');
    }

    // Upload archive file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      emitLog('info', `Attaching file: ${path.basename(tempFilePath)}...`);
      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
        const uploaderBtn = page.locator('.webix_uploader, input[type="file"], button:has-text("Upload"), .x-btn:has-text("Upload")').first();
        if (await uploaderBtn.isVisible({ timeout: 2000 })) {
          await uploaderBtn.click();
          const chooser = await fileChooserPromise;
          if (chooser) {
            await chooser.setFiles(tempFilePath);
            emitLog('info', 'File attached via filechooser.');
          }
        } else {
          const directFileInput = page.locator('input[type="file"]').first();
          if ((await directFileInput.count()) > 0) {
            await directFileInput.setInputFiles(tempFilePath);
            emitLog('info', 'File attached via direct file input.');
          } else {
            emitLog('warn', 'No file uploader element found on page.');
          }
        }
      } catch (uploadErr) {
        emitLog('warn', `File upload interaction warning: ${uploadErr.message}`);
      }
    }

    // Submit form
    emitLog('info', 'Submitting form...');
    const submitBtn = page.locator('button:has-text("Submit"), button:has-text("등록"), input[type="submit"], .btn-submit').first();
    if (await submitBtn.isVisible({ timeout: 2500 })) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
    } else {
      emitLog('warn', 'Submit button not located.');
    }

    emitLog('info', `Submission complete for "${title}"`);
    emit('finished', { success: true, message: `Successfully submitted "${title}" to Mobile R&D Hub` });
  } catch (err) {
    emitLog('error', `Submission error: ${err.message}`);
    emit('finished', { success: false, message: `Submission failed: ${err.message}` });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    // Clean up temporary file created from base64 buffer
    if (tempFilePath && archiveBase64 && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  }
}

main();
