#!/usr/bin/env node
// A stand-in for Green API, for the e2e stack only.
//
// The owners portal delivers its login code over WhatsApp, so a test that
// signs in the way a resident does has to read that message. This server
// speaks the one endpoint sendWhatsAppMessage() calls and keeps what it was
// handed in memory, where a spec can fetch it:
//
//   POST /waInstance<id>/sendMessage/<token>   → { idMessage }
//   POST /waInstance<id>/uploadFile/<token>    → { urlFile }          (purchasing PDF, 21/10/2026)
//   POST /waInstance<id>/sendFileByUrl/<token> → { idMessage }        (recorded with its fileName / caption)
//   GET  /__messages?chatId=…                  → every message for that chat
//   POST /__reset                              → forget everything
//
// Nothing here is reachable from the app: db/seed/e2e.sql points ONE test
// instance at this port, and prod's instances point at api.green-api.com.
import { createServer } from 'node:http';

const PORT = Number(process.env.E2E_GREENAPI_PORT ?? 3110);
/** @type {Array<{ chatId: string, message: string, at: string, fileName?: string, urlFile?: string }>} */
const sent = [];
let n = 0;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/__health') return json(res, 200, { ok: true, count: sent.length });

  if (req.method === 'POST' && url.pathname === '/__reset') {
    sent.length = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/__messages') {
    const chatId = url.searchParams.get('chatId');
    return json(res, 200, { messages: chatId ? sent.filter((m) => m.chatId === chatId) : sent });
  }

  if (req.method === 'POST' && /^\/waInstance[^/]+\/sendMessage\/[^/]+$/.test(url.pathname)) {
    const body = await readBody(req);
    sent.push({ chatId: String(body.chatId ?? ''), message: String(body.message ?? ''), at: new Date().toISOString() });
    n += 1;
    return json(res, 200, { idMessage: `stub-${n}` });
  }

  // The PDF of a purchasing document: pushed to Green's storage, then sent by URL.
  if (req.method === 'POST' && /^\/waInstance[^/]+\/uploadFile\/[^/]+$/.test(url.pathname)) {
    await new Promise((resolve) => { req.on('end', resolve); req.resume(); }); // drain the raw bytes
    n += 1;
    return json(res, 200, { urlFile: `http://127.0.0.1:${PORT}/files/stub-${n}.pdf` });
  }

  if (req.method === 'POST' && /^\/waInstance[^/]+\/sendFileByUrl\/[^/]+$/.test(url.pathname)) {
    const body = await readBody(req);
    sent.push({
      chatId: String(body.chatId ?? ''), message: String(body.caption ?? ''), at: new Date().toISOString(),
      fileName: String(body.fileName ?? ''), urlFile: String(body.urlFile ?? ''),
    });
    n += 1;
    return json(res, 200, { idMessage: `stub-${n}` });
  }

  return json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`green-api stub on http://127.0.0.1:${PORT}\n`);
});
