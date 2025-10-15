// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

/* ========= Paleta ========= */
const BRAND = { primary:'#1F7A4C', dark:'#145238' };
const GRID  = '#6C7A73';

/* ========= Utilidades ========= */
function normalizeHex(s, fb=null){
  const m = String(s??'').trim().match(/^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if(!m) return fb;
  const hex = m[1].length===3 ? m[1].split('').map(c=>c+c).join('') : m[1];
  return `#${hex.toUpperCase()}`;
}
const SAFE = {
  headerBG: normalizeHex('#E9F4EE','#E9F4EE'),
  rowBG:    normalizeHex('#F6FBF8','#F6FBF8'),
  totalBG:  normalizeHex('#DDF0E6','#DDF0E6'),
  grid:     normalizeHex(GRID,'#000000'),
};
const money   = (n)=> (Number(n||0)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const round2  = (n)=> Math.round((Number(n)||0)*100)/100;
const toCents = (n)=> Math.round((Number(n)||0)*100);
const ensure  = (v,d)=> (v==null||v==='')?d:v;
function fmtDateTZ(date=new Date(), tz=TZ){
  try{ return new Intl.DateTimeFormat('es-BO',{timeZone:tz,day:'2-digit',month:'2-digit',year:'numeric'}).format(date); }
  catch{ const d=new Date(date),p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`; }
}
function findAsset(p){ const abs = path.resolve(p); return fs.existsSync(abs) ? abs : null; }
function fillRect(doc,x,y,w,h,color){ doc.save(); doc.fillColor(color).rect(x,y,w,h).fill().restore(); }
function strokeRect(doc,x,y,w,h,color=SAFE.grid,width=.8){ doc.save(); doc.strokeColor(color).lineWidth(width).rect(x,y,w,h).stroke().restore(); }

/* ========= NUEVO: Fondo de plantilla ========= */
// Busca la imagen en ./public/cotizacion.jpeg (o .jpg por si acaso)
const TEMPLATE_IMG =
  findAsset('./public/cotizacion.jpeg') ||
  findAsset('./public/cotizacion.jpg')  ||
  null;

// Área segura dentro de la plantilla (márgenes para no pisar logos/bordes)
const SAFE_INSET = { left: 84, top: 120, right: 36, bottom: 72 }; 
// → Ajusta estos números si quieres más/menos aire.

export async function renderQuotePDF(quote, outPath, company = {}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir,{recursive:true}); }catch{}

  // Sin márgenes del documento; la plantilla cubre toda la página
  const doc = new PDFDocument({ size:'A4', margin: 0 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const pageH = doc.page.height;

  const drawBackground = () => {
    if (TEMPLATE_IMG){
      try { doc.image(TEMPLATE_IMG, 0, 0, { width: pageW, height: pageH }); } catch {}
    }
  };
  drawBackground(); // primera página

  // Área útil (dentro del lienzo blanco)
  const xMargin = SAFE_INSET.left;
  const usableW = pageW - SAFE_INSET.left - SAFE_INSET.right;

  // Encabezado (todo dentro del área blanca)
  let y = SAFE_INSET.top;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND.dark).text('COTIZACIÓN', xMargin, y);
  doc.font('Helvetica').fontSize(9).fillColor('#4B5563')
     .text(fmtDateTZ(quote.fecha||new Date(), TZ), xMargin, y, { width: usableW, align:'right' })
     .fillColor('black');
  y += 26;

  // Datos del cliente
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').fillColor(BRAND.dark).text(`${label}: `, xMargin, y, { continued:true });
    doc.font('Helvetica').fillColor('#111').text(ensure(val,'-')); y += 14;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);
  L('Pago', 'Contado');
  y += 10;

  /* ===== Tabla ===== */
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  // Anchuras calculadas para caber dentro de usableW (A4 con nuestros insets)
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
  const tableW = cols.reduce((a,c)=>a+c.w,0); // 523 px

  const headerH = 26, rowPadV = 6, minRowH = 20;
  const bottomLimit = pageH - SAFE_INSET.bottom;

  const ensureSpace = (need=90) => {
    if (y + need > bottomLimit){
      doc.addPage();
      drawBackground();              // ← fondo también en páginas siguientes
      y = SAFE_INSET.top;            // volvemos al área segura
    }
  };

  // Encabezado de tabla
  fillRect(doc, tableX, y, tableW, headerH, SAFE.headerBG);
  doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX;
    for (const cdef of cols){
      const innerX = cx + 6;
      doc.text(cdef.label, innerX, y + (headerH-10)/2, { width: cdef.w-12, align:'center' });
      strokeRect(doc, cx, y, cdef.w, headerH, SAFE.grid, .8);
      cx += cdef.w;
    }
  }
  y += headerH;
  doc.fontSize(9).fillColor('black');

  let accUsdCents = 0, accBsCents = 0;
  for (const itRaw of (quote.items||[])){
    const precioUSD   = round2(Number(itRaw.precio_usd||0));
    const precioBs    = round2(precioUSD * rate);
    const cantidad    = Number(itRaw.cantidad||0);
    const subUSD      = round2(precioUSD * cantidad);
    const subBs       = round2(precioBs   * cantidad);
    accUsdCents += toCents(subUSD);
    accBsCents  += toCents(subBs);

    const cellTexts = [
      String(itRaw.nombre||''),
      String(itRaw.envase||''),
      money(cantidad),
      money(precioUSD),
      money(precioBs),
      money(subUSD),
      money(subBs),
    ];

    const cellHeights = [];
    for (let i=0;i<cols.length;i++){
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], { width:w, align: cols[i].align||'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);
    ensureSpace(rowH + 10);

    fillRect(doc, tableX, y, tableW, rowH, SAFE.rowBG);
    let tx = tableX;
    for (let i=0;i<cols.length;i++){
      const cdef = cols[i], innerX = tx + 6, innerW = cdef.w - 12;
      strokeRect(doc, tx, y, cdef.w, rowH, SAFE.grid, .7);
      doc.fillColor('#111')
         .font(cdef.key==='nombre' ? 'Helvetica-Bold' : 'Helvetica')
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align||'left' });
      tx += cdef.w;
    }
    y += rowH;
  }

  // Totales
  const totalUSD = accUsdCents/100;
  const totalBs  = accBsCents/100;

  ensureSpace(56);
  doc.save().moveTo(tableX, y).lineTo(tableX+tableW, y)
     .strokeColor(SAFE.grid).lineWidth(.8).stroke().restore();

  const totalRowH = 26;
  const wUntilCol5 = cols.slice(0,5).reduce((a,c)=>a+c.w,0);
  const wCol6 = cols[5].w, wCol7 = cols[6].w;

  strokeRect(doc, tableX, y, wUntilCol5, totalRowH, SAFE.grid, .8);
  doc.font('Helvetica-Bold').fillColor(BRAND.dark).text('Total', tableX, y+6, { width:wUntilCol5, align:'center' });

  fillRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, SAFE.totalBG);
  fillRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, SAFE.totalBG);
  strokeRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, SAFE.grid, .8);
  strokeRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, SAFE.grid, .8);

  doc.font('Helvetica-Bold').fillColor(BRAND.dark)
     .text(`$ ${money(totalUSD)}`, tableX + wUntilCol5, y+6, { width:wCol6-8, align:'right' });
  doc.text(`${money(totalBs)} Bs`, tableX + wUntilCol5 + wCol6 + 6, y+6, { width:wCol7-12, align:'left' });

  y += totalRowH + 14;

  // Nota / Condiciones (siguen dentro del área segura)
  const drawH2 = (t)=>{ ensureSpace(22); doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.dark).text(t, xMargin, y); doc.font('Helvetica').fontSize(10).fillColor('#111'); y = doc.y + 8; };

  ensureSpace(20);
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
     .text('Precios referenciales sujetos a confirmación de stock y condiciones comerciales.', xMargin, y, { width: usableW });
  y = doc.y + 6;

  drawH2('Lugar de entrega');
  const entrega = [
    ensure(company.storeName,'Almacén Central'),
    'Horarios de atención: Lunes a Viernes 08:30–12:30 y 14:30–18:30'
  ];
  for (const line of entrega){ ensureSpace(14); doc.text(line, xMargin, y, { width: usableW }); y = doc.y; }

  const mapsUrl = (company.mapsUrl||'').trim();
  if (mapsUrl){
    ensureSpace(16);
    doc.fillColor(BRAND.primary)
       .text('Ver ubicación en Google Maps', xMargin, y, { width: usableW, link: mapsUrl, underline:true });
    doc.fillColor('black'); y = doc.y + 10;
  }

  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1) Oferta válida por 3 días calendario desde la fecha de emisión y sujeta a disponibilidad.',
    '2) Los precios pueden ajustarse según volumen y condiciones pactadas.',
    '3) Para fijar precio y reservar volumen se requiere confirmación de pago y emisión de factura.',
    '4) La entrega se realiza en almacén; se puede apoyar en la coordinación logística si se requiere.'
  ];
  for (const line of conds){ ensureSpace(14); doc.font('Helvetica').text(line, xMargin, y, { width: usableW }); y = doc.y; }

  doc.end();
  await new Promise((res,rej)=>{ stream.on('finish',res); stream.on('error',rej); });
  return outPath;
}
