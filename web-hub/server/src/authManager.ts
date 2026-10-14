import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface HubConfig {
  hubBaseUrl: string;
  boardSrl: string;
  category: string;
  titleTemplate: string;
  autoSubmit: boolean;
  headless?: boolean;
}

export interface CookieItem {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightStorageState {
  cookies: CookieItem[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface AuthStatus {
  hasAuth: boolean;
  valid: boolean;
  cookiesCount: number;
  cookies: Array<{ name: string; domain: string; expires: number; isExpired: boolean }>;
  expiresAt: string | null;
  hasHubSessId: boolean;
  username?: string;
  hasCredentials?: boolean;
  message?: string;
}

const DEFAULT_CONFIG: HubConfig = {
  hubBaseUrl: 'https://mobilerndhub.sec.samsung.net/hub/site/gcim/board/submission/write',
  boardSrl: '',
  category: 'Result',
  titleTemplate: '[{submissionId}][{productName}][{fingerprint}][{carrier}]',
  autoSubmit: false,
  headless: true
};

function resolveDataDir(): string {
  const dir = process.env.DATA_DIR || process.env.RESULTS_DIR;
  if (dir) {
    return path.resolve(dir);
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(currentDir, '../../data');
  if (!fs.existsSync(candidate)) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch {
      return path.resolve(process.cwd(), 'data');
    }
  }
  return candidate;
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'hub_config.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

export function getAuthFilePath(): string {
  return AUTH_FILE;
}

export function getHubConfig(): HubConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // fallback to defaults on read/parse error
  }
  return { ...DEFAULT_CONFIG };
}

export function saveHubConfig(partial: Partial<HubConfig>): HubConfig {
  const current = getHubConfig();
  const updated: HubConfig = {
    ...current,
    ...partial,
    headless: partial.headless !== undefined ? Boolean(partial.headless) : (current.headless !== false)
  };
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  } catch (err) {
    console.error('[AuthManager] Failed to save hub_config.json:', err);
  }
  return updated;
}

export function getAuthStatus(): AuthStatus {
  if (!fs.existsSync(AUTH_FILE)) {
    return {
      hasAuth: false,
      valid: false,
      cookiesCount: 0,
      cookies: [],
      expiresAt: null,
      hasHubSessId: false,
      message: 'Belum ada kredensial / auth.json. Silakan masukkan username & password di menu Setting.'
    };
  }

  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const data: any = JSON.parse(raw);
    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    const username = data.username ? String(data.username) : undefined;
    const hasCredentials = Boolean(data.username && data.password);
    const nowSec = Math.floor(Date.now() / 1000);

    let minExpires = Infinity;
    let hasHubSess = false;

    const cookieSummaries = cookies.map((c: any) => {
      const exp = typeof c.expires === 'number' ? c.expires : -1;
      const isExpired = exp > 0 && exp < nowSec;
      if (c.name && c.name.toUpperCase().includes('HUBSESSID')) {
        hasHubSess = true;
      }
      if (exp > 0 && exp < minExpires) {
        minExpires = exp;
      }
      return {
        name: c.name,
        domain: c.domain || '',
        expires: exp,
        isExpired
      };
    });

    const isAllExpired = cookieSummaries.length > 0 && cookieSummaries.every((c: any) => c.isExpired);
    const valid = (cookieSummaries.length > 0 && !isAllExpired) || hasCredentials;

    let expiresAt: string | null = null;
    if (minExpires !== Infinity && minExpires > 0) {
      expiresAt = new Date(minExpires * 1000).toISOString();
    }

    let defaultMsg = valid ? 'Session tersimpan dan aktif.' : 'Session telah kedaluwarsa.';
    if (hasCredentials && cookieSummaries.length === 0) {
      defaultMsg = `Kredensial tersimpan untuk user "${username}". Siap digunakan.`;
    }

    return {
      hasAuth: true,
      valid,
      cookiesCount: cookies.length,
      cookies: cookieSummaries,
      expiresAt,
      hasHubSessId: hasHubSess,
      username,
      hasCredentials,
      message: defaultMsg
    };
  } catch (err) {
    return {
      hasAuth: true,
      valid: false,
      cookiesCount: 0,
      cookies: [],
      expiresAt: null,
      hasHubSessId: false,
      message: 'Format auth.json tidak valid atau korup.'
    };
  }
}

export function saveAuthJson(input: unknown): { success: boolean; message: string; status: AuthStatus } {
  try {
    let currentStored: any = {};
    if (fs.existsSync(AUTH_FILE)) {
      try {
        currentStored = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      } catch {}
    }

    // Check if input is credentials object { username, password }
    if (typeof input === 'object' && input !== null && ('username' in input || 'password' in input)) {
      const obj = input as any;
      const username = String(obj.username ?? currentStored.username ?? '').trim();
      const password = String(obj.password ?? currentStored.password ?? '').trim();
      const cookies = Array.isArray(obj.cookies) ? obj.cookies : (currentStored.cookies || []);
      const origins = Array.isArray(obj.origins) ? obj.origins : (currentStored.origins || []);

      const toSave = {
        username,
        password,
        cookies,
        origins
      };

      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.writeFileSync(AUTH_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
      const status = getAuthStatus();
      return {
        success: true,
        message: `Kredensial "${username}" berhasil disimpan ke auth.json.`,
        status
      };
    }

    let storageState: PlaywrightStorageState;

    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed = JSON.parse(trimmed);
        if ('username' in parsed || 'password' in parsed) {
          return saveAuthJson(parsed);
        }
        storageState = normalizeToStorageState(parsed);
      } else {
        // Plain cookie string, e.g. "HUBSESSID=xxxx; other=123"
        storageState = parseCookieString(trimmed);
      }
    } else if (typeof input === 'object' && input !== null) {
      storageState = normalizeToStorageState(input);
    } else {
      return {
        success: false,
        message: 'Payload auth tidak dikenali.',
        status: getAuthStatus()
      };
    }

    if (!Array.isArray(storageState.cookies) || storageState.cookies.length === 0) {
      return {
        success: false,
        message: 'Tidak ada cookie yang valid di dalam data yang diberikan.',
        status: getAuthStatus()
      };
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const loginIdCookie = storageState.cookies.find(
      (c) => c.name === 'EP_LOGINID' || c.name === 'LOGINID' || c.name.toLowerCase().includes('user')
    );
    const username = currentStored.username || (loginIdCookie ? loginIdCookie.value : undefined);

    const merged = {
      username,
      password: currentStored.password,
      ...storageState
    };

    fs.writeFileSync(AUTH_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    const status = getAuthStatus();
    return {
      success: true,
      message: `Berhasil menyimpan auth.json dengan ${storageState.cookies.length} cookie.`,
      status
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Gagal memproses auth: ${err?.message || String(err)}`,
      status: getAuthStatus()
    };
  }
}

export function deleteAuth(): void {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  } catch (err) {
    console.error('[AuthManager] Gagal menghapus auth.json:', err);
  }
}

function normalizeToStorageState(raw: any): PlaywrightStorageState {
  if (Array.isArray(raw.cookies)) {
    return {
      cookies: raw.cookies.map((c: any) => ({
        name: String(c.name || ''),
        value: String(c.value || ''),
        domain: String(c.domain || ''),
        path: String(c.path || '/'),
        expires: typeof c.expires === 'number' ? c.expires : Math.floor(Date.now() / 1000) + 86400 * 14,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: c.sameSite || 'Lax'
      })),
      origins: Array.isArray(raw.origins) ? raw.origins : []
    };
  }

  // If array of cookies given directly
  if (Array.isArray(raw)) {
    return normalizeToStorageState({ cookies: raw });
  }

  throw new Error('Format JSON tidak memiliki array "cookies" sesuai schema Playwright storageState.');
}

function parseCookieString(cookieStr: string): PlaywrightStorageState {
  const config = getHubConfig();
  let defaultDomain = 'mobilerndhub.sec.samsung.net';
  if (config.hubBaseUrl) {
    try {
      const u = new URL(config.hubBaseUrl);
      defaultDomain = u.hostname;
    } catch {
      // ignore URL parse failure
    }
  }

  const cookies: CookieItem[] = [];
  const defaultExp = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days default

  if (cookieStr.includes('\t')) {
    const lines = cookieStr.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const cols = line.split('\t').map((c) => c.trim());
      if (cols.length >= 2 && cols[0]) {
        const name = cols[0];
        const value = cols[1];
        let domain = cols[2] || defaultDomain;
        const path = cols[3] || '/';
        let expires = defaultExp;
        if (cols[4] && cols[4] !== 'Session') {
          const parsedDate = Date.parse(cols[4]);
          if (!isNaN(parsedDate)) {
            expires = Math.floor(parsedDate / 1000);
          }
        }
        const isHttpOnly = cols.some((c) => c.includes('✓') || c.toLowerCase() === 'httponly') ||
          name.toUpperCase().includes('SESS') || name.toUpperCase().includes('TOKEN');
        const sameSite: any = cols.includes('Lax') ? 'Lax' : cols.includes('Strict') ? 'Strict' : cols.includes('None') ? 'None' : 'Lax';

        cookies.push({
          name,
          value,
          domain,
          path,
          expires,
          httpOnly: isHttpOnly,
          secure: true,
          sameSite
        });
      }
    }
  } else {
    const pairs = cookieStr.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.substring(0, idx).trim();
        const value = pair.substring(idx + 1).trim();
        if (name) {
          cookies.push({
            name,
            value,
            domain: defaultDomain,
            path: '/',
            expires: defaultExp,
            httpOnly: name.toUpperCase().includes('SESS') || name.toUpperCase().includes('TOKEN'),
            secure: true,
            sameSite: 'Lax'
          });
        }
      }
    }
  }

  return {
    cookies,
    origins: [{ origin: 'https://mobilerndhub.sec.samsung.net', localStorage: [] }]
  };
}

async function getChromium(): Promise<any | null> {
  try {
    const pw: any = await import('' + 'playwright');
    return pw.chromium || null;
  } catch {
    return null;
  }
}

function getChromiumLaunchOptions(headless = true): any {
  const options: any = {
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  };

  const candidatePaths = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ].filter(Boolean) as string[];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      options.executablePath = p;
      break;
    }
  }

  return options;
}

export async function loginWithCredentials(userParam?: string, passParam?: string): Promise<{ ok: boolean; status: number; message: string }> {
  const config = getHubConfig();
  if (!config.hubBaseUrl) {
    return { ok: false, status: 400, message: 'Mobile R&D Hub Base URL belum dikonfigurasi pada menu setting.' };
  }

  let username = userParam;
  let password = passParam;
  if (!username || !password) {
    if (fs.existsSync(AUTH_FILE)) {
      try {
        const stored = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
        username = username || stored.username;
        password = password || stored.password;
      } catch {}
    }
  }

  if (!username || !password) {
    return { ok: false, status: 400, message: 'Username dan Password belum tersimpan.' };
  }

  const chromium = await getChromium();
  if (!chromium) {
    return { ok: false, status: 400, message: 'Playwright tidak terpasang di server. Gunakan ekstensi browser untuk menyimpan session cookies ke auth.json.' };
  }

  let browser;
  try {
    browser = await chromium.launch(getChromiumLaunchOptions(true));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(config.hubBaseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const userInput = page.locator('input[name="user_id"], input[name="username"], input[name="login_id"], input[id*="user" i], input[type="text"]').first();
    const passInput = page.locator('input[name="password"], input[name="passwd"], input[id*="pass" i], input[type="password"]').first();

    if (await userInput.isVisible({ timeout: 4000 }) && await passInput.isVisible({ timeout: 4000 })) {
      await userInput.fill(username);
      await passInput.fill(password);
      const submitBtn = page.locator('button:has-text("Login"), button:has-text("Sign in"), button:has-text("로그인"), input[type="submit"], button[type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 2000 })) {
        await submitBtn.click();
      } else {
        await passInput.press('Enter');
      }
      await page.waitForTimeout(4000);
    }

    const storage = await context.storageState();
    saveAuthJson({
      ...storage,
      username,
      password
    });

    await browser.close();
    return { ok: true, status: 200, message: `Autentikasi Playwright berhasil untuk user "${username}". Session disimpan ke auth.json.` };
  } catch (err: any) {
    if (browser) try { await browser.close(); } catch {}
    return { ok: false, status: 500, message: `Gagal login otomatis ke Hub: ${err?.message || String(err)}` };
  }
}

export async function verifyHubSession(): Promise<{ ok: boolean; status: number; message: string }> {
  const config = getHubConfig();
  if (!config.hubBaseUrl) {
    return {
      ok: false,
      status: 400,
      message: 'Mobile R&D Hub Base URL belum dikonfigurasi pada menu setting.'
    };
  }

  if (!fs.existsSync(AUTH_FILE)) {
    return {
      ok: false,
      status: 401,
      message: 'Kredensial belum ada. Silakan masukkan username & password di menu Setting.'
    };
  }

  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const state: any = JSON.parse(raw);
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];

    // If no cookies yet but credentials exist, attempt automated login via Playwright
    if (cookies.length === 0 && state.username && state.password) {
      return await loginWithCredentials(state.username, state.password);
    }

    const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');

    const targetUrl = config.hubBaseUrl.endsWith('/') ? config.hubBaseUrl : `${config.hubBaseUrl}/`;
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      redirect: 'manual'
    });

    const location = res.headers.get('location') || '';

    // If redirected to login, sso, or auth endpoint, session is expired/invalid
    if (res.status === 302 || res.status === 301) {
      if (location.toLowerCase().includes('login') || location.toLowerCase().includes('sso') || location.toLowerCase().includes('auth')) {
        if (state.username && state.password) {
          return await loginWithCredentials(state.username, state.password);
        }
        return {
          ok: false,
          status: 401,
          message: `Session ditolak oleh server (dialihkan ke halaman login: ${location}).`
        };
      }
      return {
        ok: true,
        status: res.status,
        message: `Koneksi aktif (Redirected to: ${location}).`
      };
    }

    if (res.status === 200) {
      const text = await res.text();
      if (text.includes('450') && text.includes('Error')) {
        return {
          ok: false,
          status: 450,
          message: 'Server merespons dengan 450 Permission/Session Error.'
        };
      }
      return {
        ok: true,
        status: 200,
        message: 'Session valid! Terhubung ke Mobile R&D Hub.'
      };
    }

    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      message: `Server merespons status HTTP ${res.status}.`
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 500,
      message: `Gagal menghubungi Hub: ${err?.message || String(err)}`
    };
  }
}

export async function launchInteractiveLogin(): Promise<{ ok: boolean; message: string }> {
  const config = getHubConfig();
  if (!config.hubBaseUrl) {
    return {
      ok: false,
      message: 'Mobile R&D Hub Base URL belum dikonfigurasi.'
    };
  }

  const chromium = await getChromium();
  if (!chromium) {
    return { ok: false, message: 'Browser login tidak tersedia di server. Gunakan ekstensi browser pada PC intranet untuk sync session.' };
  }

  let browser;
  try {
    const launchOpts = getChromiumLaunchOptions(false);
    launchOpts.args.push('--start-maximized');
    browser = await chromium.launch(launchOpts);

    const context = await browser.newContext({
      viewport: null
    });

    const page = await context.newPage();
    await page.goto(config.hubBaseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait until browser is either closed by user or cookies are captured
    let cookiesCaptured = false;
    const pollInterval = setInterval(async () => {
      try {
        const cookies = await context.cookies();
        const hasHubSess = cookies.some((c: any) => c.name.toUpperCase().includes('HUBSESSID'));
        if (hasHubSess && !cookiesCaptured) {
          cookiesCaptured = true;
          const storage = await context.storageState();
          saveAuthJson(storage);
        }
      } catch {
        clearInterval(pollInterval);
      }
    }, 3000);

    // Keep open until user closes browser or navigates
    await page.waitForEvent('close', { timeout: 300000 });
    clearInterval(pollInterval);

    // Final capture
    try {
      const storage = await context.storageState();
      saveAuthJson(storage);
    } catch {
      // browser may already be destroyed
    }

    await browser.close();
    return {
      ok: true,
      message: 'Sesi login berhasil disimpan ke auth.json.'
    };
  } catch (err: any) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return {
      ok: false,
      message: `Browser login dibatalkan atau gagal: ${err?.message || String(err)}`
    };
  }
}

// ponytail: submit ZIP archive to Mobile R&D Hub via Playwright
export async function submitToMobileRndHub(payload: {
  title: string;
  category?: string;
  archiveBuffer?: Buffer;
  archiveFilename?: string;
}): Promise<{ ok: boolean; message: string }> {
  console.log(`[SubmitHub] ===================================================`);
  console.log(`[SubmitHub] [START] Memulai proses submit ke Mobile R&D Hub`);
  console.log(`[SubmitHub] Judul Post : "${payload.title}"`);

  const config = getHubConfig();
  const isHeadless = config.headless !== false;
  console.log(`[SubmitHub] Mode Browser: ${isHeadless ? 'Headless (latar belakang)' : 'Non-Headless (visible GUI)'}`);
  console.log(`[SubmitHub] Target URL  : ${config.hubBaseUrl || '(belum diisi)'}`);

  if (!config.hubBaseUrl) {
    console.error(`[SubmitHub] [GAGAL] Mobile R&D Hub Base URL belum dikonfigurasi.`);
    return { ok: false, message: 'Mobile R&D Hub Base URL belum dikonfigurasi di menu Setting.' };
  }

  const authStatus = getAuthStatus();
  if (!authStatus.hasAuth || !authStatus.valid) {
    console.error(`[SubmitHub] [GAGAL] SSO Auth belum valid atau expired (${authStatus.message || 'Status invalid'}).`);
    return { ok: false, message: 'SSO Auth belum valid atau expired. Silakan perbarui auth.json di menu Setting.' };
  }

  const authPath = getAuthFilePath();
  if (!fs.existsSync(authPath)) {
    console.error(`[SubmitHub] [GAGAL] File auth.json tidak ditemukan di ${authPath}`);
    return { ok: false, message: 'File auth.json tidak ditemukan.' };
  }

  const chromium = await getChromium();
  if (!chromium) {
    console.error(`[SubmitHub] [GAGAL] Playwright tidak terpasang di server.`);
    return { ok: false, message: 'Playwright tidak aktif di server Hub. Pastikan node Bridge terhubung untuk menjalankan submission via intranet.' };
  }

  let browser;
  try {
    const launchOpts = getChromiumLaunchOptions(isHeadless);
    console.log(`[SubmitHub] Meluncurkan Chromium (${launchOpts.executablePath || 'bundled Chromium'}, headless=${launchOpts.headless})...`);
    browser = await chromium.launch(launchOpts);

    let contextOptions: any = {};
    let cookiesCount = 0;
    try {
      const stored = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      if (Array.isArray(stored.cookies) && stored.cookies.length > 0) {
        contextOptions.storageState = authPath;
        cookiesCount = stored.cookies.length;
      }
    } catch (err: any) {
      console.warn(`[SubmitHub] [WARN] Gagal parse cookies auth.json: ${err?.message}`);
    }

    console.log(`[SubmitHub] Menyiapkan browser context dengan ${cookiesCount} cookies aktif...`);
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const writeUrl = (config.hubBaseUrl.includes('/board/') && config.hubBaseUrl.includes('/write'))
      ? config.hubBaseUrl
      : config.boardSrl
        ? `${config.hubBaseUrl.replace(/\/$/, '')}/index.php?mid=board&act=dispBoardWrite&board_srl=${config.boardSrl}`
        : config.hubBaseUrl;

    console.log(`[SubmitHub] Membuka URL submission: ${writeUrl}`);
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    console.log(`[SubmitHub] Halaman berhasil dimuat. URL saat ini: ${page.url()}`);

    // Detect if redirected to SSO login page and attempt auto-login
    let currentUrl = page.url();
    if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso')) {
      console.log(`[SubmitHub] Terdeteksi redirect ke SSO Login: ${currentUrl}`);
      let authData: any = {};
      try {
        authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      } catch {}

      if (authData.username && authData.password) {
        console.log(`[SubmitHub] Mencoba auto-fill login SSO untuk user "${authData.username}"...`);
        try {
          const userInput = page.locator('input[name="user_id"], input[name="username"], input[name="login_id"], input[id*="user" i], input[type="text"]').first();
          const passInput = page.locator('input[name="password"], input[name="passwd"], input[id*="pass" i], input[type="password"]').first();
          if (await userInput.isVisible({ timeout: 4000 }) && await passInput.isVisible({ timeout: 4000 })) {
            await userInput.fill(authData.username);
            await passInput.fill(authData.password);
            console.log(`[SubmitHub] Kredensial terisi, menekan tombol login...`);
            const submitLoginBtn = page.locator('button:has-text("Login"), button:has-text("Sign in"), button:has-text("로그인"), input[type="submit"], button[type="submit"]').first();
            if (await submitLoginBtn.isVisible({ timeout: 2000 })) {
              await submitLoginBtn.click();
            } else {
              await passInput.press('Enter');
            }
            await page.waitForTimeout(4000);
            try {
              const updatedState = await context.storageState();
              saveAuthJson({ ...updatedState, username: authData.username, password: authData.password });
              console.log(`[SubmitHub] Storage state pasca-login berhasil diperbarui.`);
            } catch {}
          }
        } catch (loginErr: any) {
          console.warn('[SubmitHub] [WARN] Auto-login error:', loginErr?.message || loginErr);
        }
      }

      currentUrl = page.url();
      if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso')) {
        console.error(`[SubmitHub] [GAGAL] Masih berada di halaman login SSO (${currentUrl}). Memerlukan 2FA atau update session.`);
        await browser.close();
        return { ok: false, message: 'Session SSO expired atau butuh verifikasi 2FA. Silakan perbarui cookies di menu Setting.' };
      }
    }

    // Set Category
    const targetCategory = payload.category || config.category || 'Result';
    console.log(`[SubmitHub] Mengisi Category: "${targetCategory}"...`);
    try {
      const catInput = page.locator('input[name="category_srl"], #category_combo input, select[name="category_srl"]').first();
      if (await catInput.isVisible({ timeout: 2500 })) {
        await catInput.fill(targetCategory);
      }
    } catch {
      // ExtJS combobox might already default or have custom picker
    }

    // Set Title
    console.log(`[SubmitHub] Mengisi Title: "${payload.title}"...`);
    const titleInput = page.locator('input[name="title"], #title, input.x-form-text[name="title"]').first();
    if (await titleInput.isVisible({ timeout: 3000 })) {
      await titleInput.fill(payload.title);
    } else {
      console.warn(`[SubmitHub] [WARN] Elemen input Title tidak ditemukan dengan selector standar.`);
    }

    // Upload ZIP file if provided
    if (payload.archiveBuffer && payload.archiveFilename) {
      const sizeMb = (payload.archiveBuffer.length / 1024 / 1024).toFixed(2);
      console.log(`[SubmitHub] Mengunggah artefak ZIP: "${payload.archiveFilename}" (${sizeMb} MB)...`);
      const tempUploadPath = path.join(DATA_DIR, `temp_upload_${Date.now()}_${payload.archiveFilename}`);
      fs.writeFileSync(tempUploadPath, payload.archiveBuffer);

      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
        const uploaderBtn = page.locator('.webix_uploader, input[type="file"], button:has-text("Upload"), .x-btn:has-text("Upload")').first();
        if (await uploaderBtn.isVisible({ timeout: 2000 })) {
          await uploaderBtn.click();
          const chooser = await fileChooserPromise;
          if (chooser) {
            await chooser.setFiles(tempUploadPath);
            console.log(`[SubmitHub] File berhasil diset melalui filechooser.`);
          }
        } else {
          const directFileInput = page.locator('input[type="file"]').first();
          if ((await directFileInput.count()) > 0) {
            await directFileInput.setInputFiles(tempUploadPath);
            console.log(`[SubmitHub] File berhasil diset langsung pada input[type="file"].`);
          } else {
            console.warn(`[SubmitHub] [WARN] Input file uploader tidak ditemukan.`);
          }
        }
      } catch (uploadErr: any) {
        console.warn('[SubmitHub] [WARN] Upload file interaction:', uploadErr?.message || uploadErr);
      } finally {
        try { fs.unlinkSync(tempUploadPath); } catch {}
      }
    }

    // Submit form
    console.log(`[SubmitHub] Mengirim form (mencari tombol Submit/등록)...`);
    const submitBtn = page.locator('button:has-text("Submit"), button:has-text("등록"), input[type="submit"], .btn-submit').first();
    if (await submitBtn.isVisible({ timeout: 2500 })) {
      await submitBtn.click();
      console.log(`[SubmitHub] Tombol submit diklik. Menunggu 3 detik...`);
      await page.waitForTimeout(3000);
    } else {
      console.warn(`[SubmitHub] [WARN] Tombol submit tidak ditemukan.`);
    }

    console.log(`[SubmitHub] [SUKSES] Submission selesai untuk: "${payload.title}"`);
    console.log(`[SubmitHub] ===================================================`);
    await browser.close();
    return { ok: true, message: `Berhasil submit ke Mobile R&D Hub: "${payload.title}"` };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[SubmitHub] [GAGAL] Error saat Playwright submission: ${errMsg}`);
    if (errMsg.includes('Timeout') && errMsg.includes('navigating to')) {
      console.error(`[SubmitHub] [DIAGNOSTIK] Koneksi timeout ke host tujuan. Pastikan server terhubung ke intranet/VPN Samsung.`);
    }
    console.error(`[SubmitHub] ===================================================`);
    if (browser) {
      try { await browser.close(); } catch {}
    }

    let userMessage = `Gagal submit via Playwright: ${errMsg}`;
    if (errMsg.includes('Timeout') && errMsg.includes('navigating to')) {
      userMessage += ' (Koneksi ke portal timeout. Pastikan server terhubung ke jaringan intranet/VPN Samsung)';
    }

    return {
      ok: false,
      message: userMessage
    };
  }
}

