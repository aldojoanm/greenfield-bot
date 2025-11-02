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

// ====== Estado/SSE/Token ======
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
let sse = null;

const elConn   = document.getElementById('conn');
const elList   = document.getElementById('list');
const elMsgs   = document.getElementById('msgs');
const elTitle  = document.getElementById('title');
const elStatus = document.getElementById('status');
const box      = document.getElementById('box');
const app      = document.getElementById('app');

let current = null;
let allConvos = [];
let openLock = false;

const normId = v => String(v ?? '');
const sameId = (a,b)=> normId(a) === normId(b);
const looksLikeMediaLine = (t='')=> /^([🖼️🎬🎧📎])/.test(String(t).trim());

const api = {
  token: '', tokenAt: 0,
  headers(){ return { 'Authorization':'Bearer '+this.token, 'Content-Type':'application/json' }; },
  isExpired(){ return !this.tokenAt || (Date.now() - this.tokenAt) > TOKEN_TTL_MS; },
  async convos(){ const r = await fetch('/wa/agent/convos',{headers:this.headers()}); if(r.status===401){ await forceReauth(); return this.convos(); } if(!r.ok) throw 0; return r.json(); },
  async history(id){ const r = await fetch('/wa/agent/history/'+encodeURIComponent(id),{headers:this.headers()}); if(r.status===401){ await forceReauth(); return this.history(id); } if(!r.ok) throw 0; return r.json(); },
  async send(to,text){ const r = await fetch('/wa/agent/send',{method:'POST',headers:this.headers(),body:JSON.stringify({to,text})}); if(r.status===401){ await forceReauth(); return this.send(to,text); } if(!r.ok) throw 0; return r.json(); },
  async read(to){ const r = await fetch('/wa/agent/read',{method:'POST',headers:this.headers(),body:JSON.stringify({to})}); if(r.status===401){ await forceReauth(); return this.read(to); } if(!r.ok) throw 0; return r.json(); },
  async handoff(to,mode){ const r = await fetch('/wa/agent/handoff',{method:'POST',headers:this.headers(),body:JSON.stringify({to,mode})}); if(r.status===401){ await forceReauth(); return this.handoff(to,mode); } if(!r.ok) throw 0; return r.json(); },
  async sendMedia(to, files, caption=''){
    const fd = new FormData(); fd.append('to', to); fd.append('caption', caption);
    for (const f of files) fd.append('files', f, f.name);
    const r = await fetch('/wa/agent/send-media',{ method:'POST', headers:{ 'Authorization':'Bearer '+this.token }, body: fd });
    if (r.status===401){ await forceReauth(); return this.sendMedia(to, files, caption); }
    if (!r.ok) throw 0; return r.json();
  }
};

function setConn(status, title=''){
  const map = {
    ok:   { text:'Conectado', cls:'' },
    wait: { text:'Conectando…', cls:'' },
    off:  { text:'Sin conexión', cls:'' }
  };
  const m = map[status] || map.off;
  elConn.textContent = m.text + (title?` — ${title}`:'');
}

async function requestToken(force=false){
  if (!force && api.token) return true;
  while (true){
    const t = prompt('Token de agente'); 
    if (!t) { alert('Se requiere token para continuar.'); return false; }
    api.token   = t.trim();
    api.tokenAt = Date.now();
    try{
      setConn('wait');
      const r = await fetch('/wa/agent/convos', { headers: { 'Authorization':'Bearer '+api.token }});
      if (r.status === 401){ alert('Token inválido. Intenta de nuevo.'); api.token=''; continue; }
      if (!r.ok){ alert('No pude validar el token. Reintenta.'); api.token=''; continue; }
      startSSE(); setConn('ok'); return true;
    }catch{ setConn('off'); alert('Error de red validando token. Reintenta.'); api.token=''; }
  }
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
async function forceReauth(){
  try{ if (sse) sse.close(); }catch{}
  api.token = ''; api.tokenAt = 0;
  setConn('off','sesión caducada');
  const ok = await requestToken(true);
  if (ok){ await refresh(true); }
}

// ====== UI ======
function renderList(filter=''){
  elList.innerHTML=''; const q = (filter||'').toLowerCase();
  for(const c0 of (allConvos||[])){
    const c = {...c0, id: normId(c0.id)};
    if(q && !String(c.name||'').toLowerCase().includes(q) && !c.id.includes(q)) continue;

    const row = document.createElement('div');
    const isActive = current && sameId(c.id, current.id);
    row.className = 'item'+(isActive?' active':'' );
    row.onclick = ()=> openChat(c.id);

    const last = String(c.last||'').replace(/\n/g,' · ');
    row.innerHTML = `
      <div>
        <div class="name">${c.name||c.id}</div>
        <div class="sub">${last.slice(0,90)}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        ${c.human?'<span class="pill human">HUMANO</span>':''}
        ${c.unread?`<span class="pill">${c.unread}</span>`:''}
      </div>`;
    elList.appendChild(row);
  }
}
async function refresh(openFirstIfNeeded=false){
  try{
    const {convos} = await api.convos();
    allConvos = (convos||[]).map(c=>({...c,id:normId(c.id)}));
    renderList(document.getElementById('search').value);
    if(openFirstIfNeeded && !current && allConvos.length){
      const last = sessionStorage.getItem('lastChatId');
      const fallback = last && allConvos.find(c=>sameId(c.id,last)) ? last : allConvos[0].id;
      openChat(fallback);
    }
  }catch(e){ /* noop */ }
}
function renderMsgs(mem){
  elMsgs.innerHTML = '';
  for(const m of (mem||[])){
    const div = document.createElement('div');
    let cls='bubble sys';
    if(m.role==='user') cls='bubble u';
    else if(m.role==='bot') cls='bubble b';
    else if(m.role==='agent') cls='bubble a';
    div.className = cls;
    const txt = m.content ?? '';
    if (looksLikeMediaLine(txt)) div.innerHTML = `<strong>${txt.slice(0,2)}</strong> ${txt.slice(2)}`;
    else div.textContent = txt;
    elMsgs.appendChild(div);
  }
  elMsgs.scrollTop = elMsgs.scrollHeight;
}
async function openChat(id){
  if(openLock) return; openLock = true;
  try{
    const res = await api.history(normId(id));
    current = {...res, id:normId(res.id)};
    elTitle.textContent = `${current.name||current.id} (${current.id})`;
    elStatus.style.display = current.human ? 'inline-block' : 'none';
    elStatus.textContent = current.human ? 'HUMANO' : '';
    renderMsgs(current.memory||[]);
    sessionStorage.setItem('lastChatId', current.id);
    api.read(current.id).catch(()=>{});
    refresh(false);
    if (window.innerWidth<900) app.classList.remove('show-left');
  }catch(e){
    elTitle.textContent = normId(id);
    elStatus.style.display='none';
  }finally{ openLock = false; }
}

// ====== Acciones ======
document.getElementById('importWA').onclick = async ()=>{
  try{
    const r = await fetch('/wa/agent/import-whatsapp', {
      method: 'POST',
      headers: api.headers(),
      body: JSON.stringify({ days: 3650 })
    });
    if (r.status === 401){ await forceReauth(); return document.getElementById('importWA').click(); }
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || 'Error');
    alert(`Listo. Importados ${j.imported} chats.`);
    await refresh(true);
    if (window.innerWidth < 900) { app.classList.add('show-left'); }
  }catch{ alert('No se pudo importar desde Sheets.'); }
};

document.getElementById('send').onclick = async ()=>{
  const txt = box.value.trim(); if(!txt || !current) return;
  box.value=''; await api.send(current.id, txt);
};
box.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('send').click(); }
});
document.getElementById('markRead').onclick  = async ()=>{ if(!current) return; await api.read(current.id); refresh(false); };
document.getElementById('takeHuman').onclick = async ()=>{ if(!current) return; await api.handoff(current.id,'human'); elStatus.style.display='inline-block'; elStatus.textContent='HUMANO'; };
document.getElementById('resumeBot').onclick = async ()=>{ if(!current) return; await api.handoff(current.id,'bot'); elStatus.style.display='none'; };

document.getElementById('refresh').onclick = ()=>refresh(true);
document.getElementById('logout').onclick  = ()=>{ try{ if (sse) sse.close(); }catch{} api.token=''; api.tokenAt=0; location.reload(); };
document.getElementById('search').oninput  = (e)=> renderList(e.target.value);
document.getElementById('toggleLeft').onclick = ()=> app.classList.toggle('show-left');

// ====== Archivos (input + drag&drop) ======
const fileInput = document.getElementById('fileInput');
fileInput.onchange = async (e)=>{
  const files = Array.from(e.target.files||[]);
  if(!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); }
  catch{ alert('Error subiendo archivo(s).'); }
  e.target.value = '';
};

const dropZone = document.getElementById('dropZone');
['dragenter','dragover'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev=> dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', async (e)=>{
  const files = Array.from(e.dataTransfer?.files||[]);
  if (!files.length || !current) return;
  try{ await api.sendMedia(current.id, files, ''); } catch{ alert('Error subiendo archivo(s).'); }
});

// ====== Mensajes predefinidos ======
function buildRequestMessages(){
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
  return { part1, part2 };
}
document.getElementById('requestInfo').onclick = async ()=>{
  if(!current) return;
  const { part1, part2 } = buildRequestMessages();
  await api.send(current.id, part1);
  await api.send(current.id, part2);
};

// QR
document.getElementById('sendQR').onclick = async ()=>{
  if(!current) return;
  const QR_URLS = [BRAND_QR, '/public/qr-pagos.png'];
  let blob = null, mime = 'image/png';
  for (const u of QR_URLS){
    try{ const r = await fetch(u); if (r.ok){ blob = await r.blob(); mime = blob.type || mime; break; } }catch{}
  }
  if(!blob){ alert('No encontré el archivo QR.'); return; }
  const file = new File([blob], 'qr-pagos.png', { type: mime });
  await api.sendMedia(current.id, [file], '');
};

// Cuentas
document.getElementById('sendAccounts').onclick = async ()=>{
  if(!current) return;
  await api.send(current.id, ACCOUNTS_TEXT);
};

// ====== Bootstrap ======
(async function bootstrap(){
  const ok = await requestToken(true);
  if (!ok) return;
  await refresh(true);
  setInterval(()=>{ if (api.isExpired()) forceReauth(); }, 60*1000);
})();

// ====== PWA: registrar SW & botón “Instalar” ======
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/public/sw.js').catch(()=>{});
  });
}

// Banner de instalación (Add to Home Screen)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;

  // botón flotante
  const btn = document.createElement('button');
  btn.textContent = 'Instalar';
  btn.className = 'btn sm';
  btn.style.position = 'fixed';
  btn.style.right = '12px';
  btn.style.bottom = '12px';
  btn.style.zIndex = '9999';
  document.body.appendChild(btn);

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } finally {
      btn.remove();
      deferredPrompt = null;
    }
  };
});

// Estado online/offline (backup visual)
window.addEventListener('offline', ()=> { try{ setConn('off', 'sin red'); }catch{} });
window.addEventListener('online',  ()=> { try{ setConn('wait', 'reconectando'); startSSE(); }catch{} });
