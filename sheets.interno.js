import "dotenv/config";
import { google } from "googleapis";

let _sheets;

export async function getSheets() {
  if (_sheets) return _sheets;
  let auth;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON2;
  if (raw && raw.trim()) {
    const creds = JSON.parse(raw);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  } else {
    throw new Error(
      "No hay credenciales de Google. Define GOOGLE_CREDENTIALS_JSON2 o GOOGLE_APPLICATION_CREDENTIALS."
    );
  }
  const client = await auth.getClient();
  _sheets = google.sheets({ version: "v4", auth: client });
  return _sheets;
}

const pad2 = (n) => String(n).padStart(2, "0");
const LOCAL_TZ = process.env.LOCAL_TZ || "America/La_Paz";

export function nowDisplay() {
  try {
    const parts = new Intl.DateTimeFormat("es-BO", {
      timeZone: LOCAL_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
}

export function todayISODate() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: LOCAL_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
}

export const HEADERS = [
  "id",
  "fecha",
  "categoria",
  "lugar",
  "detalle",
  "km",
  "factura",
  "monto_bs",
  "total_dia_bs",
];

// ───────────────────────────────────────────────────────────
// A1 helper: comilla simple y escapa ' → '' para nombres de hoja
const a1 = (sheetName) => `'${String(sheetName).replace(/'/g, "''")}'`;
// ───────────────────────────────────────────────────────────

function canonSheetName(name = "") {
  return String(name || "Empleado").trim().slice(0, 99);
}
function num(x) {
  if (typeof x === "number") return x;
  const s = String(x ?? "").replace(/\s+/g, "").replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export async function ensureEmployeeSheet(empleadoNombre) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID2;
  if (!spreadsheetId) throw new Error("Falta SHEETS_SPREADSHEET_ID2");
  const title = canonSheetName(empleadoNombre);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === title);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${a1(title)}!A1:I1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  } else {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${a1(title)}!A1:I1`,
    });
    const h = r.data.values?.[0] || [];
    if (h.length < HEADERS.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${a1(title)}!A1:I1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }
  }
  return title;
}

async function getNextId(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID2;
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1(hoja)}!A:A`,
  });
  const rows = r.data.values || [];
  if (rows.length <= 1) return 1;
  const last = rows
    .slice(1)
    .map((x) => Number(x?.[0] || 0))
    .filter((n) => Number.isFinite(n));
  return last.length ? Math.max(...last) + 1 : 1;
}

/** KM anterior no vacío (último de la hoja) */
export async function lastKm(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID2;
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1(hoja)}!A2:I100000`,
  });
  const rows = r.data.values || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]?.[5];
    const n = num(v);
    if (String(v ?? "") !== "" && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Inserta registro. Si cambia de día, inserta fila en blanco como separador. */
export async function appendExpenseRow(
  hoja,
  { categoria, lugar = "", detalle = "", km = undefined, factura = "", monto = 0 }
) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID2;
  const today = todayISODate();

  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1(hoja)}!A2:I100000`,
  });
  const rows = r.data.values || [];

  let lastDate = "";
  if (rows.length) {
    const lastRow = rows[rows.length - 1];
    lastDate = String(lastRow?.[1] || "").slice(0, 10);
  }
  if (lastDate && lastDate !== today) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${a1(hoja)}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [["", "", "", "", "", "", "", "", ""]] },
    });
  }

  const totalPrev = rows
    .filter((rw) => String(rw?.[1] || "").slice(0, 10) === today)
    .reduce((a, rw) => a + num(rw?.[7] || 0), 0);

  const id = await getNextId(hoja);
  const fecha = nowDisplay();
  const montoN = num(monto);

  // KM: vacío si no se proporcionó; número si sí se proporcionó
  let kmOut = "";
  if (km !== undefined && km !== null && String(km) !== "") {
    kmOut = num(km);
  }

  const totalDia = totalPrev + montoN;

  const out = [
    id,
    fecha,
    String(categoria || "").toLowerCase(),
    lugar,
    detalle,
    kmOut,            // puede quedar "" (vacío)
    factura,
    montoN || 0,
    totalDia,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${a1(hoja)}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [out] },
  });

  return { id, fecha, totalDia };
}

export async function todayTotalFor(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID2;
  const today = todayISODate();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1(hoja)}!A2:I100000`,
  });
  const rows = r.data.values || [];
  return rows
    .filter((rw) => String(rw?.[1] || "").slice(0, 10) === today)
    .reduce((a, rw) => a + num(rw?.[7] || 0), 0);
}

export async function todaySummary(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID2;
  const today = todayISODate();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1(hoja)}!A2:I100000`,
  });
  const rows = r.data.values || [];
  const todays = rows.filter((rw) => String(rw?.[1] || "").slice(0, 10) === today);
  if (!todays.length) return "Hoy no registraste gastos.";

  const byCat = new Map();
  for (const rw of todays) {
    const cat = String(rw[2] || "").toLowerCase();
    const arr = byCat.get(cat) || [];
    arr.push(rw);
    byCat.set(cat, arr);
  }

  const fmt = (n) => num(n).toFixed(2);
  const parts = [];
  for (const [cat, arr] of byCat.entries()) {
    const totalCat = arr.reduce((a, rw) => a + num(rw[7] || 0), 0);
    const kmCat = arr.reduce((a, rw) => a + num(rw[5] || 0), 0);
    const lines = arr.map((rw) => {
      const lugar = rw[3] ? `@ ${rw[3]} ` : "";
      const det = rw[4] ? `— ${rw[4]} ` : "";
      const fac = rw[6] ? `(Fac ${rw[6]}) ` : "";
      const km = String(rw[5] ?? "") !== "" ? `| ${num(rw[5])} km ` : "";
      return `   - ${lugar}${det}${fac}${km}Bs ${fmt(rw[7])}`;
    });
    parts.push(
      `• ${cat[0].toUpperCase() + cat.slice(1)}: Bs ${fmt(totalCat)}\n${lines.join("\n")}${
        kmCat ? `\n   Total km ${cat}: ${kmCat} km` : ""
      }`
    );
  }

  const totalDia = todays.reduce((a, rw) => a + num(rw[7] || 0), 0);
  parts.push(`• Total del día: Bs ${fmt(totalDia)}`);
  return parts.join("\n");
}
