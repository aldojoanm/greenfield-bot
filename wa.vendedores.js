// wa.vendedores.js
import express from "express";

/**
 * ESTE ARCHIVO SOLO INTERCEPTA A VENDEDORES (definidos por ENV) Y LES MUESTRA UN MENÚ.
 * - Si el vendedor elige "Realizar cotización" => delega al flujo completo de wa.js (asesor)
 * - Si elige "Registrar gastos" => delega al flujo de wa.sheets.js (gastos)
 *
 * Para todos los demás contactos: next() y que lo manejen tus otros routers como siempre.
 *
 * IMPORTANTE:
 *   - Monta este router ANTES que los routers de wa.js y wa.sheets.js.
 *   - Configura el ENV WHATSAPP_VENDOR_CONTACTS (JSON) o WHATSAPP_VENDOR_CONTACTS_CSV.
 */

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_123";
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const DEBUG = process.env.DEBUG_LOGS === "1";
const dbg = (...a) => { if (DEBUG) console.log("[VENDORS]", ...a); };

// ====== Carga de contactos de vendedores desde ENV ======
/**
 * Formatos aceptados:
 * 1) WHATSAPP_VENDOR_CONTACTS como JSON de { "5917XXXXXXXX": "Nombre Apellido", ... }
 * 2) WHATSAPP_VENDOR_CONTACTS_CSV como: 5917XXXXXXX:Pedro Perez,5917YYYYYYY:Maria Lopez
 */
function parseVendorsFromEnv() {
  const byJson = process.env.WHATSAPP_VENDOR_CONTACTS || "";
  if (byJson.trim()) {
    try { return JSON.parse(byJson); } catch { /* fallthrough */ }
  }
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
  // Valores de ejemplo para que edites luego
  return {
    "59170000000": "Pedro Perez",
    "59171111111": "Maria Lopez"
  };
}
const VENDORS = parseVendorsFromEnv();
const vendorNameOf = (waId="") => VENDORS[String(waId).replace(/[^\d]/g,"")] || null;

// ====== Memoria efímera (solo para saber si está en menú / subflujo) ======
const STATE = new Map();  // from -> { greeted:boolean, mode:null|'advisor'|'sheets' }
const getS = (id) => {
  if (!STATE.has(id)) STATE.set(id, { greeted:false, mode:null });
  return STATE.get(id);
};
const setS = (id, v) => STATE.set(id, v);

// ====== Utilidades de WhatsApp API ======
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
const toText = (to, body) =>
  waSendQ(to, { messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4096), preview_url: false } });

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

// ====== UI de bienvenida/menu para vendedores ======
async function showVendorMenu(to, name) {
  const saludo = `Hola ${name}, soy el asistente de *Greenfield*.\n¿En qué te puedo ayudar?`;
  await toButtons(to, saludo, [
    { title: "Realizar cotización", payload: "V_MENU_QUOTE" },
    { title: "Registrar gastos",    payload: "V_MENU_EXP"   },
  ]);
}

async function showBackToMenu(to) {
  await toButtons(to, "Si deseas algo más, aquí estoy 👇", [
    { title: "Menú principal", payload: "V_MENU_BACK" },
  ]);
}

// ====== Webhook verify para este router (pasa si no aplica) ======
router.get("/wa/webhook", (req, res, next) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chall = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(String(chall || ""));
  // No es verificación válida: no consumimos la ruta, dejamos a otros routers responder 403 si corresponde
  return next();
});

// ====== POST webhook: intercepta SOLO a vendedores ======
// NOTA: si NO es vendedor => next() y lo manejan tus routers existentes (wa.js / wa.sheets.js)
router.post("/wa/webhook", async (req, res, next) => {
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];

    if (!msg) return next(); // nada que procesar
    const from = (msg.from || "").replace(/[^\d]/g, "");
    const vendorName = vendorNameOf(from);

    // Si no es vendedor, pasamos al siguiente router
    if (!vendorName) return next();

    // Es vendedor: manejamos menú y, tras elegir, delegamos al flujo correspondiente
    const s = getS(from);

    // 1) Primera vez: saludo + menú
    if (!s.greeted) {
      s.greeted = true;
      setS(from, s);
      await showVendorMenu(from, vendorName);
      return res.sendStatus(200);
    }

    // 2) Botones del menú
    if (msg.type === "interactive") {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = (br?.id || lr?.id || "").toString();

      if (id === "V_MENU_QUOTE") {
        s.mode = "advisor"; setS(from, s);
        // Mensaje de transición y delega al flujo de wa.js
        await toText(from, "Perfecto, seguimos con *cotización*.");
        // Delegamos el MISMO req/res al router de asesor
        return advisorDelegate(req, res, next);
      }

      if (id === "V_MENU_EXP") {
        s.mode = "sheets"; setS(from, s);
        await toText(from, "Entendido, vamos a *registrar gastos*.");
        return sheetsDelegate(req, res, next);
      }

      if (id === "V_MENU_BACK") {
        s.mode = null; setS(from, s);
        await showVendorMenu(from, vendorName);
        return res.sendStatus(200);
      }
      // Si otros botones (propios de los subflujos) llegan aquí por error, intentamos delegar según modo
      if (s.mode === "advisor") return advisorDelegate(req, res, next);
      if (s.mode === "sheets")  return sheetsDelegate(req, res, next);
      // Sin modo: volver a menú
      await showVendorMenu(from, vendorName);
      return res.sendStatus(200);
    }

    // 3) Texto libre: atajos
    if (msg.type === "text") {
      const text = (msg.text?.body || "").trim().toLowerCase();
      if (text === "menu" || text === "inicio") {
        s.mode = null; setS(from, s);
        await showVendorMenu(from, vendorName);
        return res.sendStatus(200);
      }

      // Si ya eligió un modo, delegamos al subflujo correspondiente
      if (s.mode === "advisor") return advisorDelegate(req, res, next);
      if (s.mode === "sheets")  return sheetsDelegate(req, res, next);

      // Si aún no eligió, re-mostrar menú
      await showVendorMenu(from, vendorName);
      return res.sendStatus(200);
    }

    // 4) Otros tipos (media, etc.): delega si hay modo activo; si no, menú
    if (s.mode === "advisor") return advisorDelegate(req, res, next);
    if (s.mode === "sheets")  return sheetsDelegate(req, res, next);

    await showVendorMenu(from, vendorName);
    return res.sendStatus(200);
  } catch (e) {
    console.error("[VENDORS] webhook error", e);
    // No cortamos la cadena: si algo falló aquí, dejamos que otros routers intenten manejar
    return next();
  }
});

import advisorRouter from "./wa.js";        // tu router grande de cotizaciones
import sheetsRouter  from "./wa.sheets.js"; // tu router de gastos

async function advisorDelegate(req, res, next) {
  try {
    return advisorRouter(req, res, next);
  } catch (e) {
    console.error("[VENDORS] advisorDelegate error", e);
    return next(e);
  }
}
async function sheetsDelegate(req, res, next) {
  try {
    return sheetsRouter(req, res, next);
  } catch (e) {
    console.error("[VENDORS] sheetsDelegate error", e);
    return next(e);
  }
}

export default router;
