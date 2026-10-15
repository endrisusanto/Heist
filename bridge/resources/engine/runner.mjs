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

    // Dismiss any browser alert/confirm/prompt dialogs that appear during flow
    page.on('dialog', (dialog) => {
      emitLog('info', `Dismissing dialog: "${dialog.message()}"`);
      dialog.dismiss().catch(() => {});
    });

    let currentUrl = page.url();
    if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso') || currentUrl.toLowerCase().includes('adfs')) {
      emitLog('warn', `Redirected to SSO login: ${currentUrl}`);

      if (username && password) {
        emitLog('info', `Attempting auto-fill login for user "${username}"...`);
        const userInput = page.getByRole('textbox', { name: 'User Account' })
          .or(page.locator('#userNameInput, input[name="UserName"], input[name="user_id"], input[name="username"], input[name="login_id"], input[id*="user" i]'))
          .first();
        const passInput = page.getByRole('textbox', { name: 'Password' })
          .or(page.locator('#passwordInput, input[name="Password"], input[name="password"], input[name="passwd"], input[id*="pass" i]'))
          .first();

        if (await userInput.isVisible({ timeout: 5000 }) && await passInput.isVisible({ timeout: 5000 })) {
          await userInput.click();
          await userInput.fill(username);
          await userInput.press('Tab');
          await passInput.fill(password);

          const submitBtn = page.getByRole('button', { name: 'Login' })
            .or(page.locator('#submitButton, span#submitButton, button#submitButton, input[type="submit"], button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("로그인")'))
            .first();

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
    const categoryName = category || 'Result';
    emitLog('info', `Selecting Category: "${categoryName}"...`);
    try {
      const catField = page.getByPlaceholder('Category', { exact: true })
        .or(page.locator('input[placeholder="Category"], input[name="category_srl"], #category_combo input'))
        .first();
      if (await catField.isVisible({ timeout: 5000 })) {
        await catField.click();
        await page.waitForTimeout(500);

        const optionEl = page.getByRole('option', { name: categoryName })
          .or(page.locator(`.x-boundlist-item:has-text("${categoryName}"), [role="option"]:has-text("${categoryName}")`))
          .first();
        if (await optionEl.isVisible({ timeout: 3000 })) {
          await optionEl.click();
          emitLog('info', `Category option "${categoryName}" selected.`);
        } else {
          emitLog('warn', `Category option "${categoryName}" not directly visible, attempting first option fallback...`);
          const firstOpt = page.getByRole('option').first();
          if (await firstOpt.isVisible({ timeout: 1500 })) {
            await firstOpt.click();
            emitLog('info', 'Selected first available category option.');
          }
        }
      }
    } catch (catErr) {
      emitLog('warn', `Category selection interaction: ${catErr.message}`);
    }

    // Set Title
    emitLog('info', `Filling Title: "${title}"...`);
    try {
      const titleField = page.getByPlaceholder('Title')
        .or(page.locator('input[placeholder="Title"], input[name="title"], #title, input.x-form-text[name="title"]'))
        .first();
      if (await titleField.isVisible({ timeout: 4000 })) {
        await titleField.click();
        await titleField.fill(title);
        emitLog('info', 'Title filled successfully.');
      } else {
        emitLog('warn', 'Title input element not found with standard selector.');
      }
    } catch (titleErr) {
      emitLog('warn', `Title fill notice: ${titleErr.message}`);
    }

    // Fill Editor Body (NamoSE HTML Editor frame)
    emitLog('info', 'Filling Editor Body (NamoSE HTML Editor)...');
    const bodyContent = content || title || 'Automated Test Result';
    let editorFilled = false;

    // Attempt 1: frameLocator
    try {
      const editorFrame = page.frameLocator('iframe#NamoSE_editorframe_inputEl-hubhtmleditor, iframe[id*="NamoSE_editorframe"]');
      const editorBody = editorFrame.locator('body');
      if (await editorBody.isVisible({ timeout: 4000 })) {
        await editorBody.click();
        await editorBody.fill(bodyContent);
        editorFilled = true;
        emitLog('info', 'Editor body filled via frameLocator.');
      }
    } catch (frameErr) {
      emitLog('info', `frameLocator attempt info: ${frameErr.message}`);
    }

    // Attempt 2: contentFrame handle
    if (!editorFilled) {
      try {
        const frameHandle = await page.$('iframe#NamoSE_editorframe_inputEl-hubhtmleditor, iframe[id*="NamoSE_editorframe"], #NamoSE_editorframe_inputEl-hubhtmleditor');
        if (frameHandle) {
          const cFrame = await frameHandle.contentFrame();
          if (cFrame) {
            await cFrame.click('body');
            await cFrame.fill('body', bodyContent);
            editorFilled = true;
            emitLog('info', 'Editor body filled via contentFrame handle.');
          }
        }
      } catch (cFrameErr) {
        emitLog('warn', `contentFrame handle attempt: ${cFrameErr.message}`);
      }
    }

    // Upload archive file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      emitLog('info', `Attaching file: ${path.basename(tempFilePath)}...`);
      let fileAttached = false;

      // Attempt 1: Choose File button setInputFiles
      try {
        const chooseFileBtn = page.getByRole('button', { name: 'Choose File' })
          .or(page.locator('button:has-text("Choose File"), .x-btn:has-text("Choose File")'))
          .first();
        if (await chooseFileBtn.isVisible({ timeout: 3000 })) {
          await chooseFileBtn.setInputFiles(tempFilePath);
          fileAttached = true;
          emitLog('info', 'File attached via "Choose File" button setInputFiles.');
        }
      } catch (cfErr) {
        emitLog('info', `Choose File setInputFiles notice: ${cfErr.message}`);
      }

      // Attempt 2: Generic input[type="file"]
      if (!fileAttached) {
        try {
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(tempFilePath);
            fileAttached = true;
            emitLog('info', 'File attached via direct input[type="file"].');
          }
        } catch (fiErr) {
          emitLog('warn', `Generic file input attachment error: ${fiErr.message}`);
        }
      }

      if (!fileAttached) {
        emitLog('warn', 'Could not locate file uploader control on page.');
      }
    }

    // Submit form: Handled resiliently against dynamic auto-generated IDs (e.g. hubbutton-1023, hubbutton-1045)
    emitLog('info', 'Locating and clicking Submit button...');

    let submitFound = false;

    // 1. Semantic Playwright role locator (Independent of HTML tags and dynamic IDs)
    try {
      const roleSubmit = page.getByRole('button', { name: /Submit|등록|Save|저장|OK/i }).first();
      if (await roleSubmit.isVisible({ timeout: 2000 })) {
        emitLog('info', 'Located submit button via accessible role & label.');
        await roleSubmit.click();
        submitFound = true;
      }
    } catch {}

    // 2. ExtJS button selectors combining pattern matching and button text
    if (!submitFound) {
      const semanticSelectors = [
        '[id^="hubbutton"]:has-text("Submit")',
        '[id^="hubbutton"]:has-text("등록")',
        '[id^="hubbutton"]:has-text("Save")',
        '.x-btn:has-text("Submit")',
        '.x-btn:has-text("등록")',
        '.x-btn:has-text("Save")',
        '.x-btn:has-text("저장")',
        'button:has-text("Submit")',
        'button:has-text("등록")',
        'button:has-text("Save")',
        'a:has-text("Submit")',
        'a:has-text("등록")',
        'input[type="submit"]',
        'button[type="submit"]',
        '#hubbutton-1023'
      ];

      for (const sel of semanticSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1000 })) {
            emitLog('info', `Located submit button via selector: "${sel}"`);
            await btn.click();
            submitFound = true;
            break;
          }
        } catch {}
      }
    }

    if (!submitFound) {
      emitLog('warn', 'Submit button not located directly. Attempting DOM form.submit() fallback...');
      const formSubmitted = await page.evaluate(() => {
        const form = document.querySelector('form#fo_write, form.board_write, form[action*="mid=board"], form[name="write_form"], form');
        if (form && typeof form.submit === 'function') {
          form.submit();
          return true;
        }
        return false;
      }).catch(() => false);

      if (formSubmitted) {
        emitLog('info', 'Triggered form.submit() via DOM.');
        submitFound = true;
      }
    }

    if (!submitFound) {
      emitLog('error', 'Tombol Submit / 등록 tidak ditemukan pada form Mobile R&D Hub.');
      if (!headless) {
        emitLog('info', 'Visual debugging mode: Menunggu 15 detik untuk inspeksi layar PC Windows...');
        await page.waitForTimeout(15000);
      }
      throw new Error('Tombol Submit / 등록 tidak ditemukan pada form Mobile R&D Hub.');
    }

    emitLog('info', 'Menunggu respon submission dari portal...');
    await page.waitForTimeout(4000);

    const afterUrl = page.url();
    emitLog('info', `Submission selesai. Halaman aktif: ${afterUrl}`);
    emit('finished', { success: true, message: `Successfully submitted "${title}" to Mobile R&D Hub` });
  } catch (err) {
    emitLog('error', `Submission error: ${err.message}`);
    emit('finished', { success: false, message: `Submission failed: ${err.message}` });
  } finally {
    if (browser) {
      if (!headless) {
        emitLog('info', 'Visual mode: Browser akan ditutup dalam 5 detik...');
        await new Promise((r) => setTimeout(r, 5000));
      }
      try { await browser.close(); } catch {}
    }
    // Clean up temporary file created from base64 buffer
    if (tempFilePath && archiveBase64 && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  }
}

main();
