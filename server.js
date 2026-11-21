const fs = require('fs');
const path = require('path');

// Load .env from the same directory if present (useful when hosting has no Env UI)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

const express = require('express');
const puppeteer = require('puppeteer');
const wa = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SCRAPER_TOKEN || '';

app.use(express.json({ limit: '1mb' }));

function isAuthorized(req) {
  if (!TOKEN) {
    return true;
  }
  const provided = req.headers['x-scraper-token'] || req.query.token || '';
  return provided === TOKEN;
}

function requireAuth(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

function isAllowedGoogleUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'www.google.co.id' || parsed.hostname === 'www.google.com') &&
      parsed.pathname === '/search'
    );
  } catch {
    return false;
  }
}

app.get('/', (req, res) => {
  const waState = wa.getStatus();
  res.json({
    ok: true,
    service: 'yaraci-node-scraper',
    node: process.version,
    whatsapp: waState.status,
  });
});

app.get('/health', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const version = await browser.version();
    res.json({ ok: true, node: process.version, browser: version });
  } catch (err) {
    res.status(500).json({ ok: false, node: process.version, error: err.message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.get('/scrape', requireAuth, async (req, res) => {
  const targetUrl = String(req.query.url || '');
  if (!isAllowedGoogleUrl(targetUrl)) {
    return res.status(400).json({ ok: false, error: 'Invalid or disallowed Google Search URL' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();

    res.json({ ok: true, html });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.get('/wa/status', requireAuth, async (req, res) => {
  try {
    if (req.query.start === '1') {
      await wa.startWhatsApp();
    }
    const { qrDataUrl, ...summary } = wa.getStatus();
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatConnectedPhone(user) {
  if (!user || !user.id) return 'Perangkat Aktif';
  const raw = String(user.id).split(':')[0].split('@')[0];
  return user.name ? `${user.name} (+${raw})` : `+${raw}`;
}

app.post('/wa/reconnect', requireAuth, async (req, res) => {
  try {
    await wa.startWhatsApp();
    const { qrDataUrl, ...summary } = wa.getStatus();
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/wa/qr', requireAuth, async (req, res) => {
  try {
    const action = String(req.query.action || '').toLowerCase();
    let flash = '';

    if (action === 'logout') {
      await wa.logoutWhatsApp();
      flash = 'Sesi WhatsApp berhasil diputus. Klik "Koneksi Ulang" untuk memunculkan QR baru.';
    } else if (action === 'reconnect') {
      await wa.startWhatsApp();
      flash = 'Mencoba menyambungkan ulang ke WhatsApp...';
    } else {
      await wa.startWhatsApp();
    }

    const state = wa.getStatus();
    const tokenParam = req.query.token ? `token=${encodeURIComponent(String(req.query.token))}&` : '';
    const baseHref = req.query.token ? `?token=${encodeURIComponent(String(req.query.token))}` : '?';
    const reconnectHref = `?${tokenParam}action=reconnect`;
    const logoutHref = `?${tokenParam}action=logout`;
    const shouldAutoRefresh = !state.connected && action !== 'logout';

    const statusBadge = state.connected
      ? '<span class="badge badge-online"><span class="dot"></span>Terhubung (Online)</span>'
      : state.status === 'qr'
        ? '<span class="badge badge-qr"><span class="dot"></span>Menunggu Scan QR</span>'
        : state.status === 'connecting'
          ? '<span class="badge badge-wait"><span class="dot"></span>Menghubungkan...</span>'
          : '<span class="badge badge-off"><span class="dot"></span>Terputus (Offline)</span>';

    const mainContent = state.connected
      ? `<div class="connected-box">
          <div class="check-circle">✓</div>
          <h2>WhatsApp Siap Digunakan</h2>
          <p class="account-pill">${escapeHtml(formatConnectedPhone(state.user))}</p>
          <p class="hint">Broadcast dari LMS <b>course.yaracienglish.com</b> jalur <b>Node.js (Baileys)</b> sudah aktif.</p>
        </div>`
      : state.qrDataUrl
        ? `<div class="qr-box">
            <img src="${state.qrDataUrl}" alt="WhatsApp QR Code" class="qr-img" />
            <ol class="steps">
              <li>Buka <b>WhatsApp</b> di HP Anda</li>
              <li>Pilih menu <b>Perangkat Tertaut</b> &rarr; <b>Tautkan Perangkat</b></li>
              <li>Arahkan kamera ke QR Code di atas</li>
            </ol>
          </div>`
        : `<div class="loading-box">
            <div class="spinner"></div>
            <h2>${action === 'logout' ? 'Sesi Terputus' : 'Menyiapkan Koneksi WhatsApp...'}</h2>
            <p class="hint">${state.lastError ? escapeHtml(state.lastError) : 'Status: ' + escapeHtml(state.status) + (shouldAutoRefresh ? ' • Halaman refresh otomatis tiap 5 detik.' : '')}</p>
          </div>`;

    res.type('html').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${shouldAutoRefresh ? `<meta http-equiv="refresh" content="5;url=${escapeHtml(baseHref)}" />` : ''}
  <title>WhatsApp Node.js Console — Yaraci English</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#0f766e 100%);color:#0f172a}
    .card{width:100%;max-width:460px;background:#ffffff;border-radius:22px;padding:28px;box-shadow:0 24px 60px rgba(0,0,0,.35);text-align:center}
    .header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #e2e8f0}
    .brand{text-align:left}
    .brand h1{margin:0;font-size:1.05rem;font-weight:800;color:#0f172a}
    .brand small{color:#64748b;font-size:.78rem}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:.75rem;font-weight:700;white-space:nowrap}
    .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
    .badge-online{background:#dcfce7;color:#15803d}
    .badge-qr{background:#fef9c3;color:#a16207}
    .badge-wait{background:#e0f2fe;color:#0369a1}
    .badge-off{background:#fee2e2;color:#b91c1c}
    .flash{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:12px;padding:10px 12px;font-size:.82rem;margin-bottom:16px}
    .qr-box{padding:8px 0}
    .qr-img{width:260px;height:260px;padding:10px;background:#fff;border:2px solid #e2e8f0;border-radius:16px;box-shadow:0 8px 24px rgba(15,23,42,.08)}
    .steps{text-align:left;margin:16px auto 0;max-width:340px;padding-left:20px;color:#475569;font-size:.86rem;line-height:1.6}
    .connected-box{padding:16px 8px}
    .check-circle{width:64px;height:64px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:32px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px rgba(22,163,74,.3)}
    .account-pill{display:inline-block;background:#f1f5f9;color:#0f172a;font-weight:700;padding:8px 16px;border-radius:999px;font-size:.92rem;margin:6px 0 10px}
    .loading-box{padding:24px 8px}
    .spinner{width:42px;height:42px;margin:0 auto 14px;border:4px solid #e2e8f0;border-top-color:#0ea5e9;border-radius:50%;animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    h2{margin:6px 0;font-size:1.15rem;color:#0f172a}
    .hint{margin:6px 0 0;color:#64748b;font-size:.84rem;line-height:1.5}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px;padding-top:18px;border-top:1px solid #e2e8f0}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 14px;border-radius:12px;font-size:.85rem;font-weight:700;text-decoration:none;border:none;cursor:pointer;transition:transform .15s,opacity .15s}
    .btn:hover{transform:translateY(-1px);opacity:.94}
    .btn-primary{background:linear-gradient(135deg,#0284c7,#0ea5e9);color:#fff}
    .btn-danger{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff}
    .btn-ghost{grid-column:1/-1;background:#f1f5f9;color:#334155}
    .footer{margin-top:16px;font-size:.74rem;color:#94a3b8}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="brand">
        <h1>Yaraci WhatsApp Node</h1>
        <small>Node ${escapeHtml(process.version)} • Baileys Self-Hosted</small>
      </div>
      ${statusBadge}
    </div>
    ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}
    ${mainContent}
    <div class="actions">
      <a href="${escapeHtml(reconnectHref)}" class="btn btn-primary">↻ Koneksi Ulang</a>
      <a href="${escapeHtml(logoutHref)}" class="btn btn-danger" onclick="return confirm('Putuskan sesi WhatsApp saat ini dan ganti nomor?')">⏻ Logout / Putuskan</a>
      <a href="${escapeHtml(baseHref)}" class="btn btn-ghost">⟳ Refresh Status</a>
    </div>
    <div class="footer">appnode.yaracienglish.com • Yaraci English LMS</div>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).type('text/plain').send(`Error: ${err.message}`);
  }
});

app.post('/wa/send', requireAuth, async (req, res) => {
  try {
    const result = await wa.sendText(req.body?.phone, req.body?.message, req.body?.mediaUrl || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/wa/broadcast', requireAuth, async (req, res) => {
  try {
    const results = await wa.sendBroadcast(req.body?.phones, req.body?.message, {
      delayMinMs: req.body?.delayMinMs,
      delayMaxMs: req.body?.delayMaxMs,
    });
    const sent = results.filter((r) => r.ok).length;
    res.json({
      ok: true,
      total: results.length,
      sent,
      failed: results.length - sent,
      results,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/wa/logout', requireAuth, async (req, res) => {
  await wa.logoutWhatsApp();
  res.json({ ok: true, status: 'disconnected' });
});

app.listen(PORT, () => {
  console.log(`yaraci-node-scraper listening on port ${PORT}`);
  if (process.env.WA_AUTO_START === 'true') {
    wa.startWhatsApp().catch((err) => {
      console.error('WA auto-start failed:', err.message);
    });
  }
});
