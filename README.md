# yaraci-node-scraper

Microservice Node.js untuk `course.yaracienglish.com`:
1. **SEO Rank Scraper** (`Puppeteer`)
2. **WhatsApp Sender & Broadcast** (`@whiskeysockets/baileys`, tanpa gateway berbayar)

## Endpoint
- `GET /` — Cek status Node.js & status koneksi WhatsApp.
- `GET /health` — Cek apakah Puppeteer & Chromium bisa dijalankan.
- `GET /scrape?url=https://www.google.co.id/search?...` — Mengambil HTML hasil pencarian Google.
- `GET /wa/qr?token=...` — Halaman scan QR untuk menghubungkan nomor WhatsApp.
- `GET /wa/status` — Cek status koneksi WhatsApp.
- `POST /wa/send` — Kirim 1 pesan (`{ "phone": "08123456789", "message": "Halo" }`).
- `POST /wa/broadcast` — Kirim broadcast hingga 30 nomor per request dengan jeda acak 5–12 detik (`{ "phones": ["0812...", "0813..."], "message": "Promo..." }`).
- `POST /wa/logout` — Putuskan & hapus sesi WhatsApp.

## Environment Variables (Hostinger Node.js App)
```env
SCRAPER_TOKEN=token-rahasia-anda
WA_AUTO_START=true
```

## Integrasi ke Laravel (`course.yaracienglish.com`)
Tambahkan di `.env` Laravel production:
```env
SEO_REMOTE_SCRAPER_URL=https://appnode.yaracienglish.com/scrape
SEO_REMOTE_SCRAPER_TOKEN=token-rahasia-anda
```
