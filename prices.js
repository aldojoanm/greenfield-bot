// prices.js
import express from 'express';
import { getSheets } from './sheets.js';

const router = express.Router();

/* =========================
   Config
   ========================= */
const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const TAB3 = process.env.SHEETS_TAB3_NAME || 'Hoja 3';
// Celdas opcionales para versión y tipo de cambio
const VERSION_CELL = process.env.SHEETS_PRICES_VERSION_CELL || ''; // ej: 'Hoja 3!J1'
const RATE_CELL    = process.env.SHEETS_PRICES_RATE_CELL    || ''; // ej: 'Hoja 3!J2'

const DEFAULT_RATE = Number(process.env.DEFAULT_RATE || 6.96);
const TTL_MS = Number(process.env.PRICES_TTL_MS || 60_000);

/* =========================
   Helpers
   ========================= */
const norm = (s='') => String(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();
const to2  = (n) => Number.isFinite(+n) ? +(+n).toFixed(2) : 0;

// Normaliza unidad exactamente a 'L' o 'KG'
function normUnidad(u=''){
  const t = String(u).toLowerCase();
  if (t.startsWith('kg') || t.startsWith('kilo')) return 'KG';
  if (t.startsWith('l')) return 'L';
  if (t.startsWith('uni') || t.startsWith('und')) return 'UNID';
  return String(u || '').toUpperCase();
}

// Construye SKU **incluyendo la unidad** (clave para que el engine encuentre precio)
function buildSku(producto='', presentacion='', unidad=''){
  const prod = String(producto||'').trim();
  const pres = String(presentacion||'').trim();
  const uni  = normUnidad(unidad);
  // si la presentacion ya trae unidad, no la duplicamos
  const presHasUnit = /\b(\d+(?:[.,]\d+)?)\s*(l|lt|lts|litros?|kg|kgs?|kilos?)\b/i.test(pres);
  const presFinal = presHasUnit ? pres : (uni && pres ? `${pres} ${uni}` : pres);
  return presFinal ? `${prod}-${presFinal}` : prod;
}

const normCat = (c='') => {
  const t = norm(c);
  if (t.startsWith('inse')) return 'insecticida';
  if (t.startsWith('fung')) return 'fungicida';
  return 'herbicida';
};

/* =========================
   Lectura desde Sheets
   ========================= */
async function readVersionAndRate(sheets){
  let version = '';
  let rate = NaN;

  try {
    if (VERSION_CELL) {
      const vres = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: VERSION_CELL
      });
      version = String(vres.data.values?.[0]?.[0] ?? '').trim();
    }
  } catch {}

  try {
    if (RATE_CELL) {
      const rres = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: RATE_CELL
      });
      const raw = String(rres.data.values?.[0]?.[0] ?? '').replace(',','.');
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) rate = n;
    }
  } catch {}

  return { version, rate };
}

/**
 * Lee Hoja 3 con columnas:
 * TIPO | PRODUCTO | PRESENTACION | UNIDAD | PRECIO (USD) | PRECIO (BS)
 */
async function _fetchPricesRaw() {
  if (!SPREADSHEET_ID) throw new Error('Falta SHEETS_SPREADSHEET_ID');
  const sheets = await getSheets();

  // 1) leer tabla principal
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB3}!A1:F`
  });
  const values = data.values || [];
  if (values.length === 0) return { prices: [], version: '', rate: DEFAULT_RATE };

  // 2) mapear cabeceras
  const header = values[0].map(h => norm(h));
  const col = (names) => {
    for (const name of names) {
      const i = header.indexOf(norm(name));
      if (i >= 0) return i;
    }
    return -1;
  };

  const idx = {
    tipo:   col(['tipo', 'categoria']),
    prod:   col(['producto', 'nombre']),
    pres:   col(['presentacion', 'presentación']),
    unidad: col(['unidad', 'u']),
    usd:    col(['precio (usd)', 'preciousd', 'usd']),
    bs:     col(['precio (bs)', 'preciobs', 'bs']),
  };

  // 3) filas -> objeto normalizado
  const body = values.slice(1);
  const items = [];
  for (const row of body) {
    const tipo   = row[idx.tipo]   ?? '';
    const prod   = row[idx.prod]   ?? '';
    const pres   = row[idx.pres]   ?? '';
    const unidad = row[idx.unidad] ?? '';
    const usdRaw = (row[idx.usd]   ?? '').toString().replace(',','.');
    const bsRaw  = (row[idx.bs]    ?? '').toString().replace(',','.');

    if (!prod && !pres) continue; // fila vacía

    const precio_usd = to2(Number(usdRaw));
    const precio_bs  = to2(Number(bsRaw));
    const uniNorm    = normUnidad(unidad);

    items.push({
      categoria: normCat(tipo),
      sku: buildSku(prod, pres, uniNorm),      // <<–– ahora incluye la UNIDAD
      unidad: uniNorm,
      precio_usd,
      precio_bs
    });
  }

  // 4) metadatos (versión / tc)
  let { version, rate } = await readVersionAndRate(sheets);

  // Si no hay TC en celda, intenta inferirlo con mediana(Bs/Usd)
  if (!Number.isFinite(rate) || rate <= 0) {
    const ratios = items
      .map(r => (r.precio_usd > 0 && r.precio_bs > 0) ? (r.precio_bs / r.precio_usd) : NaN)
      .filter(x => Number.isFinite(x) && x > 0)
      .sort((a,b)=>a-b);
    if (ratios.length) {
      const mid = Math.floor(ratios.length/2);
      rate = ratios.length % 2 ? ratios[mid] : (ratios[mid-1] + ratios[mid]) / 2;
    } else {
      rate = DEFAULT_RATE;
    }
  }

  // Si faltan Bs en alguna fila, complétalos con tc
  for (const r of items) {
    if (!(r.precio_bs > 0) && (r.precio_usd > 0)) {
      r.precio_bs = to2(r.precio_usd * rate);
    }
  }

  if (!version) version = String(Date.now());

  // Orden estable
  items.sort((a,b)=> a.sku.localeCompare(b.sku));

  return { prices: items, version, rate: +to2(rate) };
}

/* =========================
   Caché en memoria
   ========================= */
let _cache = { prices: [], version: '0', rate: DEFAULT_RATE, ts: 0 };
export async function getPrices({ force=false } = {}) {
  const now = Date.now();
  if (!force && _cache.ts && (now - _cache.ts) < TTL_MS) return _cache;
  const fresh = await _fetchPricesRaw();
  _cache = { ...fresh, ts: now };
  return _cache;
}
export async function listPrices(){ return (await getPrices({})).prices; }
export async function getBySku(sku=''){
  const s = String(sku||'').trim().toLowerCase();
  return (await listPrices()).find(r => r.sku.toLowerCase() === s) || null;
}
export async function findPrice({ producto, presentacion='' }){
  const sku = buildSku(producto, presentacion).toLowerCase();
  return (await listPrices()).find(r => r.sku.toLowerCase() === sku) || null;
}

/* =========================
   Rutas públicas (read-only)
   ========================= */
router.get('/api/prices', async (_req,res) => {
  try {
    const { prices, version, rate, ts } = await getPrices({});
    res.json({ prices, version, rate, updatedAt: ts });
  } catch (e) {
    console.error('[prices] /api/prices error:', e?.message || e);
    res.status(500).json({ error: 'PRICE_READ_FAILED' });
  }
});

// Legacy para frontends que esperaban un JSON "plano"
router.get('/price-data.json', async (_req,res) => {
  try {
    const { prices, version, rate } = await getPrices({});
    res.json({ prices, version, rate });
  } catch {
    res.status(500).json({ error: 'PRICE_READ_FAILED' });
  }
});

export default router;
