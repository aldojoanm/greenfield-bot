// telegram-bridge.js
import { Telegraf, Markup } from 'telegraf';

const {
  TG_BOT_TOKEN,
  TG_ADMIN_CHAT_ID,     // debe ser NUMÉRICO, ej -1001234567890
  TG_USE_TOPICS = '1',
  PUBLIC_URL = '',
  AGENT_TOKEN = ''
} = process.env;

let bot = null;
const convMeta = new Map();  // convId -> { name, phone, topicId? }
const tgMsgToConv = new Map();
const queues = new Map();

async function waSendText(convId, text) {
  const url = `${PUBLIC_URL}/wa/agent/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...(AGENT_TOKEN?{Authorization:`Bearer ${AGENT_TOKEN}`}:{}) },
    body: JSON.stringify({ to: convId, text })
  });
  if (!res.ok) throw new Error(`waSendText ${res.status}`);
}
async function waSendMedia(convId, fileUrl, fileName = '', caption = '') {
  const url = `${PUBLIC_URL}/wa/agent/send-media`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...(AGENT_TOKEN?{Authorization:`Bearer ${AGENT_TOKEN}`}:{}) },
    body: JSON.stringify({ to: convId, url: fileUrl, filename: fileName, caption })
  });
  if (!res.ok) throw new Error(`waSendMedia ${res.status}`);
}
async function waSetMode(convId, mode) {
  const url = `${PUBLIC_URL}/wa/agent/handoff`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...(AGENT_TOKEN?{Authorization:`Bearer ${AGENT_TOKEN}`}:{}) },
    body: JSON.stringify({ to: convId, mode })
  });
  if (!res.ok) throw new Error(`waSetMode ${res.status}`);
}
async function waMarkRead(convId) {
  const url = `${PUBLIC_URL}/wa/agent/read`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...(AGENT_TOKEN?{Authorization:`Bearer ${AGENT_TOKEN}`}:{}) },
    body: JSON.stringify({ to: convId })
  });
  if (!res.ok) throw new Error(`waMarkRead ${res.status}`);
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
    try { if (bot) await bot.telegram.sendChatAction(TG_ADMIN_CHAT_ID, 'typing'); } catch {}
    return task();
  }).catch((e) => console.error('[queue]', e));
  queues.set(convId, next);
  return next;
}

async function getOrCreateTopicId(convId, titleFallback = '') {
  if (!bot || TG_USE_TOPICS !== '1') return undefined;
  const meta = convMeta.get(convId);
  if (meta?.topicId) return meta.topicId;
  try {
    const t = await bot.telegram.createForumTopic(
      TG_ADMIN_CHAT_ID,
      titleFallback?.slice(0,128) || `Chat ${convId}`
    );
    const topicId = t?.message_thread_id;
    if (topicId) {
      convMeta.set(convId, { ...(meta || {}), topicId });
      return topicId;
    }
  } catch {}
  return undefined;
}

async function tgSendMessageForConv(convId, text, extra = {}) {
  if (!bot) return;
  const meta = convMeta.get(convId) || {};
  const topicId = await getOrCreateTopicId(convId, meta.name || meta.phone || convId);
  const opts = { parse_mode: 'Markdown', ...extra };
  if (topicId) opts.message_thread_id = topicId;
  const sent = await bot.telegram.sendMessage(TG_ADMIN_CHAT_ID, text, opts);
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
  if (kind === 'photo') sent = await bot.telegram.sendPhoto(TG_ADMIN_CHAT_ID, file, opts);
  else sent = await bot.telegram.sendDocument(TG_ADMIN_CHAT_ID, file, opts);
  tgMsgToConv.set(sent.message_id, convId);
  return sent;
}

/* ===== Export: WA -> TG ===== */
export async function notifyNewTextFromWA({ id, name, phone, text }) {
  if (!bot) return;
  convMeta.set(id, { ...(convMeta.get(id) || {}), name, phone });
  const header = `*${name || 'Contacto'}* · \`${phone || id}\``;
  const body = text?.trim() || '(sin texto)';
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

/* ===== TG -> WA ===== */
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
  if (!TG_BOT_TOKEN || !TG_ADMIN_CHAT_ID || isNaN(Number(TG_ADMIN_CHAT_ID))) {
    console.warn('[TG] Sin credenciales válidas (TG_BOT_TOKEN/TG_ADMIN_CHAT_ID). Bridge desactivado.');
    return;
  }
  bot = new Telegraf(TG_BOT_TOKEN);

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

  bot.command('to', async (ctx) => {
    const txt = ctx.message?.text || '';
    const m = txt.match(/^\/to\s+(\S+)\s+([\s\S]*)/);
    if (!m) return ctx.reply('Uso: /to <conversationId> <mensaje>');
    const [, convId, msg] = m;
    if (!msg.trim()) return ctx.reply('Mensaje vacío');
    await enqueue(convId, async () => { await waSendText(convId, msg.trim()); });
    await ctx.reply('✅ Enviado');
  });

  bot.on('text', async (ctx) => {
    const convId = resolveConvIdFromContext(ctx);
    if (!convId) return;
    const msg = ctx.message?.text?.trim();
    if (!msg) return;
    await enqueue(convId, async () => { await waSendText(convId, msg); });
    try { await ctx.react?.('✅'); } catch {}
  });

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

  await bot.launch();
  console.log('[TG] Bridge activo y escuchando');
}

// Limpieza
process.once('SIGINT',  () => { if (bot) bot.stop('SIGINT'); });
process.once('SIGTERM', () => { if (bot) bot.stop('SIGTERM'); });
