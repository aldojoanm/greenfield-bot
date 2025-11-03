import 'dotenv/config'
import express from 'express'

const app = express()
app.use(express.json({ limit: '5mb' }))

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'VERIFY_123'
const WA_TOKEN = process.env.WHATSAPP_TOKEN || ''
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || ''
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''
const PORT = process.env.PORT || 8080

async function waSendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`
  const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: String(body).slice(0,4096) } }
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return r.ok
}

async function tgSendMessage(text, replyTo) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`
  const payload = { chat_id: TG_CHAT_ID, text, disable_web_page_preview: true, reply_to_message_id: replyTo || undefined }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const j = await r.json().catch(() => null)
  return j?.ok ? j.result : null
}

function digits(s) { return String(s||'').replace(/[^\d]/g,'') }

app.get('/wa/webhook', (req,res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const chall = req.query['hub.challenge']
  if (mode === 'subscribe' && token === VERIFY_TOKEN && chall) return res.status(200).send(String(chall))
  res.sendStatus(403)
})

app.post('/wa/webhook', async (req,res) => {
  try {
    const entry = req.body?.entry?.[0]
    const change = entry?.changes?.[0]
    const value = change?.value
    const msg = value?.messages?.[0]
    if (!msg) { res.sendStatus(200); return }
    const fromRaw = msg.from || value?.contacts?.[0]?.wa_id || ''
    const fromId = digits(fromRaw)
    const name = value?.contacts?.[0]?.profile?.name || ''
    const type = msg.type
    let body = ''
    if (type === 'text') body = msg.text?.body || ''
    else if (type === 'interactive') body = msg?.interactive?.list_reply?.title || msg?.interactive?.button_reply?.title || '[interactivo]'
    else body = `[${type}]`
    const header = `[wa:${fromId}]${name ? ' '+name : ''}`
    const text = `${header}\n${body}`
    await tgSendMessage(text)
    res.sendStatus(200)
  } catch {
    res.sendStatus(200)
  }
})

app.post('/tg/webhook', async (req,res) => {
  try {
    const upd = req.body
    const m = upd?.message
    if (!m) { res.sendStatus(200); return }
    if (String(m.chat?.id) !== String(TG_CHAT_ID)) { res.sendStatus(200); return }
    let target = null
    if (m.reply_to_message?.text && /\[wa:(\d+)\]/.test(m.reply_to_message.text)) target = (m.reply_to_message.text.match(/\[wa:(\d+)\]/)||[])[1]
    if (!target && m.text && /^wa:(\d+)\s+/i.test(m.text)) {
      target = (m.text.match(/^wa:(\d+)\s+/i)||[])[1]
      const rest = m.text.replace(/^wa:\d+\s+/i,'')
      if (target && rest) await waSendText(target, rest)
      res.sendStatus(200); return
    }
    if (!target) { res.sendStatus(200); return }
    const text = m.text || m.caption || ''
    if (text) await waSendText(target, text)
    res.sendStatus(200)
  } catch {
    res.sendStatus(200)
  }
})

app.get('/', (_req,res) => res.type('text').send('OK'))

app.listen(PORT, () => {})
