const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, 'wa-auth');
const LMS_WEBHOOK_URL = process.env.LMS_WEBHOOK_URL || 'https://course.yaracienglish.com/api/wa-node/status-webhook';
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

let sock = null;
let status = 'disconnected'; // disconnected | connecting | qr | connected
let currentQrDataUrl = null;
let connectedUser = null;
let lastError = null;
let reconnectTimer = null;
let lmsSessionCode = null;
let lmsCallbackUrl = LMS_WEBHOOK_URL;
let lmsReturnUrl = 'https://course.yaracienglish.com';
let lastLmsSync = null;

function setLmsHandshake({ sessionCode, callbackUrl, returnUrl } = {}) {
  if (sessionCode && typeof sessionCode === 'string') {
    lmsSessionCode = sessionCode.trim().slice(0, 80);
  }
  if (callbackUrl && /^https?:\/\//i.test(String(callbackUrl).trim())) {
    lmsCallbackUrl = String(callbackUrl).trim();
  }
  if (returnUrl && /^https?:\/\//i.test(String(returnUrl).trim())) {
    lmsReturnUrl = String(returnUrl).trim();
  }
}

function formatDeviceLabel(user) {
  if (!user || !user.id) return null;
  const phone = String(user.id).split(':')[0].split('@')[0];
  return user.name ? `${user.name} (+${phone})` : `+${phone}`;
}

async function notifyLmsStatus() {
  const url = String(lmsCallbackUrl || process.env.LMS_WEBHOOK_URL || LMS_WEBHOOK_URL || '').trim();
  if (!url || typeof fetch !== 'function') return;

  const token = String(process.env.SCRAPER_TOKEN || '').trim();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-scraper-token': token } : {}),
      },
      body: JSON.stringify({
        session_code: lmsSessionCode,
        status,
        connected: status === 'connected',
        user: connectedUser,
        device: formatDeviceLabel(connectedUser),
        lastError,
        updated_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    lastLmsSync = { ok: res.ok, statusCode: res.status, at: new Date().toISOString() };
  } catch (err) {
    lastLmsSync = { ok: false, statusCode: 0, error: err.message, at: new Date().toISOString() };
  }
}

function formatJid(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) {
    throw new Error('Nomor WhatsApp tidak valid');
  }
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  if (digits.length < 9 || digits.length > 16) {
    throw new Error(`Format nomor tidak valid: ${rawPhone}`);
  }
  return `${digits}@s.whatsapp.net`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const min = Math.max(1000, Number(minMs) || 5000);
  const max = Math.max(min, Number(maxMs) || 12000);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function startWhatsApp() {
  if (sock && (status === 'connecting' || status === 'connected' || status === 'qr')) {
    return getStatus();
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  status = 'connecting';
  lastError = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Yaraci Course', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'qr';
      currentQrDataUrl = await QRCode.toDataURL(qr);
      connectedUser = null;
      notifyLmsStatus();
    }

    if (connection === 'open') {
      status = 'connected';
      currentQrDataUrl = null;
      lastError = null;
      connectedUser = sock.user ? { id: sock.user.id, name: sock.user.name || null } : null;
      notifyLmsStatus();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      status = 'disconnected';
      currentQrDataUrl = null;
      connectedUser = null;
      sock = null;
      lastError = lastDisconnect?.error?.message || `Disconnected (code ${code || 'unknown'})`;
      notifyLmsStatus();

      if (!shouldReconnect) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          startWhatsApp().catch((err) => {
            lastError = err.message;
          });
        }, 5000);
      }
    }
  });

  return getStatus();
}

function getStatus() {
  return {
    status,
    connected: status === 'connected',
    user: connectedUser,
    hasQr: Boolean(currentQrDataUrl),
    qrDataUrl: currentQrDataUrl,
    lastError,
    sessionCode: lmsSessionCode,
    returnUrl: lmsReturnUrl,
    lastLmsSync,
  };
}

async function sendText(phone, message, mediaUrl = null) {
  if (!sock || status !== 'connected') {
    throw new Error('WhatsApp belum terhubung. Buka /wa/qr untuk scan QR terlebih dahulu.');
  }
  const text = String(message || '').trim();
  if (!text && !mediaUrl) {
    throw new Error('Pesan tidak boleh kosong');
  }

  const jid = formatJid(phone);
  const [exists] = await sock.onWhatsApp(jid);
  if (!exists || !exists.exists) {
    throw new Error(`Nomor ${phone} tidak terdaftar di WhatsApp`);
  }

  let payload = { text };
  if (mediaUrl) {
    const cleanUrl = String(mediaUrl).trim();
    if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(cleanUrl)) {
      payload = { image: { url: cleanUrl }, caption: text };
    } else if (/\.pdf(\?|$)/i.test(cleanUrl)) {
      payload = { document: { url: cleanUrl }, mimetype: 'application/pdf', fileName: 'document.pdf', caption: text };
    } else {
      payload = { text: text ? `${text}\n\n${cleanUrl}` : cleanUrl };
    }
  }

  const sent = await sock.sendMessage(jid, payload);
  return {
    phone,
    jid,
    messageId: sent?.key?.id || null,
  };
}

async function sendBroadcast(phones, message, { delayMinMs = 5000, delayMaxMs = 12000 } = {}) {
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new Error('Daftar nomor (phones) wajib diisi');
  }
  if (phones.length > 30) {
    throw new Error('Maksimal 30 nomor per request broadcast agar aman dari timeout & spam');
  }

  const results = [];
  for (let i = 0; i < phones.length; i += 1) {
    const phone = phones[i];
    try {
      const res = await sendText(phone, message);
      results.push({ ok: true, ...res });
    } catch (err) {
      results.push({ ok: false, phone, error: err.message });
    }

    if (i < phones.length - 1) {
      await sleep(randomDelay(delayMinMs, delayMaxMs));
    }
  }

  return results;
}

async function logoutWhatsApp() {
  clearTimeout(reconnectTimer);
  if (sock) {
    await sock.logout().catch(() => {});
    sock = null;
  }
  status = 'disconnected';
  currentQrDataUrl = null;
  connectedUser = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  await notifyLmsStatus();
}

module.exports = {
  startWhatsApp,
  getStatus,
  setLmsHandshake,
  notifyLmsStatus,
  sendText,
  sendBroadcast,
  logoutWhatsApp,
};
