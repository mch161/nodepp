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

app.get('/wa/qr', requireAuth, async (req, res) => {
  try {
    await wa.startWhatsApp();
    const state = wa.getStatus();

    const body = state.connected
      ? `<h2 style="color:#16a34a">WhatsApp Terhubung</h2><p>Akun: <b>${state.user?.name || state.user?.id || 'Active'}</b></p>`
      : state.qrDataUrl
        ? `<h2>Scan QR WhatsApp</h2><img src="${state.qrDataUrl}" alt="WhatsApp QR" style="width:280px;height:280px;border:1px solid #ddd;border-radius:8px;"/><p>Buka WhatsApp di HP &rarr; Perangkat Tertaut &rarr; Tautkan Perangkat.</p>`
        : `<h2>Menghubungkan WhatsApp...</h2><p>Status: ${state.status}. Halaman ini akan refresh otomatis.</p>`;

    res.type('html').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="5" />
  <title>WhatsApp Login - Yaraci Node</title>
  <style>body{font-family:system-ui,sans-serif;max-width:460px;margin:40px auto;text-align:center;padding:16px;}</style>
</head>
<body>${body}</body>
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
