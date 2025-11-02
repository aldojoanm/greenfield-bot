// ====== Config de marca ======
const BRAND_NAME = document.querySelector('meta[name="brand:name"]')?.content?.trim() || 'Greenfield Agroquímicos';
const BRAND_QR   = document.querySelector('meta[name="brand:qr"]')?.content?.trim()   || '/qr-pagos.png';

// Cuentas (edítalas si hace falta)
const ACCOUNTS_TEXT = [
  `*Titular:* ${BRAND_NAME}`,
  '*Moneda:* Bolivianos',
  '',
  '*BCP*',
  '*Cuenta Corriente:* 701-5096500-3-34',
  '',
  '*BANCO UNIÓN*',
  '*Cuenta Corriente:* 10000047057563',
  '',
  '*BANCO SOL*',
  '*Cuenta Corriente:* 2784368-000-001'
].join('\n');

// ====== Elementos ======
const viewList   = document.getElementById('view-list');
const viewChat   = document.getElementById('view-chat');
const threadList = document.getElementById('threadList');
const msgCount   = document.getElementById('msgCount');
const elConn     = document.getElementById('conn');
const statusPill = document.getElementById('status');
const backBtn    = document.getElementById('backBtn');
const chatName   = document.getElementById('chatName');
const chatMeta   = document.getElementById('chatMeta');
const msgsEl     = document.getElementById('msgs');

const moreBtn    = document.getElementById('moreBtn');
const sheet      = document.getElementById('sheet');
const attachBtn  = document.getElementById('attachBtn');
const fileInput  = document.getElementById('fileInput');
const dropZone   = document.getElementById('dropZone');
const box        = document.getElementById('box');
const sendBtn    = document.getElementById('send');

const refreshBtn = document.getElementById('refresh');
const importBtn  = document.getElementById('importWA');
const logoutBtn  = document.getElementById('logout');
const searchEl   = document.getElementById('search');

const segBtns    = Array.from(document.querySelectorAll('.segmented .seg'));

// ====== Estado ======
let current = null;
let allConvos = [];
let sse = null;
let filter = 'all';

// ====== Util ======
const normId = v => String(v ?? '');
const sameId = (a,b)=> normId(a) === normId(b);
const looksLikeMediaLine = (t='')=> /^([🖼️🎬🎧📎])/.test(String(t).trim());
const timeAgo = (ts)=> {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diff = Math.max(1, Math.floor((Date.now()-d)/1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  return `${Math.floor(diff/86400)}d`;
};

// ====== Token 1 día / por dispositivo ======
const TOKEN_TTL_MS = 24*60*60*1000;
const LS_TOKEN   = 'agent.token';
const LS_TOKENAT = 'agent.tokenAt';
const LS_DEVID   = 'agent.deviceId';

function deviceId(){
  let id = localStorage.getItem(LS_DEVID);
  if (!id){
    id = (crypto?.randomUUID?.() || (Date.now()+'-'+Math.random())).toString();
    localStorage.setItem(LS_DEVID, id);
  }
  return id;
}
const api = {
  token: localStorage.getItem(LS_TOKEN) || '',
  tokenAt: Number(localStorage.getItem(LS_TOKENAT) || 0),
  headers(){
    return { 'Authorization':'Bearer '+this.token, 'Content-Type':'application/json', 'X-Device': deviceId() };
  },
  isExpired(){
    return !this.tokenAt || (Date.now() - this.tokenAt) > TOKEN_TTL_MS;
  },
  persist(newToken){
    this.token = newToken;
    this.tokenAt = Date.now();
    localStorage.setItem(LS_TOKEN, this.token);
    localStorage.setItem(LS_TOKENAT, String(this.tokenAt));
  },
  clear(){
    this.token=''; this.tokenAt=0;
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_TOKENAT);
  },
  async convos(){
    const r = await fetch('/wa/agent/convos',{headers:this.headers()});
    if (r.status===401){ await forceReauth(); return this.convos(); }
    if (!r.ok) throw 0; return r.json();
  },
  async history(id){
    const r = await fetch('/wa/agent/history/'+encodeURIComponent(id),{headers:this.headers()});
    if (r.status===401){ await forceReauth(); return this.history(id); }
    if (!r.ok) throw 0; return r.json();
  },
  async send(to,text){
    const r = await fetch('/wa/agent/send',{method:'POST',headers:this.headers(),body:JSON.stringify({to,text})});
    if (r.status===401){ await forceReauth(); return this.send(to,text); }
    if (!r.ok) throw 0; return r.json();
  },
  async read(to){
    const r = await fetch('/wa/agent/read',{method:'POST',headers:this.headers(),body:JSON.stringify({to})});
    if (r.status===401){ await forceReauth(); return this.read(to); }
    if (!r.ok) throw 0; return r.json();
  },
  async handoff(to,mode){
    const r = await fetch('/wa/agent/handoff',{method:'POST',headers:this.headers(),body:JSON.stringify({to,mode})});
    if (r.status===401){ await forceReauth(); return this.handoff(to,mode); }
    if (!r.ok) throw 0; return r.json();
  },
  async sendMedia(to, files, caption=''){
    const fd = new FormData(); fd.append('to', to); fd.append('caption', caption);
    for (const f of files) fd.append('files', f, f.name);
    const r = await fetch('/wa/agent/send-media', { method:'POST', headers:{ 'Authorization':'Bearer '+this.token, 'X-Device': deviceId() }, body: fd });
    if (r.status===401){ await forceReauth(); return this.sendMedia(to, files, caption); }
    if (!r.ok) throw 0; return r.json();
  }
};

function setConn(status, title=''){
  const map = { ok:'Conectado', wait:'Conectando…', off:'Sin conexión' };
  elConn.textContent = (map[status]||'') + (title?` — ${title}`:'');
}

async function requestToken(force=false){
  if (!force && api.token && !api.isExpired()) return true;
  while (true){
    const t = prompt('Token de agente (vigencia 24h en este dispositivo)'); 
    if (!t) { alert('Se requiere token para continuar.'); return false; }
    api.persist(t.trim());
    try{
      setConn('wait');
      const r = await fetch('/wa/agent/convos', { headers: api.headers() });
      if (r.status === 401){ alert('Token inválido. Intenta de nuevo.'); api.clear(); continue; }
      if (!r.ok){ alert('No pude validar el token. Reintenta.'); api.clear(); continue; }
      startSSE(); setConn('ok'); return true;
    }catch{ setConn('off'); alert('Error de red validando token. Reintenta.'); api.clear(); }
  }
}
async function forceReauth(){
  try{ if (sse) sse.close(); }catch{}
  api.clear();
  setConn('off','sesión caducada');
  const ok = await requestToken(true);
  if (ok){ await refresh(true); }
}
function startSSE(){
  try{ if (sse) sse.close(); }catch{}
  if (!api.token) return;
  sse = new EventSource('/wa/agent/stream?token=' + encodeURIComponent(api.token));
  setConn('ok');
  sse.addEventListener('ping', ()=> setConn('ok'));
  sse.addEventListener('msg', (ev)=>{
    const data = JSON.parse(ev.data||'{}');
    const msgId = normId(data.id);
    if(current && sameId(msgId,current.id)){
      current.memory = (current.memory||[]).concat([{role:data.role, content:data.content, ts:data.ts}]);
      renderMsgs(current.memory);
    }
    refresh(false);
  });
  sse.onerror = ()=> setConn('off');
}

// ====== Lista estilo Messenger ======
function lastFromMemory(mem=[]){
  if (!mem.length) return null;
  return mem[mem.length-1];
}
function statusDot(c){
  // prioridad: no leído -> azul; finalizado -> gris; modo asesor -> verde
  if (c.unread) return 'unread';
  if (c.done || c.finalizado) return 'done';
  if (c.human) return 'agent';
  return 'done';
}
function initial(name='?'){ return name.trim()[0]?.toUpperCase?.() || '?'; }

function renderThreads(){
  threadList.innerHTML = '';
  const q = (searchEl.value||'').toLowerCase();
  let rows = allConvos;

  // Filtros
  if (filter==='done') rows = rows.filter(c => c.done || c.finalizado);
  if (filter==='pending') rows = rows.filter(c => !c.done && !c.finalizado);
  if (filter==='agent') rows = rows.filter(c => c.human);

  // Búsqueda
  rows = rows.filter(c => (c.name||'').toLowerCase().includes(q) || String(c.id||'').includes(q));

  msgCount.textContent = `Mensajes (${rows.length})`;

  for (const c0 of rows){
    const c = {...c0, id: normId(c0.id)};
    const lastMem = c.memory && c.memory.length ? lastFromMemory(c.memory) : null;
    // Texto de la segunda línea
    let lastTxt = String(c.last || lastMem?.content || '').replace(/\n/g,' ');
    const lastRole = lastMem?.role;
    const prefix = lastRole==='bot' || lastRole==='agent' ? 'You: ' : (c.name ? `${c.name}: ` : '');
    if (lastTxt) lastTxt = (prefix + lastTxt).slice(0,120);

    // tiempo
    const ts = c.ts || lastMem?.ts;
    const when = ts ? timeAgo(ts) : '';

    // dot
    const dot = statusDot(c);

    // avatar
    const avatar = c.avatar ? `<img src="${c.avatar}" alt="">` : `<span>${initial(c.name||c.id)}</span>`;

    const row = document.createElement('div');
    row.className = 'thread';
    row.innerHTML = `
      <div class="avatar">${avatar}</div>
      <div class="t-main">
        <div class="t-row1">
          <div class="t-name">${c.name || c.id}</div>
          <div class="t-time">${when}</div>
        </div>
        <div class="t-row2">
          <div class="t-last">${lastTxt || ''}</div>
        </div>
      </div>
      <div class="dot ${dot}" title="${dot}"></div>
    `;
    row.onclick = ()=> openChat(c.id);
    threadList.appendChild(row);
  }
}

// ====== Chat ======
function renderMsgs(mem){
  msgsEl.innerHTML = '';
  for (const m of (mem||[])){
    const div = document.createElement('div');
    let cls = 'bubble sys';
    if (m.role==='user') cls = 'bubble user';
    else if (m.role==='bot') cls = 'bubble bot';
    else if (m.role==='agent') cls = 'bubble agent';

    div.className = cls;
    const txt = m.content ?? '';
    if (looksLikeMediaLine(txt)) div.innerHTML = `<strong>${txt.slice(0,2)}</strong> ${txt.slice(2)}`;
    else div.textContent = txt;
    msgsEl.appendChild(div);
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function openChat(id){
  try{
    const res = await api.history(normId(id));
    current = {...res, id:normId(res.id)};
    chatName.textContent = current.name || current.id;
    chatMeta.textContent = current.phone ? current.phone : current.id;
    statusPill.style.display = current.human ? 'inline-block' : 'none';
    renderMsgs(current.memory||[]);
    await api.read(current.id).catch(()=>{});
    // Navega a vista chat
    viewList.classList.remove('active');
    viewChat.classList.add('active');
  }catch(e){
    alert('No pude abrir el chat.');
  }
}
backBtn.onclick = ()=>{
  current = null;
  viewChat.classList.remove('active');
  viewList.classList.add('active');
};

// ====== Acciones ======
document.getElementById('requestInfo').onclick = async ()=>{
  if (!current) return;
  const nombre = (current && current.name) ? current.name.trim() : 'cliente';
  const part1 = [
    `${nombre}, ¡gracias por su compra y confianza en ${BRAND_NAME}! 😊`,
    `Para *emitir su factura* y coordinar la fecha de entrega, por favor responda a este mensaje con los siguientes datos.`,
    `Te recordamos que la facturación debe emitirse al mismo nombre de la persona que realizó el pago.`,
    `¡Quedamos atentos y a su disposición para cualquier consulta!`
  ].join('\n');
  const part2 = [
    `*FACTURACIÓN*`,
    `• Razón social:`,
    `• NIT:`,
    ``,
    `*ORDEN DE ENTREGA*`,
    `• Nombre del cliente: ${nombre}`,
    `• Nombre del chofer:`,
    `• Carnet de Identidad:`,
    `• Placa del vehículo:`,
    `• Fecha de recojo (dd/mm/aaaa):`
  ].join('\n');
  await api.send(current.id, part1);
  await api.send(current.id, part2);
  closeSheet();
};

document.getElementById('sendQR').onclick = async ()=>{
  if (!current) return;
  const QR_URLS = [BRAND_QR, '/public/qr-pagos.png'];
  let blob = null, mime = 'image/png';
  for (const u of QR_URLS){
    try{ const r = await fetch(u); if (r.ok){ blob = await r.blob(); mime = blob.type || mime; break; } }catch{}
  }
  if (!blob){ alert('No encontré el archivo QR.'); return; }
  const file = new File([blob], 'qr-pagos.png', { type: mime });
  await api.sendMedia(current.id, [file], '');
  closeSheet();
};
document.getElementById('sendAccounts').onclick = async ()=>{
  if (!current) return;
  await api.send(current.id, ACCOUNTS_TEXT);
  closeSheet();
};
document.getElementById('markRead').onclick  = async ()=>{ if(!current) return; await api.read(current.id); closeSheet(); refresh(false); };
document.getElementById('takeHuman').onclick = async ()=>{ if(!current) return; await api.handoff(current.id,'human'); statusPill.style.display='inline-block'; closeSheet(); };
document.getElementById('resumeBot').onclick = async ()=>{ if(!current) return; await api.handoff(current.id,'bot'); statusPill.style.display='none'; closeSheet(); };

// Envío texto
sendBtn.onclick = async ()=>{
  const txt = box.value.trim(); if(!txt || !current) return;
  box.value=''; await api.send(current.id, txt);
};
box.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendBtn.click(); }
});

// Adjuntar
attachBtn.onclick = ()=> fileInput.click();
fileInput.onchange = async (e)=>{
  const files = Array.from(e.target.files||[]);
  if(!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); }
  catch{ alert('Error subiendo archivo(s).'); }
  e.target.value = '';
};

// Drag & drop
['dragenter','dragover'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', async (e)=>{
  const files = Array.from(e.dataTransfer?.files||[]);
  if (!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); } catch{ alert('Error subiendo archivo(s).'); }
});

// Sheet (+)
const closeSheet = ()=> sheet.classList.remove('show');
moreBtn.onclick = ()=>{
  if (sheet.classList.contains('show')) closeSheet();
  else sheet.classList.add('show');
};
document.getElementById('closeSheet').onclick = closeSheet;

// ====== Lista + filtros ======
function renderList(){
  renderThreads();
}
searchEl.oninput = renderList;
segBtns.forEach(b=>{
  b.onclick = ()=>{
    segBtns.forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    filter = b.dataset.filter;
    renderList();
  };
});

// ====== Datos / refresh ======
async function refresh(openFirstIfNeeded=false){
  try{
    const {convos} = await api.convos();
    // Normaliza y conserva último mensaje en memoria para “You:/Nombre:”
    allConvos = (convos||[]).map(c=>({...c, id:normId(c.id)}));
    renderList();
    if (openFirstIfNeeded && !current && allConvos.length){
      // Nada autoabierto: quedamos en lista (estilo Messenger)
    }
  }catch(e){ /* noop */ }
}

// ====== Bootstrap ======
(async function bootstrap(){
  const ok = await requestToken(false);
  if (!ok) return;
  await refresh(true);
  // renovar si expira
  setInterval(()=>{ if (api.isExpired()) forceReauth(); }, 60*1000);
  // SSE
  startSSE();
})();

// ====== PWA ======
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/public/sw.js').catch(()=>{});
  });
}
// A2HS botón flotante (opcional)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.createElement('button');
  btn.textContent = 'Instalar';
  btn.className = 'btn';
  Object.assign(btn.style, {position:'fixed',right:'12px',bottom:'12px',zIndex:'9999'});
  document.body.appendChild(btn);
  btn.onclick = async () => {
    btn.disabled = true;
    try{
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    }finally{
      btn.remove(); deferredPrompt = null;
    }
  };
});

// Estado online/offline
window.addEventListener('offline', ()=> { try{ setConn('off', 'sin red'); }catch{} });
window.addEventListener('online',  ()=> { try{ setConn('wait', 'reconectando'); startSSE(); }catch{} });
