// quote.js — generación y envío de cotización en PDF (lee precios desde Sheets)
import fs from 'fs';
import path from 'path';
import { buildQuoteFromSession } from './quote-engine.js';
import { renderQuotePDF } from './quote-pdf.js';

// ===== ENV =====
const WA_TOKEN        = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID     = process.env.WHATSAPP_PHONE_ID || '';
const QUOTES_DIR      = path.resolve('./data/quotes');
const MAX_CONCURRENCY = parseInt(process.env.QUOTE_MAX_CONCURRENCY || '3', 10);
const DELETE_AFTER_MS = parseInt(process.env.QUOTE_DELETE_AFTER_MS || (10 * 60 * 1000), 10);
const MAX_FILE_AGE_MS = parseInt(process.env.QUOTE_MAX_FILE_AGE_MS || (2 * 60 * 60 * 1000), 10);
const MAX_FILES_KEEP  = parseInt(process.env.QUOTE_MAX_FILES_KEEP || '200', 10);

// Branding/ajustes opcionales (no se imprime ningún nombre fijo)
const COMPANY = {
  brandName: (process.env.BRAND_NAME || '').trim(),       // opcional, puede ir vacío
  logoPath:  (process.env.LOGO_PATH  || '').trim() || null,
  mapsUrl:   (process.env.MAPS_URL   || '').trim() || null,
  storeName: (process.env.STORE_NAME || 'Almacén Central').trim(),
};

try { fs.mkdirSync(QUOTES_DIR, { recursive:true }); } catch {}

// ===== Concurrencia simple =====
let _active = 0;
const _waiters = [];
function _acquire() {
  if (_active < MAX_CONCURRENCY) { _active++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _release() {
  _active = Math.max(0, _active - 1);
  const next = _waiters.shift();
  if (next) { _active++; next(); }
}

// Limpieza periódica
function _cleanupOldQuotes() {
  try{
    const files = fs.readdirSync(QUOTES_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const p = path.join(QUOTES_DIR, f);
        const st = fs.statSync(p);
        return { p, mtime: st.mtimeMs, birth: st.birthtimeMs };
      })
      .sort((a,b)=> (a.mtime - b.mtime));
    const now = Date.now();
    for (const it of files) {
      if (now - (it.mtime || it.birth || now) > MAX_FILE_AGE_MS) {
        try { fs.unlinkSync(it.p); } catch {}
      }
    }
    const left = fs.readdirSync(QUOTES_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
    const overflow = left.length - MAX_FILES_KEEP;
    if (overflow > 0) {
      const toDrop = left.slice(0, overflow);
      for (const f of toDrop) { try { fs.unlinkSync(path.join(QUOTES_DIR, f)); } catch {} }
    }
  }catch{}
}
setInterval(_cleanupOldQuotes, 30 * 60 * 1000).unref?.();

// ===== WhatsApp helpers =====
async function waUploadMediaFromFile(filePath, mime='application/pdf'){
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error('Faltan credenciales de WhatsApp (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID).');
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/media`;
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('file', blob, path.basename(filePath));
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');
  const r = await fetch(url, { method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}` }, body: form });
  if (!r.ok){
    const t = await r.text().catch(()=> '');
    console.error('upload error', r.status, t);
    return null;
  }
  const j = await r.json().catch(()=>null);
  return j?.id || null;
}

async function waSendDocument(to, mediaId, filename, caption=''){
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error('Faltan credenciales de WhatsApp (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID).');
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/messages`;
  const payload = {
    messaging_product:'whatsapp',
    to,
    type:'document',
    document: { id: mediaId, filename, caption }
  };
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${WA_TOKEN}`,'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok){
    console.error('send doc error', r.status, await r.text().catch(()=>''), 'payload=', JSON.stringify(payload).slice(0,400));
    return false;
  }
  return true;
}

/**
 * Genera y envía un PDF de cotización por WhatsApp (lee precios desde Sheets).
 *
 * @param {string} to - Número destino (WhatsApp).
 * @param {object} session - Objeto de sesión/estado.
 * @returns {Promise<{ok:boolean, mediaId:string|null, path:string, filename:string, caption:string, quoteId?:string}>}
 */
export async function sendAutoQuotePDF(to, session){
  await _acquire();
  try{
    const quote = await buildQuoteFromSession(session);

    const cleanName = (s='') => String(s)
      .normalize('NFD').replace(/\p{Diacritic}/gu,'')
      .replace(/[\\/:*?"<>|]+/g,'')
      .replace(/\s+/g,' ').trim()
      .slice(0,80);

    const clienteName = cleanName(quote?.cliente?.nombre || session?.profileName || 'Cliente');

    // Nombre interno (archivo en disco) con timestamp para evitar colisiones
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const filenameFS = `${cleanName(`COT - ${clienteName} - ${stamp}`)}.pdf`;

    // Nombre visible para WhatsApp (neutral)
    const filenameDisplay = `${cleanName(`COTIZACION - ${clienteName}`)}.pdf`;

    const outDir = path.resolve('./data/quotes');
    try { fs.mkdirSync(outDir, { recursive:true }); } catch {}
    const filePath = path.join(outDir, filenameFS);

    await renderQuotePDF(quote, filePath, {
      brandName: COMPANY.brandName,
      logoPath: COMPANY.logoPath,
      mapsUrl: COMPANY.mapsUrl,
      storeName: COMPANY.storeName
    });

    const mediaId = await waUploadMediaFromFile(filePath, 'application/pdf');
    if (!mediaId) throw new Error('No se pudo subir el PDF a WhatsApp.');

    const caption = `Cotización — ${clienteName}`;
    const ok = await waSendDocument(to, mediaId, filenameDisplay, caption);
    if (!ok) throw new Error('No se pudo enviar el PDF por WhatsApp.');

    if (DELETE_AFTER_MS > 0) {
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, DELETE_AFTER_MS).unref?.();
    }

    return { ok:true, mediaId, path:filePath, filename: filenameDisplay, caption, quoteId: quote?.id };
  } finally {
    _release();
  }
}
