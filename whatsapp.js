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

const ALLOWED_LMS_HOSTS = new Set(
  String(process.env.ALLOWED_LMS_HOSTS || 'course.yaracienglish.com,yaracienglish.com,localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

const sessions = new Map();

function sanitizeSessionId(rawId) {
  const cleaned = String(rawId || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'default';
}

function getSessionAuthDir(sessionId) {
  const id = sanitizeSessionId(sessionId);
  return id === 'default' ? AUTH_DIR : path.join(AUTH_DIR, id);
}

function getSession(sessionId = 'default') {
  const id = sanitizeSessionId(sessionId);
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      authDir: getSessionAuthDir(id),
      sock: null,
      status: 'disconnected', // disconnected | connecting | qr | connected
      currentQrDataUrl: null,
      qrVersion: 0,
      connectedUser: null,
      lastError: null,
      reconnectTimer: null,
      connectTimeout: null,
      startPromise: null,
      lmsSessionCode: null,
      lmsCallbackUrl: LMS_WEBHOOK_URL,
      lmsReturnUrl: 'https://course.yaracienglish.com',
      lastLmsSync: null,
    };
    sessions.set(id, s);
  }
  return s;
}

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

function setLmsHandshake(sessionId = 'default', { sessionCode, callbackUrl, returnUrl } = {}) {
  if (typeof sessionId === 'object' && sessionId !== null) {
    return setLmsHandshake('default', sessionId);
  }
  const s = getSession(sessionId);
  if (sessionCode && typeof sessionCode === 'string') {
    const cleaned = sessionCode.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (cleaned) {
      s.lmsSessionCode = cleaned;
    }
  }
  if (callbackUrl && isTrustedLmsUrl(callbackUrl)) {
    s.lmsCallbackUrl = String(callbackUrl).trim();
  }
  if (returnUrl && isTrustedLmsUrl(returnUrl)) {
    s.lmsReturnUrl = String(returnUrl).trim();
  }
}

function formatDeviceLabel(user) {
  if (!user || !user.id) return null;
  const phone = String(user.id).split(':')[0].split('@')[0];
  return user.name ? `${user.name} (+${phone})` : `+${phone}`;
}

async function notifyLmsStatus(sessionId = 'default') {
  const s = getSession(sessionId);
  const url = String(s.lmsCallbackUrl || process.env.LMS_WEBHOOK_URL || LMS_WEBHOOK_URL || '').trim();
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
        session_id: s.id,
        session_code: s.lmsSessionCode,
        status: s.status,
        connected: s.status === 'connected',
        user: s.connectedUser,
        device: formatDeviceLabel(s.connectedUser),
        lastError: s.lastError,
        updated_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    s.lastLmsSync = { ok: res.ok, statusCode: res.status, at: new Date().toISOString() };
  } catch (err) {
    s.lastLmsSync = { ok: false, statusCode: 0, error: err.message, at: new Date().toISOString() };
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

async function startWhatsApp(sessionId = 'default', { force = false } = {}) {
  if (typeof sessionId === 'object' && sessionId !== null) {
    return startWhatsApp('default', sessionId);
  }
  const s = getSession(sessionId);

  if (force) {
    clearTimeout(s.reconnectTimer);
    clearTimeout(s.connectTimeout);
    if (s.sock) {
      try {
        s.sock.end(undefined);
      } catch {
        // ignore close errors
      }
      s.sock = null;
    }
    s.status = 'disconnected';
    s.currentQrDataUrl = null;
    s.qrVersion = 0;
    s.startPromise = null;
  }

  if (s.startPromise) {
    return s.startPromise;
  }

  if (s.sock && (s.status === 'connecting' || s.status === 'connected' || s.status === 'qr')) {
    return getStatus(s.id);
  }

  s.startPromise = (async () => {
    clearTimeout(s.reconnectTimer);
    clearTimeout(s.connectTimeout);

    try {
      fs.mkdirSync(s.authDir, { recursive: true });
      s.status = 'connecting';
      s.lastError = null;

      const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
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
        syncFullHistory: false,
      };
      if (version) {
        socketConfig.version = version;
      }

      const currentSock = makeWASocket(socketConfig);
      s.sock = currentSock;

      s.connectTimeout = setTimeout(() => {
        if (s.sock === currentSock && s.status === 'connecting') {
          s.status = 'disconnected';
          s.lastError = 'Koneksi ke WhatsApp timeout. Silakan klik Scan Ulang / Reconnect atau Reset Sesi.';
          try {
            currentSock.end(undefined);
          } catch {
            // ignore
          }
          s.sock = null;
          notifyLmsStatus(s.id);
        }
      }, 25000);

      currentSock.ev.on('creds.update', saveCreds);

      currentSock.ev.on('connection.update', async (update) => {
        if (s.sock !== currentSock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          clearTimeout(s.connectTimeout);
          s.status = 'qr';
          s.currentQrDataUrl = await QRCode.toDataURL(qr);
          s.qrVersion += 1;
          s.connectedUser = null;
          s.lastError = null;
          notifyLmsStatus(s.id);
        }

        if (connection === 'open') {
          clearTimeout(s.connectTimeout);
          s.status = 'connected';
          s.currentQrDataUrl = null;
          s.qrVersion = 0;
          s.lastError = null;
          s.connectedUser = currentSock.user ? { id: currentSock.user.id, name: currentSock.user.name || null } : null;
          notifyLmsStatus(s.id);
        }

        if (connection === 'close') {
          clearTimeout(s.connectTimeout);
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;

          s.status = 'disconnected';
          s.currentQrDataUrl = null;
          s.qrVersion = 0;
          s.connectedUser = null;
          s.sock = null;
          s.lastError = lastDisconnect?.error?.message || `Disconnected (code ${code || 'unknown'})`;
          notifyLmsStatus(s.id);

          if (!shouldReconnect) {
            fs.rmSync(s.authDir, { recursive: true, force: true });
          } else {
            const delayMs = code === DisconnectReason.restartRequired ? 1000 : 5000;
            clearTimeout(s.reconnectTimer);
            s.reconnectTimer = setTimeout(() => {
              startWhatsApp(s.id).catch((err) => {
                s.status = 'disconnected';
                s.lastError = err.message;
              });
            }, delayMs);
          }
        }
      });

      return getStatus(s.id);
    } catch (err) {
      clearTimeout(s.connectTimeout);
      s.status = 'disconnected';
      s.sock = null;
      s.lastError = err.message || 'Gagal memulai koneksi WhatsApp';
      notifyLmsStatus(s.id);
      return getStatus(s.id);
    } finally {
      s.startPromise = null;
    }
  })();

  return s.startPromise;
}

function getStatus(sessionId = 'default') {
  const s = getSession(sessionId);
  return {
    sessionId: s.id,
    status: s.status,
    connected: s.status === 'connected',
    user: s.connectedUser,
    hasQr: Boolean(s.currentQrDataUrl),
    qrVersion: s.qrVersion,
    qrDataUrl: s.currentQrDataUrl,
    lastError: s.lastError,
    sessionCode: s.lmsSessionCode,
    returnUrl: s.lmsReturnUrl,
    lastLmsSync: s.lastLmsSync,
  };
}

async function sendText(phone, message, mediaUrl = null, sessionId = 'default') {
  const s = getSession(sessionId);
  if (!s.sock || s.status !== 'connected') {
    throw new Error(`WhatsApp sesi (${s.id}) belum terhubung. Buka halaman Scan QR terlebih dahulu.`);
  }
  const text = String(message || '').trim();
  if (!text && !mediaUrl) {
    throw new Error('Pesan tidak boleh kosong');
  }

  const jid = formatJid(phone);
  const [exists] = await s.sock.onWhatsApp(jid);
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
      await s.sock.sendPresenceUpdate('composing', jid);
      await sleep(randomDelay(1200, 2500));
      await s.sock.sendPresenceUpdate('paused', jid);
    } catch {
      // Non-fatal if presence update is unavailable
    }
    return s.sock.sendMessage(jid, payload);
  })();
  return {
    sessionId: s.id,
    phone,
    jid,
    messageId: sent?.key?.id || null,
  };
}

async function sendBroadcast(phones, message, { delayMinMs = 5000, delayMaxMs = 12000, sessionId = 'default' } = {}) {
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
      const res = await sendText(phone, message, null, sessionId);
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

async function logoutWhatsApp(sessionId = 'default') {
  const s = getSession(sessionId);
  clearTimeout(s.reconnectTimer);
  clearTimeout(s.connectTimeout);
  s.startPromise = null;
  if (s.sock) {
    await s.sock.logout().catch(() => {});
    try {
      s.sock.end(undefined);
    } catch {
      // ignore
    }
    s.sock = null;
  }
  s.status = 'disconnected';
  s.currentQrDataUrl = null;
  s.qrVersion = 0;
  s.connectedUser = null;
  s.lastError = null;
  fs.rmSync(s.authDir, { recursive: true, force: true });
  await notifyLmsStatus(s.id);
}

module.exports = {
  sanitizeSessionId,
  startWhatsApp,
  getStatus,
  setLmsHandshake,
  notifyLmsStatus,
  sendText,
  sendBroadcast,
  logoutWhatsApp,
};
