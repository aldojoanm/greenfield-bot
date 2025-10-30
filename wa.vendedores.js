import express from "express";
import advisorRouter from "./wa.js";
import sheetsRouter from "./wa.sheets.js";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_123";
const WA_TOKEN     = process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_ID || "";
const DEBUG        = process.env.DEBUG_LOGS === "1";
const dbg = (...a) => { if (DEBUG) console.log("[HUB]", ...a); };
const CATALOG_URL = process.env.CATALOG_URL || "https://greenfield-bot.onrender.com/catalog.html";

function parseVendorsFromEnv() {
  const byJson = process.env.WHATSAPP_VENDOR_CONTACTS || "";
  if (byJson.trim()) { try { return JSON.parse(byJson); } catch {} }
  const byCsv = process.env.WHATSAPP_VENDOR_CONTACTS_CSV || "";
  if (byCsv.trim()) {
    const map = {};
    for (const chunk of byCsv.split(",").map(s => s.trim()).filter(Boolean)) {
      const [phone, ...nameParts] = chunk.split(":");
      const name = (nameParts.join(":") || "").trim();
      if (phone && name) map[phone.replace(/[^\d]/g,"")] = name;
    }
    return map;
  }
  return {};
}
const VENDORS = parseVendorsFromEnv();
const vendorNameOf = (waId="") => VENDORS[String(waId).replace(/[^\d]/g,"")] || null;

const STATE = new Map();
const getS = (id) => {
  if (!STATE.has(id)) STATE.set(id, { greeted:false, mode:null });
  return STATE.get(id);
};
const setS = (id, v) => STATE.set(id, v);

async function waSendQ(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
  if (DEBUG) dbg("SEND", { to, type: payload.type || payload?.interactive?.type });
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("[WA SEND ERROR]", r.status, t);
  }
}

const clamp = (t, n = 20) => (String(t).length <= n ? String(t) : String(t).slice(0, n - 1) + "…");

const toButtons = (to, body, buttons = []) =>
  waSendQ(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body).slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.payload || b.id, title: clamp(b.title, 20) },
        })),
      },
    },
  });

async function showVendorMenu(to, name) {
  const saludo = `Hola ${name}. ¿En qué te puedo ayudar?`;
  await toButtons(to, saludo, [
    { title: "Realizar cotización", payload: "V_MENU_QUOTE" },
    { title: "Registrar gastos",   payload: "V_MENU_EXP"   },
  ]);
}

// === NUEVO: Botón para volver al menú principal ===
async function sendHomeButton(to) {
  await toButtons(to, "¿Querés volver al menú principal?", [
    { title: "⬅️ Volver: Cotizar o Gastos", payload: "V_MENU_HOME" },
  ]);
}

const processed = new Map();
const PROCESSED_TTL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of processed) if (now - ts > PROCESSED_TTL) processed.delete(k);
}, 60000);
const seenWamid = (id) => {
  if (!id) return false;
  const now = Date.now();
  const last = processed.get(id) || 0;
  processed.set(id, now);
  return (now - last) < PROCESSED_TTL;
};

router.get("/wa/webhook", (req, res, next) => {
  const mode  = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chall = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(String(chall || ""));
  return next();
});

router.post("/wa/webhook", async (req, res, next) => {
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    if (!msg) return next();
    if (seenWamid(msg.id)) return res.sendStatus(200);

    const from = (msg.from || "").replace(/[^\d]/g, "");
    const vendorName = vendorNameOf(from);
    if (!vendorName) return next();

    const s = getS(from);

    if (!s.greeted) {
      s.greeted = true;
      s.mode = null;
      setS(from, s);
      await showVendorMenu(from, vendorName);
      return res.sendStatus(200);
    }

    if (msg.type === "interactive") {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = (br?.id || lr?.id || "").toString();

      // === NUEVO: acción del botón Home ===
      if (id === "V_MENU_HOME") {
        s.mode = null; setS(from, s);
        await showVendorMenu(from, vendorName);
        return res.sendStatus(200);
      }

      if (id === "V_MENU_QUOTE" || id === "GO_QUOTE") {
        s.mode = "advisor"; setS(from, s);
        await waSendQ(from, {
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: {
            body:
              `Abrí el *catálogo* y armá el pedido para tu cliente.\n` +
              `${CATALOG_URL}\n\n` +
              `Cuando me llegue el mensaje del carrito, te voy a pedir, en un *solo mensaje*:\n\n` +
              `NOMBRE: Juan Pérez\n` +
              `DEPARTAMENTO: Santa Cruz\n` +
              `ZONA: Norte`
          }
        });
        // Mostrar botón para volver al menú desde la vista de cotización
        await sendHomeButton(from);
        return res.sendStatus(200);
      }

      if (id === "V_MENU_EXP") {
        s.mode = "sheets"; setS(from, s);
        // Mostrar botón para volver al menú desde la vista de gastos
        await sendHomeButton(from);
        return sheetsRouter(req, res, next);
      }

      if (id === "V_MENU_BACK") { // compatibilidad con tu id previo
        s.mode = null; setS(from, s);
        await showVendorMenu(from, vendorName);
        return res.sendStatus(200);
      }

      if (s.mode === "advisor") { req._fromHubVendor = true; return advisorRouter(req, res, next); }
      if (s.mode === "sheets")  return sheetsRouter(req, res, next);
      await showVendorMenu(from, vendorName);
      return res.sendStatus(200);
    }

    if (msg.type === "text") {
      const raw = (msg.text?.body || "").trim();
      const text = raw.toLowerCase();

      // === PALABRAS CLAVE PARA VOLVER AL MENÚ ===
      if (text === "menu" || text === "inicio" || /volver( al)? men[uú]/i.test(raw)) {
        s.mode = null; setS(from, s);
        await showVendorMenu(from, vendorName);
        return res.sendStatus(200);
      }

      if (/(gasto|registrar|rendici[oó]n)/i.test(text)) {
        s.mode = "sheets"; setS(from, s);
        await sendHomeButton(from);
        return sheetsRouter(req, res, next);
      }
      if (/(cotiz|precio|presupuesto)/i.test(text)) {
        s.mode = "advisor"; setS(from, s);
        await waSendQ(from, {
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: {
            body:
              `Abrí el *catálogo* y armá el pedido para tu cliente.\n` +
              `${CATALOG_URL}\n\n` +
              `Cuando me llegue el mensaje del carrito, te voy a pedir, en un *solo mensaje*:\n\n` +
              `NOMBRE: Juan Pérez\n` +
              `DEPARTAMENTO: Santa Cruz\n` +
              `ZONA: Norte`
          }
        });
        await sendHomeButton(from);
        return res.sendStatus(200);
      }

      if (s.mode === "advisor") { req._fromHubVendor = true; return advisorRouter(req, res, next); }
      if (s.mode === "sheets")  return sheetsRouter(req, res, next);

      await showVendorMenu(from, vendorName);
      return res.sendStatus(200);
    }

    if (s.mode === "advisor") { req._fromHubVendor = true; return advisorRouter(req, res, next); }
    if (s.mode === "sheets")  return sheetsRouter(req, res, next);

    await showVendorMenu(from, vendorName);
    return res.sendStatus(200);
  } catch (e) {
    console.error("[HUB] webhook error", e);
    return next(e);
  }
});

export default router;
