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

  const title = payload.title || 'ATM Test Result';
  const category = payload.category || 'Result';
  const hubBaseUrl = payload.hub_base_url || payload.hubBaseUrl || 'https://mobilerndhub.sec.samsung.net/hub/site/gcim/board/submission/write';
  const boardSrl = payload.board_srl || payload.boardSrl || '';
  const archivePath = payload.archive_path || payload.archivePath || '';
  const archiveBase64 = payload.archive_base64 || payload.archiveBase64 || '';
  const archiveFilename = payload.archive_filename || payload.archiveFilename || 'ATM_results.zip';
  const cookies = payload.cookies || [];
  const username = payload.username || '';
  const password = payload.password || '';
  const headless = payload.headless !== false;

  emitLog('info', `Starting submission for "${title}"`);
  emitLog('info', `Target URL: ${hubBaseUrl} (headless: ${headless})`);

  let tempFilePath = null;
  let browser = null;

  try {
    if (archiveBase64 && !archivePath) {
      tempFilePath = path.join(os.tmpdir(), `heist_upload_${Date.now()}_${archiveFilename}`);
      fs.writeFileSync(tempFilePath, Buffer.from(archiveBase64, 'base64'));
      const fileSize = fs.statSync(tempFilePath).size;
      emitLog('info', `Created temporary archive from base64: ${tempFilePath} (${fileSize} bytes)`);
    } else if (archivePath && fs.existsSync(archivePath)) {
      tempFilePath = archivePath;
      const fileSize = fs.statSync(tempFilePath).size;
      emitLog('info', `Using archive from path: ${tempFilePath} (${fileSize} bytes)`);
    } else {
      emitLog('warn', `No archive data supplied in payload (archiveBase64 len: ${archiveBase64.length}, archivePath: "${archivePath}")`);
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

    // Attempt 1: frameLocator using exact ID from trace
    try {
      const editorFrame = page.frameLocator('#NamoSE_editorframe_inputEl-hubhtmleditor, iframe[id*="NamoSE_editorframe"]');
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
        const frameHandle = await page.$('#NamoSE_editorframe_inputEl-hubhtmleditor, iframe[id*="NamoSE_editorframe"]');
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
      const baseName = path.basename(tempFilePath);
      const fileSize = fs.statSync(tempFilePath).size;
      emitLog('info', `Attaching file: ${baseName} (${Math.round(fileSize / 1024)} KB)...`);
      let fileAttached = false;

      // Attempt 1: Choose File button (click then setInputFiles matching codegen)
      try {
        const chooseFileBtn = page.getByRole('button', { name: 'Choose File' })
          .or(page.locator('button:has-text("Choose File"), .x-btn:has-text("Choose File")'))
          .first();
        if (await chooseFileBtn.isVisible({ timeout: 4000 })) {
          await chooseFileBtn.click();
          await chooseFileBtn.setInputFiles(tempFilePath);
          fileAttached = true;
          emitLog('info', 'File attached via "Choose File" button setInputFiles.');

          // Wait for file list confirmation signal (from trace: role=option with filename)
          try {
            const uploadedItem = page.locator(`[role="option"]:has-text("${baseName}"), .x-boundlist-item:has-text("${baseName}"), td:has-text("${baseName}")`).first();
            await uploadedItem.waitFor({ state: 'visible', timeout: 8000 });
            emitLog('info', `File attachment confirmed in portal list: ${baseName}`);
          } catch {
            emitLog('info', 'File attachment visual wait completed.');
            await page.waitForTimeout(3000);
          }
        }
      } catch (cfErr) {
        emitLog('info', `Choose File setInputFiles notice: ${cfErr.message}`);
      }

      // Attempt 2: Direct setInputFiles without click
      if (!fileAttached) {
        try {
          const directBtn = page.getByRole('button', { name: 'Choose File' }).first();
          if (await directBtn.count() > 0) {
            await directBtn.setInputFiles(tempFilePath);
            fileAttached = true;
            emitLog('info', 'File attached via direct Choose File setInputFiles.');
            await page.waitForTimeout(3000);
          }
        } catch (dErr) {
          emitLog('info', `Direct Choose File notice: ${dErr.message}`);
        }
      }

      // Attempt 3: Generic input[type="file"]
      if (!fileAttached) {
        try {
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(tempFilePath);
            fileAttached = true;
            emitLog('info', 'File attached via direct input[type="file"].');
            await page.waitForTimeout(3000);
          }
        } catch (fiErr) {
          emitLog('warn', `Generic file input attachment error: ${fiErr.message}`);
        }
      }

      if (!fileAttached) {
        emitLog('warn', 'Could not locate file uploader control on page.');
      }
    } else {
      emitLog('warn', `Archive file not available on disk! tempFilePath: ${tempFilePath}`);
    }

    // Submit form: Handled resiliently against dynamic auto-generated IDs (e.g. hubbutton-1023, hubbutton-1045)
    emitLog('info', 'Locating and clicking Submit button...');

    let submitFound = false;

    // Prioritized submit button selectors based on actual user Playwright codegen
    const candidateSelectors = [
      '#hubbutton-1023',
      'button[id^="hubbutton"]:has-text("Submit")',
      'button[id^="hubbutton"]:has-text("등록")',
      'a[id^="hubbutton"]:has-text("Submit")',
      'a[id^="hubbutton"]:has-text("등록")',
      '.x-toolbar .x-btn:has-text("Submit")',
      '.x-toolbar .x-btn:has-text("등록")',
      '.x-toolbar .x-btn:has-text("Save")',
      '.x-btn:has-text("Submit")',
      '.x-btn:has-text("등록")',
      '.x-btn:has-text("Save")',
      'button:has-text("Submit")',
      'button:has-text("등록")',
      'button:has-text("Save")',
      'button[id^="hubbutton-"]',
      'a[id^="hubbutton-"]',
      'input[type="submit"]',
      'button[type="submit"]'
    ];

    for (const sel of candidateSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          emitLog('info', `Located submit button via selector: "${sel}"`);
          await btn.click();
          submitFound = true;
          break;
        }
      } catch {}
    }

    // Accessible role locator fallback
    if (!submitFound) {
      try {
        const roleSubmit = page.getByRole('button', { name: /Submit|등록|Save|저장|OK/i }).first();
        if (await roleSubmit.isVisible({ timeout: 2000 })) {
          emitLog('info', 'Located submit button via accessible role.');
          await roleSubmit.click();
          submitFound = true;
        }
      } catch {}
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
    try {
      await Promise.race([
        page.waitForURL((url) => !url.href.includes('/write'), { timeout: 12000 }),
        page.locator('.x-grid-row, .board_list, internal:role=row[name*="MAIN HOME" i]').first().waitFor({ state: 'visible', timeout: 12000 })
      ]);
      emitLog('info', 'Portal transitioned successfully after submit.');
    } catch {
      await page.waitForTimeout(4000);
    }

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
