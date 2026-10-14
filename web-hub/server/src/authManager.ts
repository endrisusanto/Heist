import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

export interface HubConfig {
  hubBaseUrl: string;
  boardSrl: string;
  category: string;
  titleTemplate: string;
  autoSubmit: boolean;
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
  message?: string;
}

const DEFAULT_CONFIG: HubConfig = {
  hubBaseUrl: '',
  boardSrl: '',
  category: 'Result',
  titleTemplate: '[{submissionId}][{productName}][{fingerprint}][{carrier}]',
  autoSubmit: false
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
    ...partial
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
      message: 'Belum ada auth.json. Silakan upload atau login via browser.'
    };
  }

  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const data: PlaywrightStorageState = JSON.parse(raw);
    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    const nowSec = Math.floor(Date.now() / 1000);

    let minExpires = Infinity;
    let hasHubSess = false;

    const cookieSummaries = cookies.map((c) => {
      const exp = typeof c.expires === 'number' ? c.expires : -1;
      const isExpired = exp > 0 && exp < nowSec;
      if (c.name.toUpperCase().includes('HUBSESSID')) {
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

    const isAllExpired = cookieSummaries.length > 0 && cookieSummaries.every((c) => c.isExpired);
    const valid = cookieSummaries.length > 0 && !isAllExpired;

    let expiresAt: string | null = null;
    if (minExpires !== Infinity && minExpires > 0) {
      expiresAt = new Date(minExpires * 1000).toISOString();
    }

    return {
      hasAuth: true,
      valid,
      cookiesCount: cookies.length,
      cookies: cookieSummaries,
      expiresAt,
      hasHubSessId: hasHubSess,
      message: valid ? 'Session tersimpan dan aktif.' : 'Session telah kedaluwarsa.'
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
    let storageState: PlaywrightStorageState;

    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed = JSON.parse(trimmed);
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

    fs.writeFileSync(AUTH_FILE, JSON.stringify(storageState, null, 2), 'utf-8');
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
  let domain = 'localhost';
  if (config.hubBaseUrl) {
    try {
      const u = new URL(config.hubBaseUrl);
      domain = u.hostname;
    } catch {
      // ignore URL parse failure
    }
  }

  const pairs = cookieStr.split(';');
  const cookies: CookieItem[] = [];
  const defaultExp = Math.floor(Date.now() / 1000) + 86400 * 14;

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const name = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      if (name) {
        cookies.push({
          name,
          value,
          domain,
          path: '/',
          expires: defaultExp,
          httpOnly: name.toUpperCase().includes('SESS') || name.toUpperCase().includes('TOKEN'),
          secure: config.hubBaseUrl.startsWith('https:'),
          sameSite: 'Lax'
        });
      }
    }
  }

  return {
    cookies,
    origins: config.hubBaseUrl ? [{ origin: config.hubBaseUrl, localStorage: [] }] : []
  };
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
      message: 'auth.json belum ada. Silakan upload atau login terlebih dahulu.'
    };
  }

  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const state: PlaywrightStorageState = JSON.parse(raw);
    const cookieHeader = (state.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');

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

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized']
    });

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
        const hasHubSess = cookies.some((c) => c.name.toUpperCase().includes('HUBSESSID'));
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
  const config = getHubConfig();
  if (!config.hubBaseUrl) {
    return { ok: false, message: 'Mobile R&D Hub Base URL belum dikonfigurasi di menu Setting.' };
  }

  const authStatus = getAuthStatus();
  if (!authStatus.hasAuth || !authStatus.valid) {
    return { ok: false, message: 'SSO Auth belum valid atau expired. Silakan perbarui auth.json di menu Setting.' };
  }

  const authPath = getAuthFilePath();
  if (!fs.existsSync(authPath)) {
    return { ok: false, message: 'File auth.json tidak ditemukan.' };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: authPath });
    const page = await context.newPage();

    const writeUrl = config.boardSrl
      ? `${config.hubBaseUrl.replace(/\/$/, '')}/index.php?mid=board&act=dispBoardWrite&board_srl=${config.boardSrl}`
      : config.hubBaseUrl;

    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Detect if redirected to SSO login page
    const currentUrl = page.url();
    if (currentUrl.toLowerCase().includes('login') || currentUrl.toLowerCase().includes('sso')) {
      await browser.close();
      return { ok: false, message: 'Session SSO expired (dialihkan ke halaman login). Silakan perbarui auth.json.' };
    }

    // Set Category to "Result"
    const targetCategory = payload.category || config.category || 'Result';
    try {
      const catInput = page.locator('input[name="category_srl"], #category_combo input, select[name="category_srl"]').first();
      if (await catInput.isVisible({ timeout: 2500 })) {
        await catInput.fill(targetCategory);
      }
    } catch {
      // ExtJS combobox might already default or have custom picker
    }

    // Set Title
    const titleInput = page.locator('input[name="title"], #title, input.x-form-text[name="title"]').first();
    if (await titleInput.isVisible({ timeout: 3000 })) {
      await titleInput.fill(payload.title);
    }

    // Upload ZIP file if provided
    if (payload.archiveBuffer && payload.archiveFilename) {
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
          }
        } else {
          const directFileInput = page.locator('input[type="file"]').first();
          if ((await directFileInput.count()) > 0) {
            await directFileInput.setInputFiles(tempUploadPath);
          }
        }
      } catch (uploadErr) {
        console.warn('[SubmitHub] Upload interaction:', uploadErr);
      } finally {
        try { fs.unlinkSync(tempUploadPath); } catch {}
      }
    }

    // Submit form
    const submitBtn = page.locator('button:has-text("Submit"), button:has-text("등록"), input[type="submit"], .btn-submit').first();
    if (await submitBtn.isVisible({ timeout: 2500 })) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
    }

    await browser.close();
    return { ok: true, message: `Berhasil submit ke Mobile R&D Hub: "${payload.title}"` };
  } catch (err: any) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return {
      ok: false,
      message: `Gagal submit via Playwright: ${err?.message || String(err)}`
    };
  }
}

