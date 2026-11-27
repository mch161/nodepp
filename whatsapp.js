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
let connectTimeout = null;
let startPromise = null;
let lmsSessionCode = null;
let lmsCallbackUrl = LMS_WEBHOOK_URL;
let lmsReturnUrl = 'https://course.yaracienglish.com';
let lastLmsSync = null;

const ALLOWED_LMS_HOSTS = new Set(
  String(process.env.ALLOWED_LMS_HOSTS || 'course.yaracienglish.com,yaracienglish.com,localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

function isTrustedLmsUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
      return false;
    }
    return ALLOWED_LMS_HOSTS.has(host) || host.endsWith('.yaracienglish.com');
  } catch {
    return false;
  }
}

function isSafePublicMediaUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function setLmsHandshake({ sessionCode, callbackUrl, returnUrl } = {}) {
  if (sessionCode && typeof sessionCode === 'string') {
    const cleaned = sessionCode.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (cleaned) {
      lmsSessionCode = cleaned;
    }
  }
  if (callbackUrl && isTrustedLmsUrl(callbackUrl)) {
    lmsCallbackUrl = String(callbackUrl).trim();
  }
  if (returnUrl && isTrustedLmsUrl(returnUrl)) {
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

async function startWhatsApp({ force = false } = {}) {
  if (force) {
    clearTimeout(reconnectTimer);
    clearTimeout(connectTimeout);
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // ignore close errors
      }
      sock = null;
    }
    status = 'disconnected';
    currentQrDataUrl = null;
    startPromise = null;
  }

  if (startPromise) {
    return startPromise;
  }

  if (sock && (status === 'connecting' || status === 'connected' || status === 'qr')) {
    return getStatus();
  }

  startPromise = (async () => {
    clearTimeout(reconnectTimer);
    clearTimeout(connectTimeout);

    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      status = 'connecting';
      lastError = null;

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      let version;
      try {
        const res = await Promise.race([
          fetchLatestBaileysVersion(),
          sleep(5000).then(() => {
            throw new Error('Timeout fetching Baileys version');
          }),
        ]);
        version = res.version;
      } catch {
        version = undefined;
      }

      const socketConfig = {
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ['Yaraci Course', 'Chrome', '120.0.0'],
        connectTimeoutMs: 20000,
      };
      if (version) {
        socketConfig.version = version;
      }

      const currentSock = makeWASocket(socketConfig);
      sock = currentSock;

      connectTimeout = setTimeout(() => {
        if (sock === currentSock && status === 'connecting') {
          status = 'disconnected';
          lastError = 'Koneksi ke WhatsApp timeout. Silakan klik Scan Ulang / Reconnect atau Reset Sesi.';
          try {
            currentSock.end(undefined);
          } catch {
            // ignore
          }
          sock = null;
          notifyLmsStatus();
        }
      }, 25000);

      currentSock.ev.on('creds.update', saveCreds);

      currentSock.ev.on('connection.update', async (update) => {
        if (sock !== currentSock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          clearTimeout(connectTimeout);
          status = 'qr';
          currentQrDataUrl = await QRCode.toDataURL(qr);
          connectedUser = null;
          lastError = null;
          notifyLmsStatus();
        }

        if (connection === 'open') {
          clearTimeout(connectTimeout);
          status = 'connected';
          currentQrDataUrl = null;
          lastError = null;
          connectedUser = currentSock.user ? { id: currentSock.user.id, name: currentSock.user.name || null } : null;
          notifyLmsStatus();
        }

        if (connection === 'close') {
          clearTimeout(connectTimeout);
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
                status = 'disconnected';
                lastError = err.message;
              });
            }, 5000);
          }
        }
      });

      return getStatus();
    } catch (err) {
      clearTimeout(connectTimeout);
      status = 'disconnected';
      sock = null;
      lastError = err.message || 'Gagal memulai koneksi WhatsApp';
      notifyLmsStatus();
      return getStatus();
    } finally {
      startPromise = null;
    }
  })();

  return startPromise;
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
    if (!isSafePublicMediaUrl(cleanUrl)) {
      throw new Error('URL media tidak valid atau tidak diizinkan');
    }
    if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(cleanUrl)) {
      payload = { image: { url: cleanUrl }, caption: text };
    } else if (/\.pdf(\?|$)/i.test(cleanUrl)) {
      payload = { document: { url: cleanUrl }, mimetype: 'application/pdf', fileName: 'document.pdf', caption: text };
    } else {
      payload = { text: text ? `${text}\n\n${cleanUrl}` : cleanUrl };
    }
  }

  const sent = await (async () => {
    try {
      await sock.sendPresenceUpdate('composing', jid);
      await sleep(randomDelay(1200, 2500));
      await sock.sendPresenceUpdate('paused', jid);
    } catch {
      // Non-fatal if presence update is unavailable
    }
    return sock.sendMessage(jid, payload);
  })();
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
  clearTimeout(connectTimeout);
  startPromise = null;
  if (sock) {
    await sock.logout().catch(() => {});
    try {
      sock.end(undefined);
    } catch {
      // ignore
    }
    sock = null;
  }
  status = 'disconnected';
  currentQrDataUrl = null;
  connectedUser = null;
  lastError = null;
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
