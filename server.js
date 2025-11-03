// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

// Routers existentes
import messengerRouter from './index.js';
import pricesRouter from './prices.js';
import waRouter from './wa.js';
import vendorsRouter from './wa.vendedores.js';

// Sheets helpers
import {
  summariesLastNDays,
  historyForIdLastNDays,
  appendMessage,
  readPrices
} from './sheets.js';

/* ---------- Config básica ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TZ = process.env.TIMEZONE || 'America/La_Paz';

/* ---------- Errores globales ---------- */
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));

/* ---------- Static / UI ---------- */
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/inbox', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));

/* ---------- Health / raíz ---------- */
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/__ping', (_req, res) => res.type('text').send('pong'));

/* ---------- Routers ---------- */
app.use(vendorsRouter);
app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter);

/* ---------- API catálogo ---------- */
app.get('/api/catalog', async (_req, res) => {
  try {
    const { prices = [], rate = 6.96 } = await readPrices();
    const byProduct = new Map();
    for (const p of prices) {
      const sku = String(p.sku || '').trim();
      let producto = sku, presentacion = '';
      if (sku.includes('-')) {
        const parts = sku.split('-');
        producto = (parts.shift() || '').trim();
        presentacion = parts.join('-').trim();
      }
      if (!producto) continue;
      const usd = Number(p.precio_usd || 0);
      const bs  = Number(p.precio_bs  || 0) || (usd ? +(usd * rate).toFixed(2) : 0);
      const unidad = String(p.unidad || '').trim();
      const categoria = String(p.categoria || '').trim() || 'Herbicidas';
      const cur = byProduct.get(producto) || {
        nombre: producto, categoria, imagen: `/image/${producto}.png`, variantes: []
      };
      cur.categoria = cur.categoria || categoria;
      if (presentacion || unidad || usd || bs) {
        cur.variantes.push({ presentacion: presentacion || '', unidad, precio_usd: usd, precio_bs: bs });
      }
      byProduct.set(producto, cur);
    }
    const items = [...byProduct.values()].sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
    res.json({ ok:true, rate, items, count: items.length, source:'sheet:PRECIOS' });
  } catch (e) {
    console.error('[catalog] error:', e);
    res.status(500).json({ ok:false, error:'catalog_unavailable' });
  }
});

/* ---------- Auth simple ---------- */
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
function validateToken(token) {
  if (!AGENT_TOKEN) return true;
  return token && token === AGENT_TOKEN;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.sendStatus(401);
  if (!validateToken(h.slice(7).trim())) return res.sendStatus(401);
  next();
}

/* ---------- SSE ---------- */
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
app.get('/wa/agent/stream', (req, res) => {
  const token = String(req.query.token || '');
  if (!validateToken(token)) return res.sendStatus(401);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write(': hi\n\n');
  const ping = setInterval(() => { try { res.write('event: ping\ndata: "💓"\n\n'); } catch {} }, 25000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

/* ---------- Estado/UI ---------- */
const STATE = new Map();

app.post('/wa/agent/import-whatsapp', auth, async (req, res) => {
  try {
    const days = Number(req.body?.days || 3650);
    const items = await summariesLastNDays(days);
    for (const it of items) {
      const st = STATE.get(it.id) || { human:false, unread:0 };
      STATE.set(it.id, { ...st, name: it.name || it.id, last: it.last || '' });
    }
    res.json({ ok: true, imported: items.length });
  } catch (e) {
    console.error('[import-whatsapp]', e);
    res.status(500).json({ error: 'no se pudo importar desde Sheets' });
  }
});

app.get('/wa/agent/convos', auth, async (_req, res) => {
  try {
    const items = await summariesLastNDays(3650);
    const byId = new Map();
    for (const it of items) {
      byId.set(it.id, {
        id: it.id, name: it.name || it.id, last: it.last || '', lastTs: it.lastTs || 0,
        human: false, unread: 0
      });
    }
    for (const [id, st] of STATE.entries()) {
      const cur = byId.get(id) || { id, name: id, last: '', lastTs: 0, human: false, unread: 0 };
      byId.set(id, {
        ...cur,
        name: st.name || cur.name || id,
        last: st.last || cur.last || '',
        human: !!st.human,
        unread: st.unread || 0,
      });
    }
    const convos = [...byId.values()]
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .map(({ lastTs, ...rest }) => rest);
    res.json({ convos });
  } catch (e) {
    console.error('[convos]', e);
    res.status(500).json({ error: 'no se pudo leer Hoja 4' });
  }
});

app.get('/wa/agent/history/:id', auth, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const rows = await historyForIdLastNDays(id, 3650);
    const memory = rows.map(r => ({ role:r.role, content:r.content, ts:r.ts }));
    const name = STATE.get(id)?.name || rows[rows.length-1]?.name || id;
    const last = memory[memory.length-1]?.content || '';
    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last, name, unread:0 });
    res.json({ id, name, human: !!st.human, memory });
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: 'no se pudo leer historial' });
  }
});

app.post('/wa/agent/send', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to y text requeridos' });
  const id = String(to);
  const ts = Date.now();
  const name = STATE.get(id)?.name || id;

  try {
    await appendMessage({ waId:id, name, ts, role:'agent', content:String(text) });
    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last:String(text), unread:0 });
    sseBroadcast('msg', { id, role:'agent', content:String(text), ts });
    res.json({ ok:true });
  } catch (e) {
    console.error('[send]', e);
    res.status(500).json({ error: 'no se pudo guardar en Hoja 4' });
  }
});

app.post('/wa/agent/read', auth, (req, res) => {
  const id = String(req.body?.to || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, unread:0 });
  res.json({ ok:true });
});

app.post('/wa/agent/handoff', auth, (req, res) => {
  const id = String(req.body?.to || '');
  const mode = String(req.body?.mode || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, human: mode === 'human' });
  res.json({ ok:true });
});

/* ---------- Media “falsa” ---------- */
const upload = multer({ storage: multer.memoryStorage() });
app.post('/wa/agent/send-media', auth, upload.array('files'), async (req, res) => {
  const { to, caption = '' } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to requerido' });

  const id = String(to);
  const baseTs = Date.now();
  const files = Array.isArray(req.files) ? req.files : [];

  if (!files.length && !req.body.url) {
    return res.status(400).json({ error: 'files vacío (o usa body.url)' });
  }

  try {
    if (files.length) {
      let idx = 0;
      for (const f of files) {
        const sizeKB = Math.round((Number(f.size || 0) / 1024) * 10) / 10;
        const line = `📎 Archivo: ${f.originalname} (${sizeKB} KB)`;
        const ts = baseTs + (idx++);
        await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts, role:'agent', content:line });
        sseBroadcast('msg', { id, role:'agent', content:line, ts });
      }
    } else {
      const line = `📎 Archivo: ${req.body.filename || 'archivo'}\n${req.body.url}`;
      await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts:baseTs, role:'agent', content:line });
      sseBroadcast('msg', { id, role:'agent', content:line, ts:baseTs });
    }

    if (caption && caption.trim()) {
      const ts = baseTs + (files.length || 1);
      await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts, role:'agent', content:String(caption) });
      sseBroadcast('msg', { id, role:'agent', content:String(caption), ts });
      const st = STATE.get(id) || { human:false, unread:0 };
      STATE.set(id, { ...st, last:String(caption), unread:0 });
    }
    res.json({ ok:true, sent: files.length || 1 });
  } catch (e) {
    console.error('[send-media]', e);
    res.status(500).json({ error: 'no se pudo guardar en Hoja 4' });
  }
});

/* ---------- (Opcional) Webhook WA->TG ---------- */
let tg = {
  ready: false,
  notifyNewTextFromWA: async () => {},
  notifyNewMediaFromWA: async () => {}
};

app.post('/wa/webhook', async (req, res) => {
  try {
    const ev = req.body || {};
    if (ev.type === 'message_in') {
      const { conversationId: id, name, phone, text, mediaUrl, mime, filename } = ev;
      if (text && text.trim()) {
        await tg.notifyNewTextFromWA({ id, name, phone, text });
      } else if (mediaUrl) {
        await tg.notifyNewMediaFromWA({ id, name, phone, caption: text || '(archivo)', mediaUrl, mime: mime || '', filename: filename || '' });
      }
      const st = STATE.get(id) || { human:false, unread:0 };
      STATE.set(id, { ...st, name: name || id, last: text || st.last || '', unread: (st.unread||0) + 1 });
      if (text) sseBroadcast('msg', { id, role:'user', content:String(text), ts: Date.now() });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[wa/webhook]', e?.response?.data || e);
    res.sendStatus(500);
  }
});

/* ---------- ARRANQUE ---------- */
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, HOST, () => {
  console.log(`🚀 Web service escuchando en http://${HOST}:${PORT}`);
  console.log('   • Health:           GET /healthz');
  console.log('   • Inbox UI:         GET /inbox');
  console.log('   • API WA Agent:     /wa/agent/*');
});

/* ---------- Telegram bridge: después del listen ---------- */
setImmediate(async () => {
  try {
    const wantTG = !!process.env.TG_BOT_TOKEN && !!process.env.TG_ADMIN_CHAT_ID;
    if (wantTG) {
      const mod = await import('./telegram-bridge.js');
      mod.startTelegramBridge().then(() => {
        tg = {
          ready: true,
          notifyNewTextFromWA: mod.notifyNewTextFromWA,
          notifyNewMediaFromWA: mod.notifyNewMediaFromWA
        };
        console.log('[TG] Bridge activo');
      }).catch(err => {
        console.error('[TG] Error al iniciar (continuo sin TG):', err?.message || err);
      });
    } else {
      console.log('[TG] Bridge omitido: faltan TG_BOT_TOKEN o TG_ADMIN_CHAT_ID');
    }
  } catch (err) {
    console.error('[TG] init error:', err?.message || err);
  }
});
