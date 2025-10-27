import express from "express";
import {
  ensureEmployeeSheet,
  appendExpenseRow,
  todayTotalFor,
  todaySummary,
  lastKm,
} from "./sheets.js";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "VERIFY_123";
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const DEBUG = process.env.DEBUG_LOGS === "1";
const log = (...a) => console.log("[WA]", ...a);
const dbg = (...a) => { if (DEBUG) console.log("[DBG]", ...a); };

/* ======================= Estado ======================= */
const S = new Map();
const getS = (id) => {
  if (!S.has(id)) S.set(id, { etapa: "ask_area", pageIdx: 0, flow: null, lastKm: null });
  return S.get(id);
};
const setS = (id, v) => S.set(id, v);

/* ======================= Envío WA ======================= */
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

/** Lista paginada (máx 10 filas por mensaje) */
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

/* ======================= Categorías ======================= */
const CATS = ["combustible", "alimentacion", "hospedaje", "peajes", "aceites", "llantas", "frenos", "otros"];

/* ======== Prefiltro por Área + Responsables ======== */
const AREAS = {
  HORTIFRUT: ["Baneza Maldonado", "Moises Reyna", "Arturo Hinojosa", "Maira Cadima"],
  AGROINDUSTRIA: [
    "John Gaviria",
    "Javier Bonilla",
    "Miguel Gonzales",
    "Miguel Mamani",
    "Darwin Coimbra",
    "Sebastian Rueda",
    "Alejandro Llado",
    "Diego Hinojosa",
    "Armin Hurtado",
    "Angel Suarez",
    "Alvaro Mitma",
    "Andres Moreno",
  ],
};

const saludo = () =>
  "Hola, soy el asistente de Greenfield. Registraré tus gastos por categoría.";

/* ==== UI ==== */
async function pedirArea(to) {
  await toButtons(to, "Primero, elige el área:", [
    { title: "Hortifrut", payload: "AREA_HORTIFRUT" },
    { title: "Agroindustria", payload: "AREA_AGROINDUSTRIA" },
  ]);
}

async function pedirResponsable(to, areaKey, pageIdx = 0) {
  const key = String(areaKey || "").toUpperCase();
  const names = (AREAS[key] || []).map((n, i) => ({ id: `EMP_${i}`, title: n }));
  await toPagedList(to, {
    body: "Selecciona al responsable:",
    buttonTitle: "Elegir",
    rows: names,
    pageIdx,
    title: key === "HORTIFRUT" ? "Hortifrut" : "Agroindustria",
  });
}

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

/* ============ Flujo dinámico por categoría ============ */
function buildFlow(categoria) {
  const cat = String(categoria || "").toLowerCase();
  if (cat === "combustible") {
    return [
      { key: "lugar", prompt: "📍 ¿Dónde cargaste combustible? (ciudad/ubicación)" },
      { key: "km", prompt: "⛽ Ingresa el kilometraje del vehículo (solo número)." },
      { key: "monto", prompt: "💵 Ingresa el monto en Bs (ej.: 120.50)." },
      { key: "factura", prompt: "🧾 Número de factura/recibo (o escribe “ninguno”)." },
    ];
  }
  if (["aceites", "llantas", "frenos"].includes(cat)) {
    return [
      { key: "lugar", prompt: "📍 ¿Dónde se realizó el servicio/compra?" },
      { key: "detalle", prompt: "📝 Detalla brevemente el servicio o producto." },
      { key: "km", prompt: "🚗 Kilometraje del vehículo (solo número)." },
      { key: "factura", prompt: "🧾 Número de factura/recibo (o “ninguno”)." },
      { key: "monto", prompt: "💵 Monto en Bs (ej.: 250.00)." },
    ];
  }
  // Alimentación / Hospedaje / Peajes / Otros
  return [
    { key: "detalle", prompt: "📝 Describe brevemente el gasto." },
    { key: "factura", prompt: "🧾 Número de factura/recibo (o “ninguno”)." },
    { key: "monto", prompt: "💵 Ingresa el monto en Bs (ej.: 80.00)." },
  ];
}

function parseNumberFlexible(s = "") {
  const t = String(s).replace(/\s+/g, "").replace(/,/g, ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Pregunta el paso actual, con recordatorio de KM si aplica */
async function askCurrentStep(to, s) {
  const step = s.flow.steps[s.flow.i];
  if (step.key === "km") {
    // Traer último KM y guardarlo en sesión
    const prev = await lastKm(s.empleado);
    s.lastKm = prev;
    setS(to, s); // small trick: map key is phone; here we reuse "to" which is 'from'
    const tip = prev != null ? ` (último registrado: *${prev}*)` : " (no hay KM previo)";
    await toText(to, step.prompt + tip);
  } else {
    await toText(to, step.prompt);
  }
}

/* ======================= Webhook ======================= */
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

    const from = msg.from;
    const s = getS(from);
    dbg("IN", { from, type: msg.type, etapa: s.etapa });

    // saludo
    if (!s.greeted) {
      s.greeted = true;
      await toText(from, saludo());
      s.etapa = "ask_area";
      s.pageIdx = 0;
      setS(from, s);
      await pedirArea(from);
      return res.sendStatus(200);
    }

    /* =================== INTERACTIVE =================== */
    if (msg.type === "interactive") {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = (br?.id || lr?.id || "").toString();
      const idU = id.toUpperCase();
      dbg("INTERACTIVE", idU, "ETAPA", s.etapa);

      if (idU === "NAV_NEXT" && s.etapa === "ask_personal") {
        s.pageIdx = (s.pageIdx || 0) + 1;
        setS(from, s);
        await pedirResponsable(from, s.area, s.pageIdx);
        return res.sendStatus(200);
      }
      if (idU === "NAV_PREV" && s.etapa === "ask_personal") {
        s.pageIdx = Math.max(0, (s.pageIdx || 0) - 1);
        setS(from, s);
        await pedirResponsable(from, s.area, s.pageIdx);
        return res.sendStatus(200);
      }

      if (idU === "AREA_HORTIFRUT" || idU === "AREA_AGROINDUSTRIA") {
        s.area = idU.replace("AREA_", "");
        s.etapa = "ask_personal";
        s.pageIdx = 0;
        setS(from, s);
        await pedirResponsable(from, s.area, s.pageIdx);
        return res.sendStatus(200);
      }

      if (idU.startsWith("EMP_") && s.etapa === "ask_personal" && s.area) {
        const idx = Number(idU.replace("EMP_", "")) || 0;
        const names = AREAS[s.area] || [];
        const nombre = names[idx] || names[0] || "Responsable";
        s.empleado = await ensureEmployeeSheet(nombre);
        s.lastKm = await lastKm(s.empleado); // precargar
        await toText(from, `Responsable seleccionado: *${nombre}*`);
        s.etapa = "ask_categoria";
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
        if (!s.empleado) { s.etapa = "ask_area"; setS(from, s); await pedirArea(from); return res.sendStatus(200); }
        const txt = await todaySummary(s.empleado);
        await toText(from, txt);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    /* =================== TEXTO =================== */
    if (msg.type === "text") {
      const text = (msg.text?.body || "").trim();

      if (/^(menu|inicio)$/i.test(text)) {
        s.etapa = "ask_area";
        s.area = null;
        s.empleado = null;
        s.pageIdx = 0;
        s.flow = null;
        s.lastKm = null;
        setS(from, s);
        await pedirArea(from);
        return res.sendStatus(200);
      }

      if (s.etapa === "ask_area") {
        if (/hortifrut/i.test(text)) {
          s.area = "HORTIFRUT"; s.etapa = "ask_personal"; s.pageIdx = 0; setS(from, s);
          await pedirResponsable(from, s.area, s.pageIdx); return res.sendStatus(200);
        }
        if (/agroindustria/i.test(text)) {
          s.area = "AGROINDUSTRIA"; s.etapa = "ask_personal"; s.pageIdx = 0; setS(from, s);
          await pedirResponsable(from, s.area, s.pageIdx); return res.sendStatus(200);
        }
        await pedirArea(from); return res.sendStatus(200);
      }

      if (s.etapa === "ask_personal" && s.area) {
        const names = (AREAS[s.area] || []);
        const pickIdx = names.findIndex((n) => n.toLowerCase().includes(text.toLowerCase()));
        if (pickIdx >= 0) {
          const nombre = names[pickIdx];
          s.empleado = await ensureEmployeeSheet(nombre);
          s.lastKm = await lastKm(s.empleado);
          await toText(from, `Responsable seleccionado: *${nombre}*`);
          s.etapa = "ask_categoria";
          setS(from, s);
          await pedirCategoria(from);
          return res.sendStatus(200);
        }
        await pedirResponsable(from, s.area, s.pageIdx);
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

      // Recolección de pasos
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
        if (!s.empleado) { s.etapa = "ask_area"; s.flow = null; setS(from, s); await pedirArea(from); return res.sendStatus(200); }

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
        if (!s.empleado) { s.etapa = "ask_area"; setS(from, s); await pedirArea(from); return res.sendStatus(200); }
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
