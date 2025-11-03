// telegram-bridge.js
import { Telegraf, Markup } from 'telegraf';

const {
  TG_BOT_TOKEN,
  TG_ADMIN_CHAT_ID,     // numérico: 1220063102 o -100xxxxxxxxxx
  TG_USE_TOPICS = '1',
  PUBLIC_URL = '',
  AGENT_TOKEN = ''
} = process.env;

let bot = null;

// Estado
/** convId -> { name, phone, topicId? } */
const convMeta = new Map();
/** adminMsgId -> convId */
const tgMsgToConv = new Map();
/** convId -> Promise cola */
const queues = new Map();

// ───────────────── helpers HTTP hacia tu API ─────────────────
async function waFetch(path, payload) {
  const url = `${PUBLIC_URL}${path}`;
  const headers = { 'Content-Type':'application/json' };
  if (AGENT_TOKEN) headers.Authorization = `Bearer ${AGENT_TOKEN}`;
  const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
}

async function waSendText(convId, text) {
  return waFetch('/wa/agent/send', { to: convId, text });
}
async function waSendMedia(convId, fileUrl, fileName = '', caption = '') {
  return waFetch('/wa/agent/send-media', { to: convId, url: fileUrl, filename: fileName, caption });
}
async function waSetMode(convId, mode) {
  return waFetch('/wa/agent/handoff', { to: convId, mode });
}
async function waMarkRead(convId) {
  return waFetch('/wa/agent/read', { to: convId });
}

function actionKeyboard(convId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⏸️ Pausar', `pause:${convId}`),
     Markup.button.callback('▶️ Bot ON', `resume:${convId}`)],
    [Markup.button.callback('✓ Leído', `read:${convId}`)]
  ]);
}

function ensureQueue(convId) {
  if (!queues.has(convId)) queues.set(convId, Promise.resolve());
  return queues.get(convId);
}
function enqueue(convId, task) {
  const prev = ensureQueue(convId);
  const next = prev.then(async () => {
    try { if (bot) await bot.telegram.sendChatAction(Number(TG_ADMIN_CHAT_ID), 'typing'); } catch {}
    return task();
  }).catch((e) => console.error('[queue]', e));
  queues.set(convId, next);
  return next;
}

// ───────────────── topics (opcional) ─────────────────
async function getOrCreateTopicId(convId, titleFallback = '') {
  if (!bot || TG_USE_TOPICS !== '1') return undefined;
  const meta = convMeta.get(convId);
  if (meta?.topicId) return meta.topicId;
  try {
    const t = await bot.telegram.createForumTopic(
      Number(TG_ADMIN_CHAT_ID),
      titleFallback?.slice(0,128) || `Chat ${convId}`
    );
    const topicId = t?.message_thread_id;
    if (topicId) {
      convMeta.set(convId, { ...(meta || {}), topicId });
      return topicId;
    }
  } catch (e) {
    console.warn('[TG] No pude crear topic:', e?.description || e?.message || e);
  }
  return undefined;
}

async function tgSendMessageForConv(convId, text, extra = {}) {
  if (!bot) return;
  const meta = convMeta.get(convId) || {};
  const topicId = await getOrCreateTopicId(convId, meta.name || meta.phone || convId);
  const opts = { parse_mode: 'Markdown', ...extra };
  if (topicId) opts.message_thread_id = topicId;
  const sent = await bot.telegram.sendMessage(Number(TG_ADMIN_CHAT_ID), text, opts);
  tgMsgToConv.set(sent.message_id, convId);
  return sent;
}

async function tgSendMediaForConv(convId, kind, file, extra = {}) {
  if (!bot) return;
  const meta = convMeta.get(convId) || {};
  const topicId = await getOrCreateTopicId(convId, meta.name || meta.phone || convId);
  const opts = { ...extra };
  if (topicId) opts.message_thread_id = topicId;
  let sent;
  if (kind === 'photo') sent = await bot.telegram.sendPhoto(Number(TG_ADMIN_CHAT_ID), file, opts);
  else sent = await bot.telegram.sendDocument(Number(TG_ADMIN_CHAT_ID), file, opts);
  tgMsgToConv.set(sent.message_id, convId);
  return sent;
}

// ─────────────── Export: WA -> TG (avisos entrantes) ───────────────
export async function notifyNewTextFromWA({ id, name, phone, text }) {
  if (!bot) return;
  convMeta.set(id, { ...(convMeta.get(id) || {}), name, phone });
  const header = `*${name || 'Contacto'}* · \`${phone || id}\``;
  const body = (text || '').trim() || '(sin texto)';
  return enqueue(id, async () => {
    await tgSendMessageForConv(id, `📩 _Nuevo mensaje_\n${header}\n\n${body}`, actionKeyboard(id));
  });
}
export async function notifyNewMediaFromWA({ id, name, phone, caption = '(archivo)', mediaUrl, mime = '', filename = '' }) {
  if (!bot) return;
  convMeta.set(id, { ...(convMeta.get(id) || {}), name, phone });
  const header = `*${name || 'Contacto'}* · \`${phone || id}\``;
  return enqueue(id, async () => {
    const isPhoto = (mime || '').startsWith('image/') && !(mime || '').includes('svg');
    const extra = { caption: `📎 ${header}\n${caption}` };
    if (isPhoto) {
      await tgSendMediaForConv(id, 'photo', { url: mediaUrl }, extra);
    } else {
      await tgSendMediaForConv(id, 'doc', { url: mediaUrl, filename: filename || 'archivo' }, extra);
    }
  });
}

// ─────────────── TG -> WA (responder) ───────────────
function resolveConvIdFromContext(ctx) {
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo?.message_id && tgMsgToConv.has(replyTo.message_id)) {
    return tgMsgToConv.get(replyTo.message_id);
  }
  const topicId = ctx.message?.message_thread_id;
  if (topicId) {
    for (const [cid, meta] of convMeta.entries()) {
      if (meta.topicId === topicId) return cid;
    }
  }
  const txt = ctx.message?.text || '';
  const m = txt.match(/^\/to\s+(\S+)\s+/);
  if (m) return m[1];
  return null;
}

export async function startTelegramBridge() {
  // Validación
  if (!TG_BOT_TOKEN) { console.warn('[TG] Falta TG_BOT_TOKEN'); return; }
  if (!TG_ADMIN_CHAT_ID || isNaN(Number(TG_ADMIN_CHAT_ID))) {
    console.warn('[TG] TG_ADMIN_CHAT_ID debe ser numérico'); return;
  }
  if (!PUBLIC_URL) {
    console.warn('[TG] PUBLIC_URL vacío (el bridge no podrá llamar a /wa/agent/*)');
  }

  bot = new Telegraf(TG_BOT_TOKEN);

  // Logs mínimos para debug
  bot.use(async (ctx, next) => {
    try {
      // console.log('[TG] update', ctx.update?.update_id, ctx.update?.message?.text || ctx.update?.callback_query?.data);
      await next();
    } catch (e) {
      console.error('[TG] middleware error', e);
    }
  });

  bot.catch((err, ctx) => {
    console.error('[TG] error', err?.message || err, 'ctx:', ctx?.updateType);
  });

  // Heartbeat para probar rápido
  bot.start(async (ctx) => {
    await ctx.reply('✅ Bot vivo.\n• /ping\n• /id (te devuelve el chat id)\n• Responde (reply) a un mensaje reenviado desde la bandeja para contestar al cliente.\n• /to <conversationId> <mensaje>');
  });
  bot.command('ping', async (ctx) => { await ctx.reply('pong'); });
  bot.command('id', async (ctx) => {
    const chat = ctx.chat || {};
    await ctx.reply(`Chat ID: \`${chat.id}\``, { parse_mode: 'Markdown' });
  });

  // Acciones inline
  bot.on('callback_query', async (ctx) => {
    try {
      const data = ctx.callbackQuery?.data || '';
      const [cmd, convId] = data.split(':');
      if (!convId) return ctx.answerCbQuery('Falta id');
      if (cmd === 'pause')       { await waSetMode(convId, 'human'); await ctx.answerCbQuery('Bot pausado'); }
      else if (cmd === 'resume') { await waSetMode(convId, 'bot');   await ctx.answerCbQuery('Bot ON'); }
      else if (cmd === 'read')   { await waMarkRead(convId);         await ctx.answerCbQuery('Marcado leído'); }
      else { await ctx.answerCbQuery('Acción no válida'); }
    } catch (e) {
      console.error('callback error', e);
      try { await ctx.answerCbQuery('Error'); } catch {}
    }
  });

  // Comando /to
  bot.command('to', async (ctx) => {
    const txt = ctx.message?.text || '';
    const m = txt.match(/^\/to\s+(\S+)\s+([\s\S]*)/);
    if (!m) return ctx.reply('Uso: /to <conversationId> <mensaje>');
    const [, convId, msg] = m;
    if (!msg.trim()) return ctx.reply('Mensaje vacío');
    await enqueue(convId, async () => { await waSendText(convId, msg.trim()); });
    await ctx.reply('✅ Enviado');
  });

  // Texto directo (requiere reply a un mensaje del bot o topic asociado)
  bot.on('text', async (ctx) => {
    const convId = resolveConvIdFromContext(ctx);
    if (!convId) return; // ignora textos que no se puedan resolver
    const msg = ctx.message?.text?.trim();
    if (!msg) return;
    await enqueue(convId, async () => { await waSendText(convId, msg); });
    try { await ctx.react?.('✅'); } catch {}
  });

  // Foto / Documento
  bot.on('photo', async (ctx) => {
    const convId = resolveConvIdFromContext(ctx);
    if (!convId) return;
    const sizes = ctx.message.photo || [];
    const best = sizes[sizes.length - 1];
    const fileId = best?.file_id;
    if (!fileId) return;
    const link = await ctx.telegram.getFileLink(fileId);
    const caption = ctx.message.caption || '';
    await enqueue(convId, async () => { await waSendMedia(convId, String(link), '', caption); });
    try { await ctx.react?.('📎'); } catch {}
  });

  bot.on('document', async (ctx) => {
    const convId = resolveConvIdFromContext(ctx);
    if (!convId) return;
    const doc = ctx.message.document;
    if (!doc?.file_id) return;
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const caption = ctx.message.caption || doc.file_name || 'documento';
    await enqueue(convId, async () => { await waSendMedia(convId, String(link), doc.file_name, caption); });
    try { await ctx.react?.('📎'); } catch {}
  });

  // IMPORTANTÍSIMO: asegúrate de usar polling (borra webhook si alguna vez lo configuraste)
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  } catch (e) {
    console.warn('[TG] deleteWebhook warning:', e?.description || e?.message || e);
  }

  await bot.launch();
  console.log('[TG] Bridge activo y escuchando');
}

// Limpieza
process.once('SIGINT',  () => { if (bot) bot.stop('SIGINT'); });
process.once('SIGTERM', () => { if (bot) bot.stop('SIGTERM'); });

