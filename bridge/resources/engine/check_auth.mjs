import fs from 'fs';

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

  throw new Error('Package "playwright" belum terinstall di PC Windows. Jalankan "npm install -g playwright" di terminal PC Windows, atau salin session cookies aktif dari browser.');
}

async function attemptPlaywrightLogin(loginUrl, username, password, headless = true) {
  const chromium = await getChromium();
  const launchOpts = getChromiumLaunchOptions(headless);
  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const userInput = page.locator('#userNameInput, input[name="UserName"], input[name="user_id"], input[name="username"], input[name="login_id"], input[id*="user" i], input[type="text"]').first();
    const passInput = page.locator('#passwordInput, input[name="Password"], input[name="password"], input[name="passwd"], input[id*="pass" i], input[type="password"]').first();

    if (await userInput.isVisible({ timeout: 5000 }) && await passInput.isVisible({ timeout: 5000 })) {
      await userInput.fill(username);
      await passInput.fill(password);
      const submitBtn = page.locator('#submitButton, span#submitButton, button#submitButton, input[type="submit"], button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
      if (await submitBtn.isVisible({ timeout: 3000 })) {
        await submitBtn.click();
      } else {
        await passInput.press('Enter');
      }

      try {
        await page.waitForURL((url) => !url.href.includes('sts.secsso.net') && !url.href.includes('/adfs/'), { timeout: 15000 });
      } catch {}
      await page.waitForTimeout(3000);
    }

    const currentUrl = page.url();
    if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso') || currentUrl.toLowerCase().includes('adfs')) {
      throw new Error('Halaman tetap berada di portal login SSO setelah submit kredensial.');
    }

    const cookies = await context.cookies();
    return cookies;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (err) {
    process.stdout.write(JSON.stringify({ success: false, message: `Invalid input JSON: ${err.message}` }) + '\n');
    return;
  }

  const { hub_base_url, cookies, username = '', password = '', headless = true } = payload;
  if (!hub_base_url) {
    process.stdout.write(JSON.stringify({ success: false, message: 'URL portal belum ditentukan.' }) + '\n');
    return;
  }

  let cookieHeader = '';
  if (Array.isArray(cookies)) {
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } else if (typeof cookies === 'string') {
    cookieHeader = cookies;
  }

  try {
    const res = await fetch(hub_base_url, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      redirect: 'manual'
    });

    const location = res.headers.get('location') || '';

    if (res.status === 302 || res.status === 301) {
      if (location.toLowerCase().includes('login') || location.toLowerCase().includes('sso') || location.toLowerCase().includes('auth') || location.toLowerCase().includes('adfs')) {
        if (username && password) {
          try {
            const newCookies = await attemptPlaywrightLogin(location || hub_base_url, username, password, headless);
            if (newCookies && newCookies.length > 0) {
              process.stdout.write(JSON.stringify({
                success: true,
                status: 200,
                message: `Login SSO berhasil untuk user "${username}"! Session cookies baru telah diperbarui.`,
                cookies: newCookies
              }) + '\n');
              return;
            }
          } catch (loginErr) {
            process.stdout.write(JSON.stringify({
              success: false,
              message: `Cookies lama kedaluwarsa. Login SSO otomatis untuk "${username}" gagal: ${loginErr.message}`
            }) + '\n');
            return;
          }
        }

        process.stdout.write(JSON.stringify({
          success: false,
          status: res.status,
          message: `Cookies ditolak: dialihkan ke login SSO (${location}). Masukkan username & password untuk login otomatis.`
        }) + '\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        success: true,
        status: res.status,
        message: `Koneksi aktif! (Status ${res.status}, Redirect: ${location})`
      }) + '\n');
      return;
    }

    if (res.status === 200) {
      const text = await res.text();
      if (text.includes('450') && text.includes('Error')) {
        process.stdout.write(JSON.stringify({
          success: false,
          status: 450,
          message: 'Server portal merespons 450 Permission/Session Error.'
        }) + '\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        success: true,
        status: 200,
        message: 'Koneksi sukses! Session cookies valid dan diterima portal Mobile R&D Hub.'
      }) + '\n');
      return;
    }

    process.stdout.write(JSON.stringify({
      success: res.status >= 200 && res.status < 400,
      status: res.status,
      message: `Server portal merespons dengan status HTTP ${res.status}.`
    }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({
      success: false,
      message: `Gagal menghubungi portal intranet: ${err.message}`
    }) + '\n');
  }
}

main();
