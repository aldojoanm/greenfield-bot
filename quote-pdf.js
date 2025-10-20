// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

/* ====== Colores ====== */
const BRAND = { primary: '#264229', dark: '#264229' }; // verde exacto
const GRID  = '#6C7A73';
const TINTS = { headerBG:'#E9F4EE', rowBG:'#F6FBF8', totalBG:'#DDF0E6' };

/* ====== Utils ====== */
const money   = (n)=> (Number(n||0)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const round2  = (n)=> Math.round((Number(n)||0)*100)/100;
const toCents = (n)=> Math.round((Number(n)||0)*100);
const ensure  = (v,d)=> (v==null||v==='')?d:v;

function fmtLongDate(date=new Date(), tz=TZ){
  try{
    return new Intl.DateTimeFormat('es-BO',{ timeZone:tz, day:'2-digit', month:'long', year:'numeric' }).format(date);
  }catch{
    const d=new Date(date);
    const meses=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const dd=String(d.getDate()).padStart(2,'0'); return `${dd} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
  }
}
function findAsset(p){ const abs = path.resolve(p); return fs.existsSync(abs) ? abs : null; }
function fillRect(doc,x,y,w,h,color){ doc.save(); doc.fillColor(color).rect(x,y,w,h).fill().restore(); }
function strokeRect(doc,x,y,w,h,color=GRID,width=.8){ doc.save(); doc.strokeColor(color).lineWidth(width).rect(x,y,w,h).stroke().restore(); }

/* ====== Fondo de plantilla ====== */
const TEMPLATE_IMG = findAsset('./public/cotizacion.jpeg') || findAsset('./public/cotizacion.jpg') || null;
/* Título aún más arriba y más aire con la tabla */
const SAFE_INSET = { left: 74, top: 70, right: 40, bottom: 70 };
const MAPS_FALLBACK_URL = 'https://share.google/wUfCQTPu0oaYZmStj';

/* ====== Tipografías Futura ====== */
function registerFonts(doc){
  const fontsDir = './public/fonts';
  const p = (f)=> findAsset(path.join(fontsDir, f));
  const reg = {};
  const book   = p('FuturaStdBook.otf');
  const medium = p('FuturaStdMedium.otf');
  const heavy  = p('FuturaStdHeavy.otf');
  const light  = p('FuturaStdLight.otf');

  try{ if (book)   doc.registerFont('FuturaBook',   book); }catch{}
  try{ if (medium) doc.registerFont('FuturaMedium', medium); }catch{}
  try{ if (heavy)  doc.registerFont('FuturaHeavy',  heavy); }catch{}
  try{ if (light)  doc.registerFont('FuturaLight',  light); }catch{}

  reg.body   = book   ? 'FuturaBook'   : 'Helvetica';
  reg.medium = medium ? 'FuturaMedium' : 'Helvetica-Bold';
  reg.bold   = heavy  ? 'FuturaHeavy'  : 'Helvetica-Bold';
  reg.light  = light  ? 'FuturaLight'  : 'Helvetica';

  return reg;
}

/* ====== Render ====== */
export async function renderQuotePDF(quote, outPath, company = {}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir,{recursive:true}); }catch{}

  const doc = new PDFDocument({ size:'A4', margin: 0 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const F = registerFonts(doc);
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  const drawBackground = () => {
    if (TEMPLATE_IMG){
      try { doc.image(TEMPLATE_IMG, 0, 0, { width: pageW, height: pageH }); } catch {}
    }
  };
  drawBackground();

  // Área útil
  const xMargin = SAFE_INSET.left;
  const usableW = pageW - SAFE_INSET.left - SAFE_INSET.right;
  const bottomLimit = pageH - SAFE_INSET.bottom;
  let y = SAFE_INSET.top;

  /* ===== Header ===== */
  doc.font(F.bold).fontSize(19).fillColor(BRAND.dark).text('COTIZACIÓN', xMargin, y, { width: usableW });
  y += 10; // MÁS separación con la fecha
  doc.font(F.medium).fontSize(11).fillColor(BRAND.dark)
     .text(`Fecha: ${fmtLongDate(quote.fecha || new Date(), TZ)}`, xMargin, y, { width: usableW });
  y += 20;

  // Datos del cliente
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font(F.medium).fillColor(BRAND.dark).text(`${label}: `, xMargin, y, { continued:true });
    doc.font(F.body).fillColor('#111').text(ensure(val,'-'));
  };
  L('Nombre', c.nombre);               y += 12;
  L('Departamento', c.departamento);   y += 12;
  L('Zona', c.zona);                   y += 12;
  L('Pago', 'Contado');                y += 16; // MÁS AIRE ANTES DE LA TABLA

  /* ===== Tabla ===== */
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  const baseCols = [
    { key:'nombre',       label:'Producto',       w:160, align:'left'  },
    { key:'envase',       label:'Envase',         w:60,  align:'left'  },
    { key:'cantidad',     label:'Cantidad',       w:55,  align:'right' },
    { key:'precio_usd',   label:'Precio (USD)',   w:62,  align:'right' },
    { key:'precio_bs',    label:'Precio (Bs)',    w:62,  align:'right' },
    { key:'subtotal_usd', label:'Subtotal (USD)', w:62,  align:'right' },
    { key:'subtotal_bs',  label:'Subtotal (Bs)',  w:62,  align:'right' },
  ];
  const baseW = baseCols.reduce((a,c)=>a+c.w,0); // 523
  const scale = Math.min(1, usableW / baseW);
  const cols  = baseCols.map(c => ({ ...c, w: Math.floor(c.w * scale) }));
  const tableX = xMargin;
  const tableW = cols.reduce((a,c)=>a+c.w,0);
  const scaleFont = (size)=> (scale < 0.92 ? Math.max(8, Math.floor(size * (0.92 + (scale-0.92)*1.4))) : size);

  const headerH = 24, rowPadV = 5, minRowH = 18;

  const ensureSpace = (need=90) => {
    if (y + need > bottomLimit){
      doc.addPage();
      drawBackground();
      y = SAFE_INSET.top;
    }
  };

  fillRect(doc, tableX, y, tableW, headerH, TINTS.headerBG);
  doc.fillColor(BRAND.dark).font(F.medium).fontSize(scaleFont(9));
  {
    let cx = tableX;
    for (const cdef of cols){
      const innerX = cx + 5;
      doc.text(cdef.label, innerX, y + (headerH-10)/2, { width: cdef.w-10, align:'center' });
      strokeRect(doc, cx, y, cdef.w, headerH, GRID, .8);
      cx += cdef.w;
    }
  }
  y += headerH;
  doc.fontSize(scaleFont(9)).fillColor('#111');

  // Filas
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
      const w = cols[i].w - 10;
      const h = doc.heightOfString(cellTexts[i], { width:w, align: cols[i].align||'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);
    ensureSpace(rowH + 8);

    fillRect(doc, tableX, y, tableW, rowH, TINTS.rowBG);
    let tx = tableX;
    for (let i=0;i<cols.length;i++){
      const cdef = cols[i], innerX = tx + 5, innerW = cdef.w - 10;
      strokeRect(doc, tx, y, cdef.w, rowH, GRID, .7);
      doc.fillColor('#111')
         .font(cdef.key==='nombre' ? F.medium : F.body)
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align||'left' });
      tx += cdef.w;
    }
    y += rowH;
  }

  // Totales
  const totalUSD = accUsdCents/100;
  const totalBs  = accBsCents/100;

  ensureSpace(52);
  doc.save().moveTo(tableX, y).lineTo(tableX+tableW, y)
     .strokeColor(GRID).lineWidth(.8).stroke().restore();

  const totalRowH = 24;
  const wUntilCol5 = cols.slice(0,5).reduce((a,c)=>a+c.w,0);
  const wCol6 = cols[5].w, wCol7 = cols[6].w;

  strokeRect(doc, tableX, y, wUntilCol5, totalRowH, GRID, .8);
  doc.font(F.medium).fontSize(scaleFont(9)).fillColor(BRAND.dark)
     .text('Total', tableX, y+5, { width:wUntilCol5, align:'center' });

  fillRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, TINTS.totalBG);
  fillRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, TINTS.totalBG);
  strokeRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, GRID, .8);
  strokeRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, GRID, .8);

  doc.font(F.medium).fillColor(BRAND.dark)
     .text(`$ ${money(totalUSD)}`, tableX + wUntilCol5, y+5, { width:wCol6-6, align:'right' });
  doc.text(`${money(totalBs)} Bs`, tableX + wUntilCol5 + wCol6 + 6, y+5, { width:wCol7-12, align:'left' });

  y += totalRowH + 12;

  /* ===== Textos inferiores ===== */
  const drawH2 = (t)=>{
    ensureSpace(20);
    doc.font(F.medium).fontSize(11).fillColor(BRAND.dark).text(t, xMargin, y);
    doc.font(F.body).fontSize(10).fillColor('#111');
    y = doc.y + 6;
  };

  ensureSpace(18);
  doc.font(F.light).fontSize(9).fillColor('#374151')
     .text('Precios referenciales sujetos a confirmación de stock y condiciones comerciales.', xMargin, y, { width: usableW });
  y = doc.y + 6;

  drawH2('Lugar de entrega');
  const entrega = [
    ensure(company.storeName,'Almacén Central'),
    'Horarios de atención: Lunes a Viernes 08:30–12:30 y 14:30–18:30'
  ];
  for (const line of entrega){ ensureSpace(14); doc.text(line, xMargin, y, { width: usableW }); y = doc.y; }

  const mapsUrl = (company.mapsUrl || process.env.MAPS_URL || MAPS_FALLBACK_URL).trim();
  if (mapsUrl){
    ensureSpace(14);
    doc.fillColor(BRAND.primary).font(F.medium)
       .text('Ver ubicación en Google Maps', xMargin, y, { width: usableW, link: mapsUrl, underline:true });
    doc.fillColor('#111'); y = doc.y + 8;
  }

  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1) Oferta válida por 3 días calendario desde la fecha de emisión y sujeta a disponibilidad.',
    '2) Los precios pueden ajustarse según volumen y condiciones pactadas.',
    '3) Para fijar precio y reservar volumen se requiere confirmación de pago y emisión de factura.',
    '4) La entrega se realiza en almacén; se puede apoyar en la coordinación logística si se requiere.'
  ];
  for (const line of conds){ ensureSpace(14); doc.font(F.body).text(line, xMargin, y, { width: usableW }); y = doc.y; }

  // Fin
  doc.end();
  await new Promise((res,rej)=>{ stream.on('finish',res); stream.on('error',rej); });
  return outPath;
}
