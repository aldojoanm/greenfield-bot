// telegram-bridge.js
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';

const {
  TG_BOT_TOKEN,
  TG_ADMIN_CHAT_ID,       // *NUMÉRICO*, no username
  TG_USE_TOPICS = '1',    // "1" usa topics si el supergrupo los tiene
  PUBLIC_URL = '',
  AGENT_TOKEN = ''
} = process.env;

if (!TG_BOT_TOKEN) throw new Error('Falta TG_BOT_TOKEN');
if (!TG_ADMIN_CHAT_ID) throw new Error('Falta TG_ADMIN_CHAT_ID');

const bot = new Telegraf(TG_BOT_TOKEN);

// ===== Estado =====
/** convId -> { name, phone, topicId? } */
const convMeta = new Map();
/** adminMsgId -> convId */
const tgMsgToConv = new Map();
/** convId -> cola de promesas */
const queues = new Map();

// ===== Helpers =====
function keyForHeaders() {
  const h = {};
  if (AGENT_TOKEN) h['Authorization'] = `Bearer ${AGENT_TOKEN}`;
  return { headers: h };
}
async function waSendText(convId, text) {
  await axios.post(`${PUBLIC_URL}/wa/agent/send`, { to: convId, text }, keyForHeaders());
}
async function waSendMedia(convId, fileUrl, fileName = '', caption = '') {
  await axios.post(`${PUBLIC_URL}/wa/agent/send-media`,
    { to: convId, url: fileUrl, filename: fileName, caption },
    keyForHeaders()
  );
}
async function waSetMode(convId, mode) {
  await axios.post(`${PUBLIC_URL}/wa/agent/handoff`, { to: convId, mode }, keyForHeaders());
}
async function waMarkRead(convId) {
  await axios.post(`${PUBLIC_URL}/wa/agent/read`, { to: convId }, keyForHeaders());
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
    try { await bot.telegram.sendChatAction(TG_ADMIN_CHAT_ID, 'typing'); } catch {}
    return task();
  }).catch((e) => console.error('[queue]', e?.response?.data || e));
  queues.set(convId, next);
  return next;
}

// ===== Topics (opcional) =====
async function getOrCreateTopicId(convId, titleFallback = '') {
  if (TG_USE_TOPICS !== '1') return undefined;
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
  const meta = convMeta.get(convId) || {};
  const topicId = await getOrCreateTopicId(convId, meta.name || meta.phone || convId);
  const opts = { parse_mode: 'Markdown', ...extra };
  if (topicId) opts.message_thread_id = topicId;
  const sent = await bot.telegram.sendMessage(TG_ADMIN_CHAT_ID, text, opts);
  tgMsgToConv.set(sent.message_id, convId);
  return sent;
}

async function tgSendMediaForConv(convId, kind, file, extra = {}) {
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

// ===== Export: WA -> TG (llámalas desde tu webhook o desde server.js opcional) =====
export async function notifyNewTextFromWA({ id, name, phone, text }) {
  convMeta.set(id, { ...(convMeta.get(id) || {}), name, phone });
  const header = `*${name || 'Contacto'}* · \`${phone || id}\``;
  const body = text?.trim() || '(sin texto)';
  return enqueue(id, async () => {
    await tgSendMessageForConv(
      id,
      `📩 _Nuevo mensaje_\n${header}\n\n${body}`,
      actionKeyboard(id)
    );
  });
}
export async function notifyNewMediaFromWA({ id, name, phone, caption = '(archivo)', mediaUrl, mime = '', filename = '' }) {
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

// ===== TG -> WA (acciones y respuestas) =====
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery?.data || '';
    const [cmd, convId] = data.split(':');
    if (!convId) return ctx.answerCbQuery('Falta id');
    if (cmd === 'pause') {
      await waSetMode(convId, 'human');
      await ctx.answerCbQuery('Bot pausado');
    } else if (cmd === 'resume') {
      await waSetMode(convId, 'bot');
      await ctx.answerCbQuery('Bot ON');
    } else if (cmd === 'read') {
      await waMarkRead(convId);
      await ctx.answerCbQuery('Marcado leído');
    } else {
      await ctx.answerCbQuery('Acción no válida');
    }
  } catch (e) {
    console.error('callback error', e?.response?.data || e);
    await ctx.answerCbQuery('Error');
  }
});

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

// ===== Arranque =====
export async function startTelegramBridge() {
  await bot.launch();
  console.log('[TG] Bridge activo y escuchando');
}

// Limpieza
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
