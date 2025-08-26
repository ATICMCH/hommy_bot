// inquilinos-bot.js
// Envío WhatsApp automático para INQUILINOS_BOT según E-/E+/S-.
// Requisitos: Node 18+, y:  npm i whatsapp-web.js qrcode-terminal googleapis
// Archivo de credenciales: service-account.json (Service Account con acceso EDITOR al Sheet).


// ==== DIAGNÓSTICO INICIAL ====
console.log('--- DIAGNÓSTICO DE ARRANQUE ---');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('SESSION_PATH:', process.env.SESSION_PATH);
console.log('GOOGLE_CREDS_JSON_B64:', !!process.env.GOOGLE_CREDS_JSON_B64);
console.log('CHROME_PATH:', process.env.CHROME_PATH);
try {
  const fs = require('fs');
  const path = process.env.SESSION_PATH || './sessions-inquilinos';
  fs.accessSync(path, fs.constants.W_OK);
  console.log('Session path is writable:', path);
} catch (e) {
  console.error('Session path is NOT writable:', e.message);
}
process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', err => {
  console.error('UNHANDLED REJECTION:', err);
});
console.log('--- FIN DIAGNÓSTICO DE ARRANQUE ---');

const express = require('express');
const QRCode = require('qrcode');
const app = express();
let lastQRDataUrl = null;
const PORT = process.env.PORT || 8080;

app.get('/health', (_req, res) => res.send('ok'));
app.get('/qr', (req, res) => {
  const t = process.env.QR_TOKEN;
  if (t && req.query.t !== t) return res.status(401).send('unauthorized');
  if (!lastQRDataUrl) return res.status(404).send('QR not ready');
  res.type('html').send(`<img alt="Scan me" src="${lastQRDataUrl}" style="width:320px">`);
});
app.listen(PORT, '0.0.0.0', () => console.log('HTTP up on :' + PORT));
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const fs = require('fs');

/* ================== CONFIGURACIÓN ================== */

// Cambia por el ID de tu Google Sheet
const SPREADSHEET_ID = '1NMFeDN2moKgutCQkpFyOZD9Z01otN6qNX7OoNKi4YSY';

// Nombres de hojas (ajústalos a tus pestañas reales)
const SHEET_TENANTS   = 'INQUILINOS NOTIFICACIONES';
const SHEET_TEMPL_MAD = 'CORTA ESTANCIA MADRID';
const SHEET_TEMPL_C43 = 'CORTA ESTANCIA C43';
const SHEET_TEMPL_H2  = 'CORTA ESTANCIA H2';
const SHEET_TEMPL_RRHH = 'RRHH';
const SHEET_TEMPL_LARGA = 'LARGA ESTANCIA';
const SHEET_LOG       = 'LOG';

// WhatsApp y loop
const DEFAULT_CC      = '34';              // prefijo por defecto (España)
const DRY_RUN         = false;             // true = no envía, sólo escribe en LOG
const LOOP_EVERY_MS   = 60 * 1000;         // revisa cada minuto
const SEND_DELAY_MS   = 600;               // pausa entre envíos para no saturar
const TZ              = 'Europe/Madrid';   // zona horaria para cálculo de "hoy"

// Columnas (1-based) conforme a tu hoja INQUILINOS_BOT
const COL = {
  name: 1,        // A
  number: 2,      // B
  entry: 3,       // C (entry_date)
  exit: 4,        // D (exit_date)
  reservation: 5, // E (reservation_date)
  active: 6,      // F (reminder_activated) -> TRUE = activa
  address: 7      // G (address)
};

/* ================== HELPERS GENERALES ================== */

function getSheetsClient() {
  let raw = process.env.GOOGLE_CREDS_JSON || process.env.GOOGLE_CREDS_JSON_B64 || fs.readFileSync('service-account.json','utf8');
  if (process.env.GOOGLE_CREDS_JSON_B64) {
    raw = Buffer.from(process.env.GOOGLE_CREDS_JSON_B64, 'base64').toString('utf8');
  }
  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

function onlyDigits(s) { return (s || '').replace(/\D+/g, ''); }

function normalizePhoneE164(input) {
  if (!input) return '';
  let s = input.replace(/\s+/g, '');
  s = s.replace(/[^\d+]/g, '');
  // Si ya empieza por + y tiene al menos 8 dígitos, lo dejamos
  if (/^\+\d{8,}$/.test(s)) return s;
  // Si empieza por 00, lo convertimos a +
  if (/^00\d{8,}$/.test(s)) return `+${s.slice(2)}`;
  // Si tiene 9 dígitos (España), anteponemos +34
  if (/^\d{9}$/.test(s)) return `+${DEFAULT_CC}${s}`;
  // Si tiene 10 o más dígitos, asumimos que ya es internacional sin +
  if (/^\d{10,}$/.test(s)) return `+${s}`;
  // Si nada coincide, devolvemos vacío
  return '';
}

function toWhatsAppJid(e164) {
  const digits = onlyDigits(e164);
  return `${digits}@c.us`;
}

function firstName(full) {
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0];
}

function parseDateES(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const m = String(ddmmyyyy).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]) - 1, y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d)); // normalizamos a UTC (dia puro)
  return isNaN(dt) ? null : dt;
}

function todayInTZ() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [y, mo, d] = fmt.format(now).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)); // 00:00 TZ convertido a UTC
}

function daysBetween(aUTC, bUTC) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((aUTC - bUTC) / MS); // días enteros
}

/* ================== PLANTILLAS ================== */

async function loadTemplatesFor(sheetName) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:D999`
  });
  const rows = res.data.values || [];
  if (!rows.length) return {};

  // Soporta dos pares de columnas: A/B y C/D
  const map = {};
  let start = 1;
  // Si la primera fila tiene cabecera, sáltala
  const header = rows[0].map(x => (x || '').toString().trim().toLowerCase());
  if (
    (header[0] && header[0].includes('code')) ||
    (header[1] && header[1].includes('message')) ||
    (header[2] && header[2].includes('code')) ||
    (header[3] && header[3].includes('message'))
  ) {
    start = 1;
  } else {
    start = 0;
  }
  for (const r of rows.slice(start)) {
    // A/B
    const code1 = (r[0] || '').toString().trim();
    const msg1  = (r[1] || '').toString();
    if (code1) map[code1] = msg1;
    // C/D
    const code2 = (r[2] || '').toString().trim();
    const msg2  = (r[3] || '').toString();
    if (code2) map[code2] = msg2;
  }
  return map;
}

async function loadAllTemplates() {
  const [mad, c43, h2, rrhh, larga] = await Promise.all([
    loadTemplatesFor(SHEET_TEMPL_MAD),
    loadTemplatesFor(SHEET_TEMPL_C43),
    loadTemplatesFor(SHEET_TEMPL_H2),
    loadTemplatesFor(SHEET_TEMPL_RRHH),
    loadTemplatesFor(SHEET_TEMPL_LARGA)
  ]);
  return { mad, c43, h2, rrhh, larga };
}

/* ================== INQUILINOS ================== */

async function fetchTenants() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TENANTS}!A1:Z10000`
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const data = [];
  for (const r of rows.slice(1)) {
    data.push({
      name:     (r[COL.name-1] || '').toString().trim(),
      number:   (r[COL.number-1] || '').toString().trim(),
      entry:    parseDateES(r[COL.entry-1]),
      exit:     parseDateES(r[COL.exit-1]),
      reserve:  parseDateES(r[COL.reservation-1]),
      // ENVÍA SOLO CUANDO reminder_activated = TRUE (case-insensitive)
      active:   ((r[COL.active-1] || '').toString().trim().toUpperCase() === 'TRUE'),
      address:  (r[COL.address-1] || '').toString().trim()
    });
  }
  return data;
}

/* ================== LOG ================== */

async function ensureLogSheet() {
  const sheets = getSheetsClient();
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_LOG}!A1:D1`
    });
  } catch {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_LOG}!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['timestamp','number','code','status']] }
    });
  }
}

async function appendLog(number, code, status) {
  const sheets = getSheetsClient();
  const ts = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_LOG}!A:D`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ts, number, code, status]] }
  });
}

async function alreadySentToday(number, code) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_LOG}!A1:D2000`
  });
  const rows = res.data.values || [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(new Date());

  for (const r of rows.slice(1)) {
    const ts = r[0] || '';
    const num = r[1] || '';
    const c = r[2] || '';
    if (num === number && c === code) {
      const d = new Date(ts);
      const dStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(d);
      if (dStr === today) return true;
    }
  }
  return false;
}

/* ================== LÓGICA DE CÓDIGOS ================== */

function pickTemplateSet(templates, address) {
  const addr = (address || '').toUpperCase().replace(/\s+/g, '');
  if (addr.includes('RRHH')) return templates.rrhh;
  if (/\-LE$/.test(addr)) return templates.larga;
  if (addr.includes('CASITA43')) return templates.c43;
  if (addr.includes('HOYO2'))    return templates.h2;
  return templates.mad; // Madrid por defecto
}

function codeForToday(row, templates) {
  // Reglas:
  // - No hace nada antes de reservation_date
  // - Día de entrada -> E-00
  // - Antes de entrada -> E-XX (XX = días que faltan)
  // - Entre entrada y salida -> E+XX
  // - Dos días antes de salida -> S-02, luego S-01
  // - Día de salida -> S-00
  // - Después de salida -> S+XX
  if (!row.entry || !row.exit || !row.reserve) return null;

  const today = todayInTZ();
  if (today < row.reserve) return null; // no empezar antes de reserva

  const dToEntry = daysBetween(today, row.entry);
  const dToExit  = daysBetween(today, row.exit);

  // LOG para depuración
  console.log(`[DEBUG] Hoy: ${today.toISOString().slice(0,10)}, Reserva: ${row.reserve ? row.reserve.toISOString().slice(0,10) : 'N/A'}, Entrada: ${row.entry ? row.entry.toISOString().slice(0,10) : 'N/A'}, Salida: ${row.exit ? row.exit.toISOString().slice(0,10) : 'N/A'}, dToEntry: ${dToEntry}, dToExit: ${dToExit}`);

  let code = null;

  // Desde 30 días antes de entrada hasta entrada (incluida): E-XX
  if (today >= row.reserve && today <= row.entry) {
    const dToEntryAbs = daysBetween(row.entry, today); // días hasta entrada desde hoy
    if (dToEntryAbs >= 0 && dToEntryAbs <= 30) {
      code = `E-${String(dToEntryAbs).padStart(2,'0')}`;
    }
  }
  // Desde 30 días antes de salida hasta salida: S-XX/S-00
  else if (today <= row.exit && today >= new Date(row.exit.getTime() - 30*24*60*60*1000)) {
    const dToExitAbs = daysBetween(row.exit, today);
    if (dToExitAbs === 0) {
      code = 'S-00';
    } else if (dToExitAbs > 0 && dToExitAbs <= 30) {
      code = `S-${String(dToExitAbs).padStart(2,'0')}`;
    }
  }
  // Hasta 30 días después de la salida: S+XX
  else if (today > row.exit && daysBetween(today, row.exit) <= 30) {
    const dAfterExit = daysBetween(today, row.exit);
    code = `S+${String(dAfterExit).padStart(2,'0')}`;
  }

  // Mostrar todos los códigos posibles en la plantilla
  const set = pickTemplateSet(templates, row.address);
  const availableCodes = Object.keys(set).map(k => k.trim().toUpperCase());
  const codeNorm = code ? code.trim().toUpperCase() : '';
  console.log(`[DEBUG] Códigos disponibles en plantilla: ${availableCodes.join(', ')}`);
  console.log(`[DEBUG] Código calculado para hoy: ${codeNorm}`);

  // Buscar el código normalizado
  let msg = null;
  for (const k of Object.keys(set)) {
    if (k && k.trim().toUpperCase() === codeNorm) {
      msg = set[k];
      break;
    }
  }
  if (!msg) {
    console.log(`[DEBUG] No se encontró plantilla para el código: ${codeNorm}`);
    return null;
  }

  return {
    code,
    message: msg.replace(/\{\{name\}\}/g, firstName(row.name))
  };
}

/* ================== WHATSAPP ================== */


let isReady = false;

async function main() {
  let TEMPLATES = await loadAllTemplates();
  setInterval(async () => {
    try { TEMPLATES = await loadAllTemplates(); }
    catch (e) { console.error('❗ No pude refrescar plantillas:', e.message); }
  }, 5 * 60 * 1000);

  await ensureLogSheet();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.SESSION_PATH || './sessions-inquilinos' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async qr => {
    console.log('Escanea este QR con el WhatsApp del número emisor:');
    qrcode.generate(qr, { small: true }); // mantiene QR en terminal
    try { lastQRDataUrl = await QRCode.toDataURL(qr); }
    catch (e) { console.error('QR gen err:', e.message); }
  });

  client.on('ready', async () => {
    lastQRDataUrl = null; // oculta el QR cuando ya está logueado
    isReady = true;
    console.log('✅ WhatsApp listo. Iniciando ciclo…');

    let sleeping = false;
    const tick = async () => {
      if (sleeping) return;
      if (!isReady) {
        console.log('Cliente WhatsApp no está listo, esperando...');
        return;
      }
      try {
        const tenants = await fetchTenants();
        let anyMessage = false;

        for (const row of tenants) {
          if (!row.active) continue;
          const e164 = normalizePhoneE164(row.number);
          if (!e164) {
            console.log(`[SKIP] ${row.number}: número no válido o no normalizado`);
            continue;
          }
          const jid  = toWhatsAppJid(e164);
          const today = todayInTZ();

          // Día de entrada: enviar E-XX pendientes (E-30 a E-01) si no se enviaron antes, luego E-00 solo si no se ha enviado aún
          if (row.entry && today.getTime() === row.entry.getTime()) {
            const set = pickTemplateSet(TEMPLATES, row.address);
            // Enviar E-XX (E-30 a E-01) solo si no se enviaron antes
            const eCodes = Object.keys(set)
              .map(k => k.trim().toUpperCase())
              .filter(k => /^E-\d{2}$/.test(k))
              .map(k => ({
                code: k,
                num: parseInt(k.split('-')[1], 10)
              }))
              .filter(obj => obj.num >= 1 && obj.num <= 30)
              .sort((a, b) => b.num - a.num); // de mayor a menor

            for (const { code, num } of eCodes) {
              if (num > 30 || num < 1) continue;
              const msg = set[code];
              if (!msg) continue;
              const dup = await alreadySentToday(e164, code);
              if (!dup) {
                anyMessage = true;
                if (DRY_RUN) {
                  console.log(`[DRY] ${e164} -> ${code}: ${msg.slice(0, 60)}…`);
                  await appendLog(e164, code, 'DRY');
                } else {
                  try {
                    await client.sendMessage(jid, msg.replace(/\{\{name\}\}/g, firstName(row.name)));
                    console.log(`📨 Enviado ${code} a ${e164}`);
                    await appendLog(e164, code, 'SENT');
                  } catch (err) {
                    console.error(`❌ Error enviando a ${e164}:`, err.message);
                    await appendLog(e164, code, `ERROR: ${err.message}`);
                  }
                  await new Promise(r => setTimeout(r, SEND_DELAY_MS));
                }
              }
            }
            // Enviar E-00 solo si no se ha enviado aún
            const codeE00 = 'E-00';
            const msgE00 = set[codeE00];
            if (msgE00) {
              const dupE00 = await alreadySentToday(e164, codeE00);
              if (!dupE00) {
                anyMessage = true;
                if (DRY_RUN) {
                  console.log(`[DRY] ${e164} -> ${codeE00}: ${msgE00.slice(0, 60)}…`);
                  await appendLog(e164, codeE00, 'DRY');
                } else {
                  try {
                    await client.sendMessage(jid, msgE00.replace(/\{\{name\}\}/g, firstName(row.name)));
                    console.log(`📨 Enviado ${codeE00} a ${e164}`);
                    await appendLog(e164, codeE00, 'SENT');
                  } catch (err) {
                    console.error(`❌ Error enviando a ${e164}:`, err.message);
                    await appendLog(e164, codeE00, `ERROR: ${err.message}`);
                  }
                  await new Promise(r => setTimeout(r, SEND_DELAY_MS));
                }
              } else {
                console.log(`[SKIP] ${e164}: ya enviado hoy (${codeE00})`);
              }
            }
            // No continue aquí, para que también pueda enviar S-00 si corresponde
          }
          // Día de reserva: enviar todos los E-XX pendientes SOLO UNA VEZ cada uno
          if (row.reserve && today.getTime() === row.reserve.getTime()) {
            const set = pickTemplateSet(TEMPLATES, row.address);
            // Buscar todos los códigos E-XX válidos en la plantilla (solo E-30 a E-01, nunca E-00)
            const eCodes = Object.keys(set)
              .map(k => k.trim().toUpperCase())
              .filter(k => /^E-\d{2}$/.test(k))
              .map(k => ({
                code: k,
                num: parseInt(k.split('-')[1], 10)
              }))
              .filter(obj => obj.num >= 1 && obj.num <= 30)
              .sort((a, b) => b.num - a.num); // de mayor a menor

            // Calcular cuántos días faltan para la entrada desde hoy
            const diasHastaEntrada = daysBetween(row.entry, today);

            // Enviar todos los E-XX desde E-30 hasta el E-XX correspondiente a hoy (si existen y no enviados)
            for (const { code, num } of eCodes) {
              if (num > 30 || num < 1 || num < diasHastaEntrada) continue;
              const msg = set[code];
              if (!msg) continue;
              const dup = await alreadySentToday(e164, code);
              if (dup) {
                console.log(`[SKIP] ${e164}: ya enviado hoy (${code})`);
                continue;
              }
              anyMessage = true;
              if (DRY_RUN) {
                console.log(`[DRY] ${e164} -> ${code}: ${msg.slice(0, 60)}…`);
                await appendLog(e164, code, 'DRY');
              } else {
                try {
                  await client.sendMessage(jid, msg.replace(/\{\{name\}\}/g, firstName(row.name)));
                  console.log(`📨 Enviado ${code} a ${e164}`);
                  await appendLog(e164, code, 'SENT');
                  await new Promise(r => setTimeout(r, 60 * 1000)); // 1 min entre mensajes
                } catch (err) {
                  console.error(`❌ Error enviando a ${e164}:`, err.message);
                  await appendLog(e164, code, `ERROR: ${err.message}`);
                }
              }
            }
            continue; // saltar el resto del ciclo para este inquilino
          }

          // Lógica normal para otros días
          // Enviar ambos mensajes si aplican: E+XX y S-XX/S-00, primero E+XX y luego S-XX/S-00
          const set = pickTemplateSet(TEMPLATES, row.address);
          let codesToSend = [];

          // E+XX: entre entrada y salida
          if (row.entry && row.exit && today > row.entry && today < row.exit) {
            const diasDesdeEntrada = daysBetween(today, row.entry);
            const codeE = `E+${String(diasDesdeEntrada).padStart(2,'0')}`;
            if (set[codeE]) codesToSend.push({ code: codeE, message: set[codeE], tipo: 'E' });
          }

          // S-XX y S-00: desde 2 días antes de salida hasta salida
          if (row.exit) {
            const diasHastaSalida = daysBetween(row.exit, today);
            if (diasHastaSalida === 0 && set['S-00']) {
              codesToSend.push({ code: 'S-00', message: set['S-00'], tipo: 'S' });
            } else if (diasHastaSalida > 0 && diasHastaSalida <= 30) {
              const codeS = `S-${String(diasHastaSalida).padStart(2,'0')}`;
              if (set[codeS]) codesToSend.push({ code: codeS, message: set[codeS], tipo: 'S' });
            }
          }

          // S+XX: hasta 30 días después de la salida
          if (row.exit && today > row.exit) {
            const dAfter = daysBetween(today, row.exit); // 1..30
            if (dAfter > 0 && dAfter <= 30) {
              const codeSP = `S+${String(dAfter).padStart(2,'0')}`;
              if (set[codeSP]) {
                codesToSend.push({ code: codeSP, message: set[codeSP], tipo: 'S' });
              }
            }
            console.log(`[DEBUG] Post-salida: ${e164} -> dAfter=${dAfter}`);
          }

          // Si no hay códigos para hoy
          if (codesToSend.length === 0) {
            console.log(`[SKIP] ${e164}: no hay código para hoy o plantilla faltante`);
            continue;
          }

          // Ordenar: primero E, luego S
          codesToSend.sort((a, b) => {
            if (a.tipo === b.tipo) return 0;
            if (a.tipo === 'E') return -1;
            return 1;
          });

          // Enviar todos los códigos aplicables
          for (const plan of codesToSend) {
            const msgWithName = plan.message.replace(/\{\{name\}\}/g, firstName(row.name));
            const dup = await alreadySentToday(e164, plan.code);
            if (dup) {
              console.log(`[SKIP] ${e164}: ya enviado hoy (${plan.code})`);
              continue;
            }
            anyMessage = true;
            if (DRY_RUN) {
              console.log(`[DRY] ${e164} -> ${plan.code}: ${msgWithName.slice(0, 60)}…`);
              await appendLog(e164, plan.code, 'DRY');
            } else {
              try {
                await client.sendMessage(jid, msgWithName);
                console.log(`📨 Enviado ${plan.code} a ${e164}`);
                await appendLog(e164, plan.code, 'SENT');
              } catch (err) {
                console.error(`❌ Error enviando a ${e164}:`, err.message);
                await appendLog(e164, plan.code, `ERROR: ${err.message}`);
              }
              await new Promise(r => setTimeout(r, SEND_DELAY_MS));
            }
          }
        }
        // Calcular cuánto falta para las 12:59 (Europe/Madrid) del día siguiente
        const now = new Date();
        const tz = TZ || 'Europe/Madrid';
        const next = new Date(
          new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(now) + 'T12:59:00');
        // Si ya pasó hoy, poner mañana
        const nowInTZ = new Date(now.toLocaleString('en-US', { timeZone: tz }));
        if (nowInTZ >= next) {
          next.setUTCDate(next.getUTCDate() + 1);
        }
        const msToNext = next.getTime() - now.getTime();
        const horas = Math.floor(msToNext / (1000 * 60 * 60));
        const minutos = Math.floor((msToNext % (1000 * 60 * 60)) / (1000 * 60));
        if (!anyMessage) {
          console.log(`No hay mensajes para enviar hoy. Durmiendo hasta las 12:59 (faltan ${horas}h ${minutos}m)...`);
        } else {
          console.log(`Todos los mensajes del día enviados. Durmiendo hasta las 12:59 (faltan ${horas}h ${minutos}m)...`);
        }
        sleeping = true;
        setTimeout(() => {
          sleeping = false;
          console.log('Reanudando ciclo tras dormir hasta las 12:59.');
        }, msToNext);
      } catch (e) {
        console.error('Loop error:', e.message);
      }
    };

    await tick();
    setInterval(tick, LOOP_EVERY_MS);
  });

  client.on('disconnected', () => {
    isReady = false;
    console.log('Cliente WhatsApp desconectado. Esperando reconexión...');
  });

  client.initialize();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
