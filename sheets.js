// src/sheets.js
import 'dotenv/config';
import { google } from 'googleapis';
let _sheets;

// --- Marca / asesor (configurable por .env) ---
const BRAND_NAME   = process.env.BRAND_NAME   || 'Greenfield';
const ADVISOR_NAME = process.env.ADVISOR_NAME || 'Equipo Greenfield';
const ADVISOR_ROLE = process.env.ADVISOR_ROLE || 'Asesor comercial de Greenfield';

/* ===========================
   Autorización / cliente API
   =========================== */
async function getSheets() {
  if (_sheets) return _sheets;

  // 1) Credenciales
  let auth;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;

  try {
    if (raw && raw.trim()) {
      const creds = JSON.parse(raw);
      auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      throw new Error('No hay credenciales de Google. Define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS.');
    }
  } catch (e) {
    console.error('[sheets] Error leyendo GOOGLE_CREDENTIALS_JSON:', e?.message || e);
    throw e;
  }

  const client = await auth.getClient();
  _sheets = google.sheets({ version: 'v4', auth: client });
  return _sheets;
}

/* ===============
   Helpers comunes
   =============== */
const onlyDigits = (s='') => String(s).replace(/[^\d]/g, '');
const pad2 = n => String(n).padStart(2, '0');
const LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';

function formatDisplayDate(d){
  try{
    const parts = new Intl.DateTimeFormat('es-BO', {
      timeZone: LOCAL_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const get = t => parts.find(p => p.type === t)?.value || '';
    const yyyy = get('year'), mm = get('month'), dd = get('day');
    const hh = get('hour'), mi = get('minute');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }catch{
    const yy = d.getFullYear();
    const mm = pad2(d.getMonth()+1);
    const dd = d.getDate();
    const hh = d.getHours();
    const mi = d.getMinutes();
    return `${yy}-${mm}-${dd} ${hh}:${mi}`;
  }
}

const TAB_CLIENTS = process.env.SHEETS_TAB_CLIENTS_NAME || 'WA_CLIENTES';

const H_CLIENTS = {
  telefono: 'Teléfono',
  nombre: 'Nombre Completo',
  ubicacion: 'Ubicación',
  cultivo: 'Cultivo',
  hectareas: 'Hectáreas',
  campana: 'Campaña',
  updated: 'Ultima_actualizacion'
};

function headerIndexMap(headers = []) {
  const map = {};
  headers.forEach((h, i) => { map[String(h).trim().toLowerCase()] = i; });
  return (name) => {
    const idx = map[String(name).trim().toLowerCase()];
    return (typeof idx === 'number') ? idx : -1;
  };
}

function splitUbicacion(ubi = '') {
  const [dep, zona] = String(ubi).split(/\s*-\s*/);
  return { dep: (dep || '').trim(), zona: (zona || '').trim() };
}

/**
 * Busca un cliente por teléfono (solo dígitos).
 * Devuelve: { telefono, nombre, ubicacion, cultivo, hectareas, campana, dep, subzona } | null
 */
export async function getClientByPhone(phoneRaw = '') {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID');

  const phone = onlyDigits(phoneRaw);
  if (!phone) return null;

  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_CLIENTS}!A1:Z10000`
  });

  const rows = r.data.values || [];
  if (!rows.length) return null;

  const headers = rows[0];
  const idx = headerIndexMap(headers);

  const iTel   = idx(H_CLIENTS.telefono);
  const iNom   = idx(H_CLIENTS.nombre);
  const iUbi   = idx(H_CLIENTS.ubicacion);
  const iCult  = idx(H_CLIENTS.cultivo);
  const iHa    = idx(H_CLIENTS.hectareas);
  const iCamp  = idx(H_CLIENTS.campana);

  if (iTel < 0) return null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const tel = onlyDigits(row[iTel] || '');
    if (!tel) continue;
    if (tel === phone) {
      const ubicacion = row[iUbi] || '';
      const { dep, zona } = splitUbicacion(ubicacion);
      return {
        telefono: tel,
        nombre: row[iNom] || '',
        ubicacion,
        cultivo: row[iCult] || '',
        hectareas: row[iHa] || '',
        campana: row[iCamp] || '',
        dep, subzona: zona
      };
    }
  }
  return null;
}

/**
 * Inserta o actualiza (por Teléfono) una fila en WA_CLIENTES.
 * record: { telefono, nombre, ubicacion, cultivo, hectareas, campana }
 */
export async function upsertClientByPhone(record = {}) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID');

  const telefono = onlyDigits(record.telefono || '');
  if (!telefono) return false;

  // Leer hoja completa una vez
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_CLIENTS}!A1:Z10000`
  });
  const rows = r.data.values || [];
  const headers = rows[0] || [
    H_CLIENTS.telefono, H_CLIENTS.nombre, H_CLIENTS.ubicacion,
    H_CLIENTS.cultivo, H_CLIENTS.hectareas, H_CLIENTS.campana, H_CLIENTS.updated
  ];

  // Asegurar encabezados si la hoja estaba vacía
  if (rows.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_CLIENTS}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }

  const idx = headerIndexMap(headers);
  const iTel   = idx(H_CLIENTS.telefono);
  const iNom   = idx(H_CLIENTS.nombre);
  const iUbi   = idx(H_CLIENTS.ubicacion);
  const iCult  = idx(H_CLIENTS.cultivo);
  const iHa    = idx(H_CLIENTS.hectareas);
  const iCamp  = idx(H_CLIENTS.campana);
  const iUpd   = idx(H_CLIENTS.updated);

  const now = new Date();
  const updated = formatDisplayDate(now);

  // Buscar fila existente
  let foundRowIndex = -1; // índice absoluta en hoja (0-based)
  for (let i = 1; i < rows.length; i++) {
    const tel = onlyDigits((rows[i] || [])[iTel] || '');
    if (tel === telefono) { foundRowIndex = i; break; }
  }

  // Construir la fila con posición de columnas correcta
  const rowOut = new Array(headers.length).fill('');
  // Rellenar existentes para no borrar otras columnas que el usuario hubiera agregado
  if (foundRowIndex >= 0) {
    const prev = rows[foundRowIndex] || [];
    for (let c = 0; c < headers.length; c++) rowOut[c] = prev[c] || '';
  }

  if (iTel  >= 0) rowOut[iTel]  = telefono;
  if (iNom  >= 0) rowOut[iNom]  = record.nombre || rowOut[iNom] || '';
  if (iUbi  >= 0) rowOut[iUbi]  = record.ubicacion || rowOut[iUbi] || '';
  if (iCult >= 0) rowOut[iCult] = record.cultivo || rowOut[iCult] || '';
  if (iHa   >= 0) rowOut[iHa]   = record.hectareas || rowOut[iHa] || '';
  if (iCamp >= 0) rowOut[iCamp] = record.campana || rowOut[iCamp] || '';
  if (iUpd  >= 0) rowOut[iUpd]  = updated;

  if (foundRowIndex >= 0) {
    // UPDATE fila existente (foundRowIndex es 0-based; +1 para 1-based de Sheets)
    const rowNumber = foundRowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_CLIENTS}!A${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowOut] }
    });
  } else {
    // APPEND nueva fila
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_CLIENTS}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowOut] }
    });
  }
  return true;
}

/* =====================================
   Construcción de filas para "Hoja 1"
   (NO TOCAR lo existente)
   ===================================== */
function buildSummaryBullets(s, fechaDisplay) {
  const nombre = s?.profileName || s?.fullName || 'Cliente';
  const dep    = s?.vars?.departamento || 'ND';
  const zona   = s?.vars?.subzona || 'ND';
  const cultivo= (s?.vars?.cultivos && s.vars.cultivos[0]) || 'ND';
  const ha     = s?.vars?.hectareas || 'ND';
  const camp   = s?.vars?.campana || 'ND';
  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];
  const items = (carrito.length > 0) ? carrito : [{
    nombre: s?.vars?.last_product || '',
    presentacion: s?.vars?.last_presentacion || '',
    cantidad: s?.vars?.cantidad || ''
  }].filter(it => it.nombre);

  const linesProductos = items.map(it => {
    const pres = it.presentacion ? ` (${it.presentacion})` : '';
    const cant = it.cantidad ? ` — ${it.cantidad}` : '';
    return `* ${it.nombre}${pres}${cant}`;
  });

  const base = [
    `* Fecha: ${fechaDisplay}`,
    `* ${nombre}`,
    `* Departamento: ${dep}`,
    `* Zona: ${zona}`,
    `* Cultivo: ${cultivo}`,
    `* Hectáreas: ${ha}`,
    `* Campaña: ${camp}`,
    ...linesProductos
  ];

  return base.join('\n');
}

function buildClientMessage({ nombre, items }) {
  const quien = nombre || 'Hola';
  const lines = items.map(it => {
    const pres = it.presentacion ? ` (${it.presentacion})` : '';
    const cant = it.cantidad ? ` — ${it.cantidad}` : '';
    return `• ${it.nombre}${pres}${cant}`;
  });
  return [
    `Hola ${quien}, soy ${ADVISOR_NAME}, ${ADVISOR_ROLE}.`,
    `Te escribo por tu cotización de ${BRAND_NAME} con los siguientes productos:`,
    ...lines
  ].join('\n');
}
function buildWaLinkTo(numberDigits, message) {
  const to = onlyDigits(numberDigits);
  const text = encodeURIComponent(message);
  return to ? `https://wa.me/${to}?text=${text}` : '';
}

function buildShareLink(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

function buildGroupShareMessage({ resumen, linkClienteConMensaje }) {
  return [
    `Resumen de solicitud:`,
    resumen,
    ``,
    `Contacto del cliente: ${linkClienteConMensaje}`
  ].join('\n');
}

function buildRowFromSession(s, fromPhone, estado = 'NUEVO') {
  const now = new Date();
  const fechaDisplay = formatDisplayDate(now);

  const fullName = s?.fullName || s?.profileName || '';
  const dep = s?.vars?.departamento || '';
  const zona = s?.vars?.subzona || '';
  const ubicacion = [dep, zona].filter(Boolean).join(' - ');
  const cultivo = (s?.vars?.cultivos && s.vars.cultivos[0]) || '';
  const hectareas = s?.vars?.hectareas || '';
  const campana = s?.vars?.campana || '';

  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];
  const items = (carrito.length > 0)
    ? carrito
    : [{
        nombre: s?.vars?.last_product || '',
        presentacion: s?.vars?.last_presentacion || '',
        cantidad: s?.vars?.cantidad || ''
      }].filter(it => it.nombre);

  const productoCell     = items.map(it => it?.nombre || '').join('\n');
  const presentacionCell = items.map(it => it?.presentacion || '').join('\n');
  const cantidadCell     = items.map(it => it?.cantidad || '').join('\n');

  const cotizacion_id = `${Date.now()}-${String(fromPhone || '').slice(-7)}`;
  const resumenTxt = buildSummaryBullets(s, fechaDisplay);
  const clientMsg   = buildClientMessage({ nombre: fullName, items });
  const linkCliente = buildWaLinkTo(fromPhone, clientMsg);
  const groupMsg = buildGroupShareMessage({ resumen: resumenTxt, linkClienteConMensaje: linkCliente });
  const resumenPedidoLink = buildShareLink(groupMsg);

  const EST = String(estado || '').toUpperCase();
  const estadoFinal = (EST === 'NUEVO' || EST === 'PENDIENTE' || EST === 'CERRADO') ? EST : 'NUEVO';
  const seguimiento = '';
  const calId = '';
  const phoneDigitsOnly = onlyDigits(fromPhone);

  return [
    fechaDisplay,         // 0 Fecha (legible local)
    phoneDigitsOnly,      // 1 Teléfono
    fullName,             // 2 Nombre Completo
    ubicacion,            // 3 Ubicación
    cultivo,              // 4 Cultivo
    String(hectareas||''),// 5 Hectáreas
    campana,              // 6 Campaña
    productoCell,         // 7 Producto
    presentacionCell,     // 8 Presentacion
    cantidadCell,         // 9 Cantidad
    estadoFinal,          // 10 Estado
    linkCliente,          // 11 Contacto Cliente (link con saludo)
    resumenPedidoLink,    // 12 Resumen Pedido (link para compartir)
    seguimiento,          // 13 Seguimiento
    cotizacion_id,        // 14 cotizacion_id
    calId                 // 15 calendar_event_id
  ];
}

/* =========================
   Hoja 1 – append existente
   ========================= */
export async function appendFromSession(s, fromPhone, estado = 'NUEVO') {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const tab = process.env.SHEETS_TAB_NAME || 'Hoja 1';

  if (!spreadsheetId) {
    throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  }

  const values = [buildRowFromSession(s, fromPhone, estado)];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values[0][14]; // cotizacion_id
}

const TAB2_DEFAULT = process.env.SHEETS_TAB2_NAME || 'Hoja 2';

// Normaliza fechas dd/mm/aaaa o dd-mm-aaaa -> dd/mm/aaaa
function normalizeDateDMY(s=''){
  const t = String(s).trim();
  const m = t.match(/^([0-3]?\d)[\/\-]([0-1]?\d)[\/\-](\d{2,4})$/);
  if (!m) return t;
  let [_, d, mo, y] = m;
  if (y.length === 2) y = Number(y) >= 70 ? `19${y}` : `20${y}`;
  return `${pad2(d)}/${pad2(mo)}/${y}`;
}
const MONTH_MAP = {
  'enero':1,'ene':1,
  'febrero':2,'feb':2,
  'marzo':3,'mar':3,
  'abril':4,'abr':4,
  'mayo':5,'may':5,
  'junio':6,'jun':6,
  'julio':7,'jul':7,
  'agosto':8,'ago':8,
  'septiembre':9,'setiembre':9,'sep':9,'set':9,
  'octubre':10,'oct':10,
  'noviembre':11,'nov':11,
  'diciembre':12,'dic':12
};

const WEEKDAY_MAP = {
  'domingo':0,
  'lunes':1,
  'martes':2,
  'miercoles':3, 'miércoles':3,
  'jueves':4,
  'viernes':5,
  'sabado':6, 'sábado':6
};

const NORM = (s='') => s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();

// Fecha "hoy/mañana/pasado mañana" o "viernes / este viernes / próximo viernes"
function nextDateFromWords(text){
  const t = NORM(text);

  // 1) hoy / mañana / pasado mañana
  if (/\bhoy\b/.test(t)) return dmyFromOffset(0);
  if (/\bmanana\b/.test(t)) return dmyFromOffset(1);
  if (/\bpasado\s+manana\b/.test(t)) return dmyFromOffset(2);

  // 2) día de semana (opcional: este|proximo)
  const m = t.match(/\b(este|prox(?:imo)?)?\s*(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (m){
    const qualifier = m[1] || '';
    const dayName   = m[2];
    const targetDow = WEEKDAY_MAP[dayName];
    if (typeof targetDow === 'number') {
      return nextWeekdayDMY(targetDow, /prox/.test(qualifier));
    }
  }
  return '';
}

// Fecha "11 de octubre (2025)" | "11 oct" | "11-oct"
function dateFromDayMonthWords(text){
  const t = NORM(text).replace(/-/g,' ');
  const m = t.match(/\b([0-3]?\d)\s*(?:de\s*)?([a-záéíóúñ]{3,12})\.?(?:\s*de\s*(\d{2,4}))?\b/);
  if (!m) return '';
  const d = parseInt(m[1],10);
  const monName = m[2];
  const yRaw = m[3];

  let mo = MONTH_MAP[monName];
  if (!mo) return '';
  let y;
  if (yRaw) {
    y = String(yRaw).length===2 ? (Number(yRaw)>=70 ? 1900+Number(yRaw) : 2000+Number(yRaw)) : Number(yRaw);
  } else {
    // sin año: usa el más próximo (si ya pasó este año, pasa al siguiente)
    const { y:cy, m:cm, d:cd } = todayYMD();
    y = cy;
    if (mo < cm || (mo===cm && d < cd)) y = cy + 1;
  }
  return `${pad2(d)}/${pad2(mo)}/${y}`;
}

// Helpers para "hoy" en zona LOCAL_TZ
function todayYMD(){
  try{
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: LOCAL_TZ, year:'numeric', month:'2-digit', day:'2-digit'
    }).formatToParts(new Date());
    const get = t => parts.find(p=>p.type===t)?.value || '';
    return { y: +get('year'), m: +get('month'), d: +get('day') };
  }catch{
    const d = new Date();
    return { y:d.getFullYear(), m:d.getMonth()+1, d:d.getDate() };
  }
}

function dmyFromOffset(days){
  const { y, m, d } = todayYMD();
  const base = new Date(Date.UTC(y, m-1, d));
  const tgt  = new Date(base.getTime() + days*24*60*60*1000);
  return `${pad2(tgt.getUTCDate())}/${pad2(tgt.getUTCMonth()+1)}/${pad2(tgt.getUTCFullYear())}`;
}

function nextWeekdayDMY(targetDow, forceNextWeek=false){
  const { y, m, d } = todayYMD();
  const base = new Date(Date.UTC(y, m-1, d));
  const todayDow = base.getUTCDay(); // 0..6
  let delta = (targetDow - todayDow + 7) % 7;
  if (delta === 0 && (forceNextWeek || true)) delta = 7;
  // ↑ si escriben "viernes" y hoy es viernes, lo mandamos al siguiente viernes
  const tgt = new Date(base.getTime() + delta*24*60*60*1000);
  return `${pad2(tgt.getUTCDate())}/${pad2(tgt.getUTCMonth()+1)}/${pad2(tgt.getUTCFullYear())}`;
}

// Limpia y estandariza “placa”
function normalizePlate(s=''){
  return String(s).toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9\-]/g,'');
}

// helper para comparar nombres sin tildes/ruido
const normName = (s='') => String(s)
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu,'')
  .replace(/[^a-z0-9 ]/gi,'')
  .trim()
  .toLowerCase();

export function parseClientResponse(text = '', fallbackName = '') {
  const out = {
    nombreCliente: (fallbackName || '').trim(),
    razonSocial: '',
    nit: '',
    nombreChofer: '',
    ciChofer: '',     // <— NUEVO
    placa: '',
    fechaRecojo: ''
  };

  const lines = String(text || '')
    .split(/\r?\n|,|;/)
    .map(s => s.trim())
    .filter(Boolean);

  const tryMatch = (regex, line) => {
    const m = line.match(regex);
    return m ? m[m.length - 1].trim() : '';
  };

  const reNombre = /(nombre\s+del\s+cliente|cliente)\s*[:\-]\s*(.+)/i;
  const reRazon  = /(raz[oó]n(?:\s+social)?|rs)\s*[:\-]\s*(.+)/i;
  const reNIT    = /\b(nit)\s*[:\-]\s*([A-Za-z0-9.\-\/]+)/i;
  const reChofer = /(nombre\s+del\s+chofer|chofer|conductor)\s*[:\-]\s*(.+)/i;
  const rePlaca  = /(placa(?:\s+del\s+veh[ií]culo)?|placa)\s*[:\-]\s*([A-Za-z0-9\-\s]{4,})/i;
  const reFecha  = /(fecha(?:\s+de)?\s*(recojo|retiro)?)(?:\s*\([^)]*\))?\s*[:\-]\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{2,4})/i;

  // CI / Carnet de Identidad (acepta C.I., CI, cédula, etc.)
  const reCI     = /(c\.?\s*i\.?|ci|carnet(?:\s+de)?\s+identidad|cedula|c[eé]dula)(?:\s+(?:del|de)\s+chofer)?\s*[:\-]\s*([A-Za-z0-9.\-\/\s]+)/i;

  // 1) Con títulos línea a línea
  for (const line of lines) {
    if (!out.nombreCliente) {
      const v = tryMatch(reNombre, line); if (v) out.nombreCliente = v;
    }
    if (!out.razonSocial) {
      const v = tryMatch(reRazon,  line); if (v) out.razonSocial = v;
    }
    if (!out.nit) {
      const m = line.match(reNIT);   if (m) out.nit = m[2].trim();
    }
    if (!out.nombreChofer) {
      const v = tryMatch(reChofer, line); if (v) out.nombreChofer = v;
    }
    if (!out.ciChofer) {
      const m = line.match(reCI);    if (m) out.ciChofer = onlyDigits(m[2]);
    }
    if (!out.placa) {
      const m = line.match(rePlaca); if (m) out.placa = normalizePlate(m[2]);
    }
    if (!out.fechaRecojo) {
      const m = line.match(reFecha); if (m) out.fechaRecojo = normalizeDateDMY(m[3]);
    }
  }

  // === Fallbacks de FECHA (sin título / formatos flexibles) ===

  // 2) dd/mm(/aa|aaaa) o dd-mm(/aa|aaaa) en todo el texto
  if (!out.fechaRecojo) {
    const m0 = String(text).match(/([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?/);
    if (m0) {
      const d  = (+m0[1]);
      const mo = (+m0[2]);
      let y;
      if (m0[3]) {
        const yy = m0[3];
        y = yy.length === 2 ? (Number(yy) >= 70 ? 1900 + Number(yy) : 2000 + Number(yy)) : Number(yy);
      } else {
        // sin año → usa el más próximo
        const { y:cy, m:cm, d:cd } = todayYMD();
        y = (mo < cm || (mo === cm && d < cd)) ? cy + 1 : cy;
      }
      out.fechaRecojo = `${pad2(d)}/${pad2(mo)}/${y}`;
    }
  }

  // 3) "11 de octubre (2025)" | "11 oct"
  if (!out.fechaRecojo) {
    const dm = dateFromDayMonthWords(text);
    if (dm) out.fechaRecojo = dm;
  }

  // 4) "hoy / mañana / pasado mañana" o "viernes / este viernes / próximo viernes"
  if (!out.fechaRecojo) {
    const w = nextDateFromWords(text);
    if (w) out.fechaRecojo = w;
  }

  // 5) Variante con guion tras el título y paréntesis antes
  if (!out.fechaRecojo) {
    const m1 = String(text).match(/fecha(?:\s+de)?\s*(?:recojo|retiro)?(?:\s*\([^)]*\))?\s*-\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{2,4})/i);
    if (m1) out.fechaRecojo = normalizeDateDMY(m1[1]);
  }

  // === Fallbacks de CI (sin título / variantes) ===
  if (!out.ciChofer) {
    // patrón “CI ... 123456 LP” o “carnet identidad 987654 SC”
    const mCI = String(text).match(/(?:c\.?\s*i\.?|ci|carnet(?:\s+de)?\s+identidad|cedula|c[eé]dula)[^0-9]{0,15}([0-9.\-\/\s]{5,})/i);
    if (mCI) out.ciChofer = onlyDigits(mCI[1]);
  }

  // === Fallbacks de otros campos sin título ===
  const fbNorm = normName(fallbackName);
  const labeledHints = /(raz[oó]n|rs|nit|chofer|conductor|placa|fecha|cliente|carnet|ci|cedula|c[eé]dula)\s*[:\-]/i;
  const bare = lines.filter(l => !labeledHints.test(l));

  if (!out.razonSocial && bare.length) {
    const hit = bare.find(l => normName(l) === fbNorm);
    if (hit) out.razonSocial = hit.trim();
  }
  if (!out.nit) {
    const m = bare.map(l => l.match(/^\s*([0-9.\-\/]{5,})\s*$/)).find(Boolean);
    if (m) out.nit = m[1].trim();
  }
  if (!out.razonSocial && bare.length === 1 && bare[0].length >= 3 && !/^\d+$/.test(bare[0])) {
    out.razonSocial = bare[0].trim();
  }

  // Fallbacks directos por regex sueltos
  if (!out.razonSocial) {
    const m = text.match(/rs\s*[:\-]\s*([^\n;]+)/i) || text.match(/raz[oó]n\s*social\s*[:\-]\s*([^\n;]+)/i);
    if (m) out.razonSocial = m[1].trim();
  }
  if (!out.nit) {
    const m = text.match(/\bnit\s*[:\-]\s*([A-Za-z0-9.\-\/]+)/i);
    if (m) out.nit = m[1].trim();
  }

  // Limpieza final
  out.razonSocial   = out.razonSocial.replace(/\s+/g, ' ').trim();
  out.nombreChofer  = out.nombreChofer.replace(/\s+/g, ' ').trim();
  out.nombreCliente = out.nombreCliente.replace(/\s+/g, ' ').trim();
  out.ciChofer      = onlyDigits(out.ciChofer); // ← asegurar solo dígitos

  return out;
}

/**
 * Guarda en Hoja 2 con columnas:
 * Nombre Cliente | Razón Social | NIT | Nombre Chofer | CI Chofer | Placa | Fecha de Recojo
 */
export async function appendBillingPickupRow({ nombreCliente, razonSocial, nit, nombreChofer, ciChofer, placa, fechaRecojo }){
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const tab2 = TAB2_DEFAULT;

  if (!spreadsheetId) {
    throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  }

  const values = [[
    nombreCliente || '',
    razonSocial   || '',
    nit           || '',
    nombreChofer  || '',
    onlyDigits(ciChofer || ''), // ← normalizado a dígitos
    placa         || '',
    fechaRecojo   || ''
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab2}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return true;
}

export async function parseAndAppendClientResponse({ text, clientName }){
  const parsed = parseClientResponse(text || '', clientName || '');
  await appendBillingPickupRow(parsed);
  return parsed;
}

/* =========================================================
   NUEVO: Hoja 3 (PRECIOS) y Hoja 4 (HISTORIAL) — MISMA PLANILLA
   ========================================================= */

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;

// Nombres por defecto (puedes cambiarlos con variables de entorno)
const TAB3_PRECIOS = process.env.SHEETS_TAB3_NAME || 'Hoja 3';
const TAB4_HIST    = process.env.SHEETS_TAB4_NAME || 'Hoja 4';

// Celdas para control de versión y TC (tipo de cambio) en Hoja 3.
// Como tu fila 1 ya es encabezado (A:F), guardamos estos metadatos fuera (por defecto J1/J2).
const PRECIOS_VERSION_CELL = process.env.SHEETS_PRICES_VERSION_CELL || `${TAB3_PRECIOS}!J1`;
const PRECIOS_RATE_CELL    = process.env.SHEETS_PRICES_RATE_CELL    || `${TAB3_PRECIOS}!J2`;

/**
 * Lee precios desde Hoja 3 con encabezados:
 * A: TIPO | B: PRODUCTO | C: PRESENTACION | D: UNIDAD | E: PRECIO (USD) | F: PRECIO (BS)
 * Devuelve: { prices:[{categoria, sku, unidad, precio_usd, precio_bs}], version, rate }
 */
export async function readPrices() {
  const sheets = await getSheets();

  // 1) Leer versión y TC (si no existen, defaults)
  let version = 1;
  let rate = 6.96;

  try {
    const meta = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [PRECIOS_VERSION_CELL, PRECIOS_RATE_CELL],
    });
    const vRaw = meta.data.valueRanges?.[0]?.values?.[0]?.[0];
    const rRaw = meta.data.valueRanges?.[1]?.values?.[0]?.[0];
    version = Number(vRaw || 1);
    rate = Number(rRaw || 6.96);
  } catch {
    // sin romper si no existen
  }

  // 2) Leer tabla (desde fila 2 porque fila 1 son encabezados)
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB3_PRECIOS}!A2:F`,
  });

  const rows = r.data.values || [];
  const prices = rows
    .filter(row => (row[0] || row[1] || row[2] || row[3] || row[4] || row[5]))
    .map(row => {
      const tipo = row[0] || '';
      const producto = row[1] || '';
      const presentacion = row[2] || '';
      const unidad = row[3] || '';
      const pUsd = Number((row[4] || '').toString().replace(',', '.')) || 0;
      const pBs  = Number((row[5] || '').toString().replace(',', '.')) || 0;

      // UI consume sku unificado "PRODUCTO-PRESENTACION"
      const sku = presentacion ? `${producto}-${presentacion}` : producto;

      return {
        categoria: tipo,
        sku,
        unidad,
        precio_usd: pUsd,
        precio_bs: pBs
      };
    });

  return { prices, version, rate };
}

/**
 * Escribe precios en Hoja 3 (sobrescribe desde A2:F) con control de versión.
 * expectedVersion: la versión que leyó el cliente; si no coincide con la actual → 409.
 */
export async function writePrices(prices, expectedVersion) {
  const sheets = await getSheets();

  // 1) Chequear versión actual
  let currentVersion = 1;
  try {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: PRECIOS_VERSION_CELL,
    });
    currentVersion = Number(cur.data.values?.[0]?.[0] || 1);
  } catch {}

  if (Number(expectedVersion) !== Number(currentVersion)) {
    const err = new Error('VERSION_MISMATCH');
    err.code = 409;
    throw err;
  }

  // 2) Preparar valores para A2:F
  const body = {
    values: (prices || []).map(p => {
      // sku -> (producto, presentacion) separados para tu encabezado
      let producto = '';
      let presentacion = '';
      const sku = String(p.sku || '').trim();
      if (sku.includes('-')) {
        const parts = sku.split('-');
        producto = parts.shift() || '';
        presentacion = parts.join('-') || '';
      } else {
        producto = sku;
        presentacion = '';
      }
      return [
        p.categoria || '',       // A: TIPO
        producto || '',          // B: PRODUCTO
        presentacion || '',      // C: PRESENTACION
        p.unidad || '',          // D: UNIDAD
        Number(p.precio_usd || 0), // E: PRECIO (USD)
        Number(p.precio_bs || 0)   // F: PRECIO (BS)
      ];
    }),
  };

  // 3) Limpiar rango y reescribir
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB3_PRECIOS}!A2:F`,
  });

  if (body.values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB3_PRECIOS}!A2`,
      valueInputOption: 'RAW',
      requestBody: body,
    });
  }

  // 4) Incrementar versión
  const nextVersion = Number(currentVersion) + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: PRECIOS_VERSION_CELL,
    valueInputOption: 'RAW',
    requestBody: { values: [[ nextVersion ]] },
  });

  return nextVersion;
}

/** Lee el tipo de cambio (TC) desde Hoja 3 (celda PRECIOS_RATE_CELL). */
export async function readRate() {
  const sheets = await getSheets();
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: PRECIOS_RATE_CELL,
    });
    return Number(r.data.values?.[0]?.[0] || 6.96);
  } catch {
    return 6.96;
  }
}

/** Escribe el tipo de cambio (TC) en Hoja 3 (celda PRECIOS_RATE_CELL). */
export async function writeRate(rate) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: PRECIOS_RATE_CELL,
    valueInputOption: 'RAW',
    requestBody: { values: [[ Number(rate || 0) ]] },
  });
  return true;
}

/* =============================
   Hoja 4: HISTORIAL de mensajes
   ============================= */

/**
 * Append de mensaje:
 * Columnas: wa_id | nombre | ts_iso | role | content
 */
export async function appendMessage({ waId, name, ts, role, content }) {
  const sheets = await getSheets();
  const row = [
    String(waId || ''),
    String(name || ''),
    new Date(ts || Date.now()).toISOString(),
    String(role || ''),
    String(content || ''),
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB4_HIST}!A1:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

/**
 * Lee historial (últimos N días) para un wa_id.
 * Retorna [{wa_id,name,ts,role,content}] ordenado por ts asc.
 */
export async function historyForIdLastNDays(waId, days = 7) {
  const sheets = await getSheets();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB4_HIST}!A1:E`,
  });
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = r.data.values || [];

  // Si hay encabezado en fila 1, los datos empiezan en fila 2
  const data = rows.slice(1);

  return data
    .map(row => ({
      wa_id: row[0],
      name: row[1],
      ts: Date.parse(row[2]),
      role: row[3],
      content: row[4],
    }))
    .filter(x =>
      x.wa_id === String(waId) &&
      Number.isFinite(x.ts) &&
      x.ts >= since
    )
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Resúmenes para Inbox (últimos N días).
 * Retorna [{ id, name, last, lastTs }]
 */
export async function summariesLastNDays(days = 7) {
  const sheets = await getSheets();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB4_HIST}!A1:E`,
  });
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = r.data.values || [];
  const data = rows.slice(1);

  const map = new Map(); // wa_id -> { id, name, last, lastTs }
  for (const row of data) {
    const wa_id = row[0];
    const name  = row[1] || '';
    const ts    = Date.parse(row[2]);
    const role  = row[3] || '';
    const content = row[4] || '';
    if (!wa_id || !Number.isFinite(ts) || ts < since) continue;
    const cur = map.get(wa_id) || { id: wa_id, name: name || wa_id, last: '', lastTs: 0 };
    if (ts >= cur.lastTs) {
      cur.name = name || wa_id;
      cur.last = content || (role ? `[${role}]` : '');
      cur.lastTs = ts;
    }
    map.set(wa_id, cur);
  }
  return [...map.values()];
}

/**
 * Purga por chat (Hoja 4):
 * Si un wa_id no tiene mensajes en los últimos N días, elimina TODAS sus filas.
 * Mantiene la fila de encabezados.
 */
export async function pruneExpiredConversations(days = 7) {
  const sheets = await getSheets();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB4_HIST}!A1:E`,
  });
  const rows = r.data.values || [];
  if (!rows.length) return { kept: 0, removed: 0 };

  const header = rows[0] || ['wa_id','nombre','ts_iso','role','content'];
  const data = rows.slice(1);

  // agrupar por wa_id
  const byId = new Map();
  for (const row of data) {
    const wa = row[0];
    const ts = Date.parse(row[2]);
    if (!wa || !Number.isFinite(ts)) continue;
    const arr = byId.get(wa) || [];
    arr.push({ row, ts });
    byId.set(wa, arr);
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const keepRows = [];
  let removed = 0;
  for (const [, arr] of byId.entries()) {
    const lastTs = Math.max(...arr.map(x => x.ts));
    if (lastTs >= cutoff) {
      for (const x of arr) keepRows.push(x.row);
    } else {
      removed += arr.length;
    }
  }

  // reescribir la hoja completa
  const all = [header, ...keepRows];
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB4_HIST}!A1:E`,
  });
  if (all.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB4_HIST}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: all },
    });
  }
  return { kept: keepRows.length, removed };
}
// Reemplaza tus no-ops del final de src/sheets.js por esto:
export async function appendChatHistoryRow({ wa_id, nombre, ts_iso, role, content }) {
  return appendMessage({ waId: wa_id, name: nombre, ts: ts_iso, role, content });
}

export async function purgeOldChatHistory(days = 7) {
  return pruneExpiredConversations(days);
}


export { getSheets, buildRowFromSession };
