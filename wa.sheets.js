import express from "express";
import {
  ensureEmployeeSheet,
  appendExpenseRow,
  todayTotalFor,
  todaySummary,
  lastKm,
} from "./sheets.interno.js";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_123";
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const DEBUG = process.env.DEBUG_LOGS === "1";
const log = (...a) => console.log("[WA]", ...a);
const dbg = (...a) => { if (DEBUG) console.log("[DBG]", ...a); };

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
  return {};
}
const VENDORS = parseVendorsFromEnv();
const vendorNameOf = (waId="") => VENDORS[String(waId).replace(/[^\d]/g,"")] || null;

const S = new Map();
const getS = (id) => {
  if (!S.has(id)) S.set(id, {
    greeted: false,
    empleado: null,
    lastKm: null,
    etapa: "ask_categoria",
    pageIdx: 0,
    flow: null
  });
  return S.get(id);
};
const setS = (id, v) => S.set(id, v);

async function waSendQ(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
  dbg("SEND", { to, type: payload.type || payload?.interactive?.type });
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
const clamp = (t, n = 24) => (String(t).length <= n ? String(t) : String(t).slice(0, n - 1) + "…");
const toText = (to, body) =>
  waSendQ(to, { messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4096), preview_url: false } });

/** Botones (máx 3) */
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

async function toPagedList(to, { body, buttonTitle, rows, pageIdx, title }) {
  const PAGE_SIZE = 8; // 8 + Prev + Next = 10
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, pageIdx || 0), totalPages - 1);
  const start = p * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const navRows = [];
  if (p > 0) navRows.push({ id: "NAV_PREV", title: "‹ Anterior" });
  if (p < totalPages - 1) navRows.push({ id: "NAV_NEXT", title: "Siguiente ›" });

  const finalRows = [
    ...pageRows.map((r) => ({ id: r.payload || r.id, title: clamp(r.title || "", 24) })),
    ...navRows,
  ].slice(0, 10);

  return waSendQ(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(body).slice(0, 1024) },
      action: { button: clamp(buttonTitle, 20), sections: [{ title, rows: finalRows }] },
    },
  });
}

const CATS = ["combustible", "alimentacion", "hospedaje", "peajes", "aceites", "llantas", "frenos", "otros"];

async function pedirCategoria(to) {
  const rows = CATS.map((c) => ({ id: `CAT_${c}`, title: c[0].toUpperCase() + c.slice(1) }));
  await toPagedList(to, {
    body: "¿Qué deseas registrar ahora?",
    buttonTitle: "Seleccionar",
    rows,
    pageIdx: 0,
    title: "Categorías",
  });
}

function buildFlow(categoria) {
  const cat = String(categoria || "").toLowerCase();
  if (cat === "combustible") {
    return [
      { key: "lugar",   prompt: "📍 ¿Dónde cargaste combustible? (ciudad/ubicación)" },
      { key: "km",      prompt: "⛽ Ingresa el kilometraje del vehículo (solo número)." },
      { key: "monto",   prompt: "💵 Ingresa el monto en Bs (ej.: 120.50)." },
      { key: "factura", prompt: "🧾 Número de factura/recibo (o escribe “ninguno”)." },
    ];
  }
  if (["aceites", "llantas", "frenos"].includes(cat)) {
    return [
      { key: "lugar",   prompt: "📍 ¿Dónde se realizó el servicio/compra?" },
      { key: "detalle", prompt: "📝 Detalla brevemente el servicio o producto." },
      { key: "km",      prompt: "🚗 Kilometraje del vehículo (solo número)." },
      { key: "factura", prompt: "🧾 Número de factura/recibo (o “ninguno”)." },
      { key: "monto",   prompt: "💵 Monto en Bs (ej.: 250.00)." },
    ];
  }

  return [
    { key: "detalle", prompt: "📝 Describe brevemente el gasto." },
    { key: "factura", prompt: "🧾 Número de factura/recibo (o “ninguno”)." },
    { key: "monto",   prompt: "💵 Ingresa el monto en Bs (ej.: 80.00)." },
  ];
}

function parseNumberFlexible(s = "") {
  const t = String(s).replace(/\s+/g, "").replace(/,/g, ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

async function askCurrentStep(to, s) {
  const step = s.flow.steps[s.flow.i];
  if (step.key === "km") {
    const prev = await lastKm(s.empleado);
    s.lastKm = prev;
    setS(to, s);
    const tip = prev != null ? ` (último registrado: *${prev}*)` : " (no hay KM previo)";
    await toText(to, step.prompt + tip);
  } else {
    await toText(to, step.prompt);
  }
}

router.get("/wa/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chall = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(String(chall || ""));
  return res.sendStatus(403);
});

router.post("/wa/webhook", async (req, res) => {
  try {
    if (DEBUG) log("BODY", JSON.stringify(req.body));
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = (msg.from || "").replace(/[^\d]/g,"");
    const s = getS(from);
    dbg("IN", { from, type: msg.type, etapa: s.etapa, empleado: s.empleado });

    if (!s.greeted) {
      s.greeted = true;

      const officialName = vendorNameOf(from);
      let hoja = null;
      if (officialName) {
        hoja = await ensureEmployeeSheet(officialName);
        s.empleado = hoja;
        s.lastKm = await lastKm(s.empleado);
        await toText(from, `Hola *${officialName}*, soy el asistente de Greenfield. Registraré tus gastos por categoría.`);
      } else {
        const fallback = `GENÉRICO – ${from}`;
        hoja = await ensureEmployeeSheet(fallback);
        s.empleado = hoja;
        s.lastKm = await lastKm(s.empleado);
        await toText(from, `Hola, tu número *${from}* no está en la lista oficial de vendedores.\nRegistraré en la hoja: *${fallback}*.\n(Pídele al admin que te agregue en WHATSAPP_VENDOR_CONTACTS para mostrar tu nombre oficial.)`);
      }

      s.etapa = "ask_categoria";
      s.pageIdx = 0;
      setS(from, s);
      await pedirCategoria(from);
      return res.sendStatus(200);
    }

    if (msg.type === "interactive") {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = (br?.id || lr?.id || "").toString();
      const idU = id.toUpperCase();
      dbg("INTERACTIVE", idU, "ETAPA", s.etapa);

      if (idU === "NAV_NEXT") {
        s.pageIdx = (s.pageIdx || 0) + 1;
        setS(from, s);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }
      if (idU === "NAV_PREV") {
        s.pageIdx = Math.max(0, (s.pageIdx || 0) - 1);
        setS(from, s);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (idU.startsWith("CAT_")) {
        const categoria = id.replace("CAT_", "").toLowerCase();
        s.flow = { categoria, steps: buildFlow(categoria), data: { categoria }, i: 0 };
        s.etapa = "flow_step";
        setS(from, s);
        await toText(from, `Categoría: *${categoria[0].toUpperCase() + categoria.slice(1)}*`);
        await askCurrentStep(from, s);
        return res.sendStatus(200);
      }

      if (idU === "SEGUIR") {
        s.etapa = "ask_categoria";
        setS(from, s);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (idU === "RESUMEN") {
        if (!s.empleado) {
          await toText(from, "No se identificó una hoja activa. Vuelve a escribir “inicio”.");
          return res.sendStatus(200);
        }
        const txt = await todaySummary(s.empleado);
        await toText(from, txt);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (msg.type === "text") {
      const text = (msg.text?.body || "").trim();

      if (/^(menu|inicio)$/i.test(text)) {
        s.etapa = "ask_categoria";
        s.pageIdx = 0;
        s.flow = null;
        setS(from, s);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_categoria") {
        const hit = CATS.find((c) => text.toLowerCase().includes(c));
        if (!hit) { await pedirCategoria(from); return res.sendStatus(200); }
        s.flow = { categoria: hit, steps: buildFlow(hit), data: { categoria: hit }, i: 0 };
        s.etapa = "flow_step";
        setS(from, s);
        await toText(from, `Categoría: *${hit[0].toUpperCase() + hit.slice(1)}*`);
        await askCurrentStep(from, s);
        return res.sendStatus(200);
      }

      if (s.etapa === "flow_step" && s.flow) {
        const step = s.flow.steps[s.flow.i];
        const k = step.key;
        let val = text;

        if (k === "km" || k === "monto") {
          const n = parseNumberFlexible(text);
          if (!Number.isFinite(n) || n < 0) {
            await toText(from, k === "km" ? "Por favor envía un número válido de *kilómetros*." : "Por favor envía un *monto* válido en Bs (ej.: 120.50).");
            return res.sendStatus(200);
          }
          if (k === "km") {
            // Validación contra último km
            const prev = s.lastKm ?? (s.empleado ? await lastKm(s.empleado) : null);
            s.lastKm = prev;
            if (prev != null && n < prev) {
              await toText(from, `El kilometraje ingresado (*${n}*) es menor al último registrado (*${prev}*). Corrige el valor.`);
              return res.sendStatus(200);
            }
          }
          val = n;
        }
        if (k === "factura" && /^ninguno$/i.test(text)) val = "";

        s.flow.data[k] = val;
        s.flow.i += 1;

        if (s.flow.i < s.flow.steps.length) {
          await askCurrentStep(from, s);
          setS(from, s);
          return res.sendStatus(200);
        }

        // Fin de flujo → guardar fila
        if (!s.empleado) {
          await toText(from, "No se identificó una hoja activa. Vuelve a escribir “inicio”.");
          s.etapa = "ask_categoria";
          s.flow = null;
          setS(from, s);
          return res.sendStatus(200);
        }

        const { categoria, lugar = "", detalle = "", km = undefined, factura = "", monto = 0 } = s.flow.data;
        const saved = await appendExpenseRow(s.empleado, { categoria, lugar, detalle, km, factura, monto });
        const totalHoy = await todayTotalFor(s.empleado);

        const prettyCat = categoria[0].toUpperCase() + categoria.slice(1);
        const lines = [
          `✅ *Registrado* en hoja: ${s.empleado}`,
          `• Categoría: ${prettyCat}`,
          lugar ? `• Lugar: ${lugar}` : null,
          detalle ? `• Detalle: ${detalle}` : null,
          (km !== undefined && km !== null && String(km) !== "") ? `• Kilometraje: ${km} km` : null,
          factura ? `• Factura/Recibo: ${factura}` : "• Factura/Recibo: —",
          `• Monto: Bs ${Number(monto).toFixed(2)}`,
          `• ID: ${saved.id} — Fecha: ${saved.fecha}`,
          `*Total del día*: Bs ${Number(totalHoy).toFixed(2)}`,
        ].filter(Boolean);

        await toText(from, lines.join("\n"));

        s.etapa = "ask_categoria";
        s.flow = null;
        setS(from, s);
        await toButtons(from, "¿Deseas registrar algo más?", [
          { title: "Sí, seguir", payload: "SEGUIR" },
          { title: "Ver resumen", payload: "RESUMEN" },
        ]);
        return res.sendStatus(200);
      }

      if (/^resumen$/i.test(text)) {
        if (!s.empleado) {
          await toText(from, "No se identificó una hoja activa. Vuelve a escribir “inicio”.");
          return res.sendStatus(200);
        }
        const txt = await todaySummary(s.empleado);
        await toText(from, txt);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

export default router;
