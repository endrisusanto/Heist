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

  const { hub_base_url, cookies } = payload;
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
      if (location.toLowerCase().includes('login') || location.toLowerCase().includes('sso') || location.toLowerCase().includes('auth')) {
        process.stdout.write(JSON.stringify({
          success: false,
          status: res.status,
          message: `Cookies ditolak: dialihkan ke login SSO (${location}). Perbarui cookies session.`
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
