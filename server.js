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

app.get('/', async (req, res) => {
  const waState = wa.getStatus();
  const wantsJson = req.query.format === 'json' || (!req.accepts('html') && req.accepts('json'));
  if (wantsJson) {
    return res.json({
      ok: true,
      service: 'yaraci-node-scraper',
      node: process.version,
      whatsapp: waState.status,
    });
  }

  return renderGatewayPage(req, res, { requireTokenForControls: false });
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

async function renderGatewayPage(req, res, { requireTokenForControls = false } = {}) {
  try {
    const authorized = !requireTokenForControls || isAuthorized(req);
    const action = String(req.query.action || '').toLowerCase();
    let flash = '';
    let errorFlash = '';

    if (authorized) {
      if (action === 'logout') {
        await wa.logoutWhatsApp();
        flash = 'Sesi WhatsApp berhasil diputus. Klik "Scan Ulang / Reconnect" untuk memunculkan QR baru.';
      } else if (action === 'reconnect') {
        await wa.startWhatsApp();
        flash = 'Menyambungkan ulang ke WhatsApp...';
      } else {
        await wa.startWhatsApp();
      }
    } else if (req.query.token) {
      errorFlash = 'Token akses tidak valid. Silakan periksa kembali WA_NODE_TOKEN Anda.';
    }

    const state = wa.getStatus();
    const tokenParam = req.query.token ? `token=${encodeURIComponent(String(req.query.token))}&` : '';
    const baseHref = req.query.token ? `?token=${encodeURIComponent(String(req.query.token))}` : '?';
    const reconnectHref = `?${tokenParam}action=reconnect`;
    const logoutHref = `?${tokenParam}action=logout`;
    const shouldAutoRefresh = authorized && !state.connected && action !== 'logout';

    const statusBadge = state.connected
      ? '<span class="badge badge-online"><span class="dot"></span>Terhubung (Online)</span>'
      : state.status === 'qr'
        ? '<span class="badge badge-qr"><span class="dot"></span>Menunggu Scan QR</span>'
        : state.status === 'connecting'
          ? '<span class="badge badge-wait"><span class="dot"></span>Menghubungkan...</span>'
          : '<span class="badge badge-off"><span class="dot"></span>Terputus (Offline)</span>';

    let mainContent = '';
    let actionsHtml = '';

    if (!authorized && requireTokenForControls) {
      mainContent = `
        <div class="lock-box">
          <div class="wa-icon-circle">WA</div>
          <h2>Yaraci English WhatsApp Gateway</h2>
          <p class="hint">Masukkan <b>Token Akses Gateway</b> untuk membuka QR Code, Scan Ulang, dan kontrol Logout.</p>
          <form method="GET" action="/wa/qr" class="token-form">
            <input type="password" name="token" placeholder="Masukkan WA_NODE_TOKEN..." required autocomplete="off" />
            <button type="submit" class="btn btn-primary" style="width:100%">Masuk ke Konsol Scan QR &rarr;</button>
          </form>
        </div>`;
    } else {
      mainContent = state.connected
        ? `<div class="connected-box">
            <div class="check-circle">✓</div>
            <h2>WhatsApp Gateway Aktif</h2>
            <p class="account-pill">${escapeHtml(formatConnectedPhone(state.user))}</p>
            <p class="hint">Terhubung ke LMS <b>course.yaracienglish.com</b> untuk Broadcast &amp; Campaign jalur <b>Node.js (Baileys)</b>.</p>
          </div>`
        : state.qrDataUrl
          ? `<div class="qr-box">
              <div class="qr-frame">
                <img src="${state.qrDataUrl}" alt="WhatsApp QR Code" class="qr-img" />
              </div>
              <ol class="steps">
                <li>Buka <b>WhatsApp</b> di HP Anda</li>
                <li>Ketuk <b>Perangkat Tertaut</b> &rarr; <b>Tautkan Perangkat</b></li>
                <li>Arahkan kamera ke QR Code di atas</li>
              </ol>
            </div>`
          : `<div class="loading-box">
              <div class="spinner"></div>
              <h2>${action === 'logout' ? 'Sesi WhatsApp Diputus' : 'Menyiapkan Koneksi WhatsApp...'}</h2>
              <p class="hint">${state.lastError ? escapeHtml(state.lastError) : 'Status: ' + escapeHtml(state.status) + (shouldAutoRefresh ? ' • Halaman refresh otomatis tiap 5 detik.' : '')}</p>
            </div>`;

      actionsHtml = `
        <div class="actions">
          <a href="${escapeHtml(reconnectHref)}" class="btn btn-primary">↻ Scan Ulang / Reconnect</a>
          <a href="${escapeHtml(logoutHref)}" class="btn btn-danger" onclick="return confirm('Putuskan sesi WhatsApp saat ini dan scan ulang nomor?')">⏻ Logout / Putuskan</a>
          <a href="${escapeHtml(baseHref)}" class="btn btn-ghost">⟳ Refresh Status</a>
        </div>`;
    }

    res.type('html').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${shouldAutoRefresh ? `<meta http-equiv="refresh" content="5;url=${escapeHtml(baseHref)}" />` : ''}
  <title>Yaraci English — WhatsApp Gateway</title>
  <style>
    :root{
      --colorPrimary:#5ae1f0;
      --yaraci-cyan:#5ae1f0;
      --yaraci-pink:#f7c6d2;
      --yaraci-pink-dark:#831843;
      --yaraci-amber:#f7b14c;
      --yaraci-badge-gold-text:#653e00;
      --yaraci-sky:#0ea5e9;
      --yaraci-link:#006591;
      --yaraci-sky-bg:#c9e6ff;
      --bg-page:#f7f9fb;
      --surface:#ffffff;
      --surface-soft:#f8fafc;
      --text-heading:#191c1e;
      --text-main:#1f2937;
      --text-muted:#4b5563;
      --danger-grad:linear-gradient(0deg,#9c031e 0%,#eb0029 100%);
    }
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,system-ui,-apple-system,sans-serif;background:radial-gradient(circle at 12% 15%,rgba(90,225,240,.28),transparent 38%),radial-gradient(circle at 88% 18%,rgba(247,198,210,.35),transparent 40%),radial-gradient(circle at 50% 95%,rgba(247,177,76,.22),transparent 42%),var(--bg-page);color:var(--text-main)}
    .card{width:100%;max-width:480px;background:var(--surface);border-radius:24px;padding:28px;box-shadow:0 20px 50px rgba(25,28,30,.10);text-align:center;border:1.5px solid rgba(90,225,240,.55);position:relative;overflow:hidden}
    .card::before{content:"";position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,var(--yaraci-cyan) 0%,var(--yaraci-amber) 50%,var(--yaraci-pink) 100%)}
    .brand-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e5e7eb}
    .brand-left{display:flex;align-items:center;gap:12px;text-align:left}
    .brand-logo{height:40px;width:auto;max-width:130px;object-fit:contain}
    .brand-text h1{margin:0;font-size:1.05rem;font-weight:800;color:var(--text-heading);letter-spacing:-.01em}
    .brand-text small{display:block;color:var(--yaraci-link);font-weight:700;font-size:.76rem;margin-top:2px}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:.74rem;font-weight:700;white-space:nowrap}
    .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
    .badge-online{background:#dcfce7;color:#15803d}
    .badge-qr{background:var(--yaraci-amber);color:var(--yaraci-badge-gold-text)}
    .badge-wait{background:var(--yaraci-sky-bg);color:var(--yaraci-link)}
    .badge-off{background:var(--yaraci-pink);color:var(--yaraci-pink-dark)}
    .flash{background:var(--yaraci-sky-bg);border:1px solid var(--yaraci-cyan);color:var(--yaraci-link);border-radius:12px;padding:10px 12px;font-size:.82rem;font-weight:600;margin-bottom:16px}
    .flash-err{background:var(--yaraci-pink);border:1px solid #f472b6;color:var(--yaraci-pink-dark);border-radius:12px;padding:10px 12px;font-size:.82rem;font-weight:600;margin-bottom:16px}
    .qr-box{padding:6px 0}
    .qr-frame{display:inline-block;padding:14px;background:var(--surface-soft);border:2px solid var(--yaraci-cyan);border-radius:20px;box-shadow:0 10px 26px rgba(90,225,240,.25)}
    .qr-img{display:block;width:250px;height:250px;border-radius:12px;background:#fff}
    .steps{text-align:left;margin:16px auto 0;max-width:340px;padding-left:20px;color:var(--text-muted);font-size:.86rem;line-height:1.65}
    .connected-box,.lock-box{padding:14px 6px}
    .check-circle,.wa-icon-circle{width:68px;height:68px;margin:0 auto 14px;border-radius:20px;background:linear-gradient(135deg,var(--yaraci-sky),var(--yaraci-link));color:#fff;font-size:30px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 26px rgba(14,165,233,.3)}
    .account-pill{display:inline-block;background:var(--yaraci-sky-bg);color:var(--yaraci-link);font-weight:700;padding:8px 18px;border-radius:999px;font-size:.94rem;margin:6px 0 10px}
    .loading-box{padding:24px 8px}
    .spinner{width:44px;height:44px;margin:0 auto 14px;border:4px solid var(--yaraci-sky-bg);border-top-color:var(--yaraci-sky);border-radius:50%;animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    h2{margin:6px 0;font-size:1.18rem;color:var(--text-heading)}
    .hint{margin:6px 0 0;color:var(--text-muted);font-size:.85rem;line-height:1.55}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px;padding-top:18px;border-top:1px solid #e5e7eb}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:11px 14px;border-radius:12px;font-size:.84rem;font-weight:700;text-decoration:none;border:none;cursor:pointer;transition:transform .15s,opacity .15s}
    .btn:hover{transform:translateY(-1px);opacity:.94}
    .btn-primary{background:linear-gradient(135deg,var(--yaraci-sky),var(--yaraci-link));color:#fff}
    .btn-danger{background:var(--danger-grad);color:#fff}
    .btn-ghost{grid-column:1/-1;background:var(--yaraci-sky-bg);color:var(--yaraci-link)}
    .footer{margin-top:18px;font-size:.74rem;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center;border-top:1px solid #f1f5f9;padding-top:12px}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand-bar">
      <div class="brand-left">
        <img src="https://course.yaracienglish.com/logo/yaraci.png" alt="Yaraci English" class="brand-logo" onerror="this.style.display='none'" />
        <div class="brand-text">
          <h1>Yaraci English</h1>
          <small>WhatsApp Gateway</small>
        </div>
      </div>
      ${statusBadge}
    </div>
    ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}
    ${errorFlash ? `<div class="flash-err">${escapeHtml(errorFlash)}</div>` : ''}
    ${mainContent}
    ${actionsHtml}
    <div class="footer">
      <span>appnode.yaracienglish.com</span>
      <span>Node ${escapeHtml(process.version)}</span>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).type('text/plain').send(`Error: ${err.message}`);
  }
}

app.get('/wa/qr', requireAuth, async (req, res) => renderGatewayPage(req, res, { requireTokenForControls: false }));

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
