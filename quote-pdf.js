// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

/* ========= Paleta sobria ========= */
const BRAND = {
  primary:   '#1F7A4C',
  dark:      '#145238',
  accent:    '#6BBF59',
};

const TINT = {
  headerBG:  '#E9F4EE',
  rowBG:     '#F6FBF8',
  totalBG:   '#DDF0E6',
};

const GRID = '#6C7A73';

/* ========= Helpers de color ========= */
function normalizeHex(s, fallback = null) {
  let v = String(s ?? '').trim();
  const m = v.match(/^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if (!m) return fallback;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  return `#${hex.toUpperCase()}`;
}
const SAFE = {
  headerBG: normalizeHex(TINT.headerBG, '#E6E9EC'),
  rowBG:    normalizeHex(TINT.rowBG,    '#F7F9FB'),
  totalBG:  normalizeHex(TINT.totalBG,  '#E9EDE6'),
  grid:     normalizeHex(GRID,          '#000000'),
};
function fillRect(doc, x, y, w, h, color) {
  doc.save();
  doc.fillColor(color);
  doc.rect(x, y, w, h).fill();
  doc.restore();
}
function strokeRect(doc, x, y, w, h, color = SAFE.grid, width = 0.8) {
  doc.save();
  doc.strokeColor(color).lineWidth(width);
  doc.rect(x, y, w, h).stroke();
  doc.restore();
}

/* ========= Helpers de formato ========= */
function fmtDateTZ(date = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat('es-BO', {
      timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date);
  } catch {
    const d = new Date(date);
    const pad = n => String(n).padStart(2,'0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
}
function money(n){
  const s = (Number(n||0)).toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function round2(n){ return Math.round((Number(n)||0) * 100) / 100; }
function toCents(n){ return Math.round((Number(n)||0) * 100); }
function ensure(v, def){ return v==null || v==='' ? def : v; }
function findAsset(p){
  const abs = path.resolve(p);
  return fs.existsSync(abs) ? abs : null;
}

/* ========= Packs ========= */
function detectPackSize(it = {}) {
  if (it.envase) {
    const m = String(it.envase).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|litros?|kg|kilos?)/i);
    if (m) {
      const size = parseFloat(m[1].replace(',','.'));
      const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  if (it.sku) {
    const m = String(it.sku).match(/-(\d+(?:\.\d+)?)(?:\s?)(l|kg)\b/i);
    if (m) {
      const size = parseFloat(m[1]);
      const unit = m[2].toUpperCase();
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  if (it.nombre) {
    const m = String(it.nombre).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|kg)\b/i);
    if (m) {
      const size = parseFloat(m[1].replace(',','.'));
      const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  return null;
}

/* ========= Render PDF ========= */
export async function renderQuotePDF(quote, outPath, company = {}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir, { recursive:true }); }catch{}

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const xMargin = 36;
  const usableW = pageW - xMargin*2;

  // Logo opcional (controlado y sin superposición)
  const logoPath = company.logoPath ? findAsset(company.logoPath) : null;

  // Header superior
  let y = 32;
  if (logoPath){
    try { doc.image(logoPath, xMargin, y, { width: 72, fit: [72, 72] }); } catch {}
  }
  const titleX = xMargin + (logoPath ? 84 : 0);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND.dark)
     .text('COTIZACIÓN', titleX, y);
  if ((company.brandName || '').trim()){
    doc.font('Helvetica').fontSize(9).fillColor('#4B5563')
       .text(String(company.brandName).trim(), titleX, y + 18);
  }
  doc.font('Helvetica').fontSize(9).fillColor('#4B5563')
     .text(fmtDateTZ(quote.fecha || new Date(), TZ), 0, y, { align: 'right' })
     .fillColor('black');

  y = 90;

  // Datos del cliente
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').fillColor(BRAND.dark).text(`${label}: `, xMargin, y, { continued: true });
    doc.font('Helvetica').fillColor('#111').text(ensure(val,'-'));
    y += 16;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);
  L('Pago', 'Contado');

  y += 12;

  /* ===== Tabla que AJUSTA a A4 ===== */
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  // Anchos calculados para sumar EXACTAMENTE 523 pt (A4 - márgenes)
  const cols = [
    { key:'nombre',       label:'Producto',       w:160, align:'left'  },
    { key:'envase',       label:'Envase',         w:60,  align:'left'  },
    { key:'cantidad',     label:'Cantidad',       w:55,  align:'right' },
    { key:'precio_usd',   label:'Precio (USD)',   w:62,  align:'right' },
    { key:'precio_bs',    label:'Precio (Bs)',    w:62,  align:'right' },
    { key:'subtotal_usd', label:'Subtotal (USD)', w:62,  align:'right' },
    { key:'subtotal_bs',  label:'Subtotal (Bs)',  w:62,  align:'right' },
  ];
  const tableX = xMargin;
  const tableW = cols.reduce((a,c)=>a+c.w,0); // 523 exacto

  const headerH = 26;
  const rowPadV = 6;
  const minRowH = 20;

  const ensureSpace = (need = 90) => {
    if (y + need > (pageH - 60)){
      doc.addPage();
      y = 42;
      // No watermark ni logo gigante, mantenemos limpio
    }
  };

  // Encabezado de tabla
  fillRect(doc, tableX, y, tableW, headerH, SAFE.headerBG);
  doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX;
    for (const cdef of cols){
      const innerX = cx + 6;
      doc.text(cdef.label, innerX, y + (headerH-10)/2, { width: cdef.w-12, align: 'center' });
      strokeRect(doc, cx, y, cdef.w, headerH, SAFE.grid, 0.8);
      cx += cdef.w;
    }
  }
  y += headerH;

  doc.fontSize(9).fillColor('black');

  // Acumuladores exactos
  let accUsdCents = 0;
  let accBsCents  = 0;

  for (const itRaw of (quote.items || [])){
    // 1) Precio unitario
    const precioUSD = round2(Number(itRaw.precio_usd || 0));
    const precioBsUnit  = round2(precioUSD * rate);

    // 2) Cantidad (respetar cantidad ingresada, no forzar redondeos aquí)
    const cantidad = Number(itRaw.cantidad || 0);

    // 3) Subtotales
    const subUSD = round2(precioUSD   * cantidad);
    const subBs  = round2(precioBsUnit * cantidad);

    accUsdCents += toCents(subUSD);
    accBsCents  += toCents(subBs);

    const cellTexts = [
      String(itRaw.nombre || ''),
      String(itRaw.envase || ''),
      money(cantidad),
      money(precioUSD),
      money(precioBsUnit),
      money(subUSD),
      money(subBs),
    ];

    // Altura de fila
    const cellHeights = [];
    for (let i=0; i<cols.length; i++){
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], { width: w, align: cols[i].align || 'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);
    ensureSpace(rowH + 10);

    // Fondo fila y bordes
    fillRect(doc, tableX, y, tableW, rowH, SAFE.rowBG);
    let tx = tableX;
    for (let i=0; i<cols.length; i++){
      const cdef = cols[i];
      const innerX = tx + 6;
      const innerW = cdef.w - 12;
      strokeRect(doc, tx, y, cdef.w, rowH, SAFE.grid, 0.7);
      doc.fillColor('#111')
         .font(cdef.key==='nombre' ? 'Helvetica-Bold' : 'Helvetica')
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align || 'left' });
      tx += cdef.w;
    }
    y += rowH;
  }

  // Totales
  const totalUSD = accUsdCents / 100;
  const totalBs  = accBsCents  / 100;

  ensureSpace(56);

  // Separador
  doc.save();
  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(SAFE.grid).lineWidth(0.8).stroke();
  doc.restore();

  const totalRowH = 26;
  const wUntilCol5 = cols.slice(0,5).reduce((a,c)=>a+c.w,0); // 160+60+55+62+62 = 399
  const wCol6      = cols[5].w; // 62
  const wCol7      = cols[6].w; // 62

  // Celda "Total"
  strokeRect(doc, tableX, y, wUntilCol5, totalRowH, SAFE.grid, 0.8);
  doc.font('Helvetica-Bold').fillColor(BRAND.dark).text('Total', tableX, y+6, { width: wUntilCol5, align: 'center' });

  fillRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, SAFE.totalBG);
  fillRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, SAFE.totalBG);

  // Bordes de totales
  strokeRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, SAFE.grid, 0.8);
  strokeRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, SAFE.grid, 0.8);

  // Valores
  doc.font('Helvetica-Bold').fillColor(BRAND.dark)
     .text(`$ ${money(totalUSD)}`, tableX + wUntilCol5, y+6, { width: wCol6-8, align:'right' });
  doc.font('Helvetica-Bold').fillColor(BRAND.dark)
     .text(`${money(totalBs)} Bs`, tableX + wUntilCol5 + wCol6 + 6, y+6, { width: wCol7-12, align:'left' });

  y += totalRowH + 16;

  // Nota precios
  ensureSpace(24);
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
     .text('Precios referenciales sujetos a confirmación de stock y condiciones comerciales.', xMargin, y, { width: usableW });
  doc.fillColor('black');
  y += 20;

  /* ===== Lugar de entrega + Ubicación + Horarios ===== */
  const drawH2 = (t)=>{
    ensureSpace(24);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.dark).text(t, xMargin, y);
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    y = doc.y + 10;
  };

  drawH2('Lugar de entrega');
  const entrega = [
    ensure(company.storeName, 'Almacén Central'),
    'Horarios de atención: Lunes a Viernes 08:30–12:30 y 14:30–18:30'
  ];
  for (const line of entrega){ ensureSpace(16); doc.text(line, xMargin, y); y = doc.y; }

  const mapsUrl = (company.mapsUrl || '').trim();
  if (mapsUrl) {
    ensureSpace(16);
    doc.fillColor(BRAND.primary)
       .text('Ver ubicación en Google Maps', xMargin, y, { width: usableW, link: mapsUrl, underline: true });
    doc.fillColor('black');
    y = doc.y + 14;
  }

  /* ===== Condiciones y validez ===== */
  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1) Oferta válida por 3 días calendario desde la fecha de emisión y sujeta a disponibilidad.',
    '2) Los precios pueden ajustarse según volumen y condiciones pactadas.',
    '3) Para fijar precio y reservar volumen se requiere confirmación de pago y emisión de factura.',
    '4) La entrega se realiza en almacén; se puede apoyar en la coordinación logística si se requiere.'
  ];
  for (const line of conds){ ensureSpace(16); doc.font('Helvetica').text(line, xMargin, y); y = doc.y; }

  // Cierre
  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
