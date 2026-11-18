const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    jidNormalizedUser,
    proto,
    getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.options('*', cors());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.WSP_API_KEY || 'portal-viento-wsp-key';
const SESSION_DIR = process.env.SESSION_DIR || './wsp-session';
const LOG_FILE = path.join(SESSION_DIR, 'campania_logs.json');

// ── Estado global ──────────────────────────────────────────────
let estado = 'desconectado';
let ultimoError = null;
let qrDataUrl = null;
let sock = null;
let colaEnvios = [];
let enviandoAhora = false;
let mensajesEntrantes = []; // bandeja de respuestas (máx 500)
const MAX_MENSAJES = 500;

// ── Persistencia de logs ───────────────────────────────────────
function cargarLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const data = fs.readFileSync(LOG_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch(e) {
        console.error('[WSP] Error cargando logs:', e.message);
    }
    return [];
}

function guardarLogs() {
    try {
        // Mantener solo últimos 90 días para no crecer indefinidamente
        const limite = new Date();
        limite.setDate(limite.getDate() - 90);
        const logs = logCampana.filter(l => !l.ts || new Date(l.ts) > limite);
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs), 'utf8');
    } catch(e) {
        console.error('[WSP] Error guardando logs:', e.message);
    }
}

let logCampana = cargarLogs();
console.log(`[WSP] Logs cargados: ${logCampana.length} registros`);

// ── Manejo global de errores ───────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error('[WSP] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[WSP] uncaughtException:', err);
});

// ── Auth middleware ────────────────────────────────────────────
function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_KEY) return res.status(401).json({ error: 'No autorizado' });
    next();
}

// ── Helpers ────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatearNumero(tel) {
    let num = String(tel).replace(/\D/g, '');
    if (num.startsWith('0')) num = num.slice(1);
    if (num.startsWith('54')) {
        if (!num.startsWith('549')) num = '549' + num.slice(2);
    } else {
        num = '549' + num;
    }
    return num + '@s.whatsapp.net';
}

// ── Inicializar cliente Baileys ────────────────────────────────
async function iniciarCliente() {
    if (sock) {
        try { await sock.logout(); } catch(e) {}
        try { sock.end(); } catch(e) {}
        sock = null;
    }
    estado = 'esperando_qr';
    qrDataUrl = null;
    ultimoError = null;

    // Asegurar directorio de sesión
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Portal del Viento ERP', 'Chrome', '1.0.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        sock.ev.on('creds.update', saveCreds);

        // ── Mensajes entrantes ─────────────────────────────────
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message) continue;
                if (msg.key.fromMe) continue; // ignorar los que yo envié
                const jid = msg.key.remoteJid || '';
                if (jid.endsWith('@g.us')) continue; // ignorar grupos

                const numero = jid.replace('@s.whatsapp.net', '');
                const contenido = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || '[imagen/archivo]';

                const entrada = {
                    id: msg.key.id,
                    numero,
                    texto: contenido,
                    ts: new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
                    leido: false
                };
                console.log(`[WSP] ← Mensaje de ${numero}: ${contenido.slice(0, 60)}`);
                mensajesEntrantes.unshift(entrada);
                if (mensajesEntrantes.length > MAX_MENSAJES) mensajesEntrantes.pop();
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WSP] QR recibido');
                estado = 'esperando_qr';
                try {
                    qrDataUrl = await qrcode.toDataURL(qr);
                } catch(e) {
                    console.error('[WSP] Error generando QR:', e);
                }
            }

            if (connection === 'open') {
                console.log('[WSP] Conectado');
                estado = 'conectado';
                qrDataUrl = null;
                ultimoError = null;
                procesarCola();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('[WSP] Desconectado, código:', statusCode, 'reconectar:', shouldReconnect);

                if (shouldReconnect) {
                    estado = 'desconectado';
                    sock = null;
                    // Reconectar automáticamente en 3 segundos
                    setTimeout(iniciarCliente, 3000);
                } else {
                    // Sesión cerrada — borrar credenciales
                    estado = 'desconectado';
                    sock = null;
                    try {
                        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    } catch(e) {}
                    console.log('[WSP] Sesión cerrada (logout)');
                }
            }
        });

    } catch(e) {
        console.error('[WSP] Error iniciando:', e.message);
        estado = 'error';
        ultimoError = e.message;
    }
}

// ── Procesador de cola ─────────────────────────────────────────
async function procesarCola() {
    if (enviandoAhora || !colaEnvios.length) return;
    if (estado !== 'conectado') return;

    enviandoAhora = true;
    console.log(`[WSP] Iniciando envío de ${colaEnvios.length} mensajes`);

    try {
        while (colaEnvios.length > 0) {
            if (estado !== 'conectado') {
                console.log('[WSP] Conexión perdida, pausando cola. Quedan:', colaEnvios.length);
                break;
            }

            const item = colaEnvios.shift();
            const { numero, mensaje, imagenBase64, campaniaId } = item;

            try {
                const jid = formatearNumero(numero);
                if (imagenBase64) {
                    const buffer = Buffer.from(imagenBase64, 'base64');
                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: mensaje,
                        mimetype: 'image/jpeg'
                    });
                } else {
                    await sock.sendMessage(jid, { text: mensaje });
                }
                console.log(`[WSP] ✓ Enviado a ${numero}`);
                logCampana.push({ numero, estado: 'enviado', ts: new Date().toISOString(), campaniaId });
                guardarLogs();
            } catch(e) {
                console.error(`[WSP] ✗ Error enviando a ${numero}:`, e.message);
                logCampana.push({ numero, estado: 'error', error: e.message, ts: new Date().toISOString(), campaniaId });
                guardarLogs();
            }

            if (colaEnvios.length > 0) {
                const delay = 8000 + Math.random() * 12000;
                await sleep(delay);
            }
        }
    } finally {
        enviandoAhora = false;
        console.log('[WSP] Cola finalizada. Pendientes:', colaEnvios.length);
    }
}

// ══ ENDPOINTS ══════════════════════════════════════════════════

// Healthcheck sin auth
app.get('/', (req, res) => {
    res.json({ ok: true, servicio: 'wsp-service', estado });
});

// Estado
app.get('/status', auth, (req, res) => {
    res.json({
        estado,
        ultimoError,
        cola: colaEnvios.length,
        enviando: enviandoAhora,
        qr_disponible: !!qrDataUrl
    });
});

// QR
app.get('/qr', auth, (req, res) => {
    if (!qrDataUrl) {
        return res.json({
            qr: null,
            estado,
            mensaje: estado === 'conectado' ? 'Ya conectado' : 'QR no disponible aún'
        });
    }
    res.json({ qr: qrDataUrl, estado });
});

// Conectar
app.post('/conectar', auth, (req, res) => {
    iniciarCliente();
    res.json({ ok: true, mensaje: 'Iniciando conexión, esperá el QR' });
});

// Desconectar
app.post('/desconectar', auth, async (req, res) => {
    if (sock) {
        try { await sock.logout(); } catch(e) {}
        try { sock.end(); } catch(e) {}
        sock = null;
    }
    estado = 'desconectado';
    res.json({ ok: true });
});

// Campaña masiva
app.post('/campania', auth, (req, res) => {
    if (estado !== 'conectado') {
        return res.status(400).json({ error: 'WhatsApp no conectado. Escaneá el QR primero.' });
    }
    const { campania_id, mensaje, imagen_base64, destinatarios } = req.body;
    if (!mensaje || !destinatarios?.length) {
        return res.status(400).json({ error: 'Faltan mensaje o destinatarios' });
    }

    // Números que ya recibieron este mensaje exitosamente (anti-duplicado)
    const yaEnviados = new Set(
        logCampana
            .filter(l => l.campaniaId === campania_id && l.estado === 'enviado')
            .map(l => String(l.numero).replace(/\D/g, ''))
    );
    // También los que están en cola esperando (misma campaña)
    const enCola = new Set(
        colaEnvios
            .filter(c => c.campaniaId === campania_id)
            .map(c => String(c.numero).replace(/\D/g, ''))
    );

    let encolados = 0;
    let saltados = 0;
    for (const d of destinatarios) {
        if (!d.numero) continue;
        const numLimpio = String(d.numero).replace(/\D/g, '');
        if (yaEnviados.has(numLimpio) || enCola.has(numLimpio)) {
            saltados++;
            continue;
        }
        colaEnvios.push({
            numero: d.numero,
            mensaje: mensaje.replace(/\{nombre\}/g, d.nombre || ''),
            imagenBase64: imagen_base64 || null,
            campaniaId: campania_id
        });
        encolados++;
    }

    procesarCola();

    res.json({
        ok: true,
        encolados,
        saltados,
        mensaje: saltados > 0
            ? `${encolados} mensajes encolados. ${saltados} ya enviados anteriormente (omitidos).`
            : `${encolados} mensajes encolados. Delay ~8-20s entre cada uno.`
    });
});

// Log de campaña
app.get('/campania/:id/log', auth, (req, res) => {
    const logs = logCampana.filter(l => l.campaniaId === req.params.id);
    res.json({
        logs,
        enviados: logs.filter(l => l.estado === 'enviado').length,
        errores: logs.filter(l => l.estado === 'error').length,
        pendientes: colaEnvios.filter(c => c.campaniaId === req.params.id).length
    });
});

// Limpiar log de campaña (para poder reenviar a todos de cero)
app.delete('/campania/:id/log', auth, (req, res) => {
    const antes = logCampana.filter(l => l.campaniaId === req.params.id).length;
    logCampana = logCampana.filter(l => l.campaniaId !== req.params.id);
    guardarLogs();
    res.json({ ok: true, eliminados: antes });
});

// Detener cola de envíos
app.post('/detener', auth, (req, res) => {
    const pendientes = colaEnvios.length;
    colaEnvios = [];
    console.log(`[WSP] Cola detenida. Se descartaron ${pendientes} mensajes pendientes.`);
    res.json({ ok: true, descartados: pendientes });
});

// Bandeja de respuestas
app.get('/mensajes', auth, (req, res) => {
    const desde = req.query.desde ? new Date(req.query.desde) : null;
    const lista = desde
        ? mensajesEntrantes.filter(m => new Date(m.ts) > desde)
        : mensajesEntrantes.slice(0, 100);
    res.json({ mensajes: lista, total: mensajesEntrantes.length });
});

// Marcar como leído
app.post('/mensajes/:id/leido', auth, (req, res) => {
    const m = mensajesEntrantes.find(x => x.id === req.params.id);
    if (m) m.leido = true;
    res.json({ ok: true });
});

// Envío único (testing)
app.post('/enviar', auth, async (req, res) => {
    if (estado !== 'conectado') {
        return res.status(400).json({ error: 'WhatsApp no conectado' });
    }
    const { numero, mensaje } = req.body;
    try {
        const jid = formatearNumero(numero);
        await sock.sendMessage(jid, { text: mensaje });
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Arranque ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WSP] Servicio corriendo en puerto ${PORT}`);
    iniciarCliente();
});
