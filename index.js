const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.WSP_API_KEY || 'portal-viento-wsp-key';

// ── Estado global ──────────────────────────────────────────────
let estado = 'desconectado'; // desconectado | esperando_qr | conectado | error
let qrDataUrl = null;
let clienteWsp = null;
let colaEnvios = [];
let enviandoAhora = false;
let logCampana = [];

// ── Auth middleware ────────────────────────────────────────────
function auth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_KEY) return res.status(401).json({ error: 'No autorizado' });
    next();
}

// ── Inicializar cliente WhatsApp ───────────────────────────────
function iniciarCliente() {
    if (clienteWsp) {
        try { clienteWsp.destroy(); } catch(e) {}
    }
    estado = 'esperando_qr';
    qrDataUrl = null;

    clienteWsp = new Client({
        authStrategy: new LocalAuth({ dataPath: './wsp-session' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    clienteWsp.on('qr', async (qr) => {
        console.log('[WSP] QR recibido');
        estado = 'esperando_qr';
        try {
            qrDataUrl = await qrcode.toDataURL(qr);
        } catch(e) {
            console.error('[WSP] Error generando QR:', e);
        }
    });

    clienteWsp.on('ready', () => {
        console.log('[WSP] Cliente listo y conectado');
        estado = 'conectado';
        qrDataUrl = null;
    });

    clienteWsp.on('authenticated', () => {
        console.log('[WSP] Autenticado');
        estado = 'conectado';
    });

    clienteWsp.on('auth_failure', () => {
        console.log('[WSP] Fallo de autenticación');
        estado = 'error';
    });

    clienteWsp.on('disconnected', (reason) => {
        console.log('[WSP] Desconectado:', reason);
        estado = 'desconectado';
        clienteWsp = null;
    });

    clienteWsp.initialize();
}

// ── Helpers ────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatearNumero(tel) {
    // Eliminar todo lo que no sea dígito
    let num = String(tel).replace(/\D/g, '');
    // Si empieza con 0 (Argentina local), sacar el 0 y agregar 549
    if (num.startsWith('0')) num = num.slice(1);
    // Si ya tiene código de país 54
    if (num.startsWith('54')) {
        // Asegurar el 9 para móviles argentinos: 54 + 9 + área + número
        if (!num.startsWith('549')) num = '549' + num.slice(2);
    } else {
        // Asumir Argentina
        num = '549' + num;
    }
    return num + '@c.us';
}

// ── Procesador de cola ─────────────────────────────────────────
async function procesarCola() {
    if (enviandoAhora || !colaEnvios.length) return;
    if (estado !== 'conectado') return;

    enviandoAhora = true;
    console.log(`[WSP] Iniciando envío de ${colaEnvios.length} mensajes`);

    while (colaEnvios.length > 0) {
        const item = colaEnvios.shift();
        const { numero, mensaje, imagenBase64, campaniaId } = item;

        try {
            const chatId = formatearNumero(numero);
            if (imagenBase64) {
                const media = new MessageMedia('image/jpeg', imagenBase64, 'promo.jpg');
                await clienteWsp.sendMessage(chatId, media, { caption: mensaje });
            } else {
                await clienteWsp.sendMessage(chatId, mensaje);
            }
            console.log(`[WSP] ✓ Enviado a ${numero}`);
            logCampana.push({ numero, estado: 'enviado', ts: new Date().toISOString(), campaniaId });
        } catch(e) {
            console.error(`[WSP] ✗ Error enviando a ${numero}:`, e.message);
            logCampana.push({ numero, estado: 'error', error: e.message, ts: new Date().toISOString(), campaniaId });
        }

        // Delay aleatorio entre 8 y 20 segundos para evitar ban
        if (colaEnvios.length > 0) {
            const delay = 8000 + Math.random() * 12000;
            await sleep(delay);
        }
    }

    enviandoAhora = false;
    console.log('[WSP] Cola de envíos completada');
}

// ══ ENDPOINTS ══════════════════════════════════════════════════

// Estado del servicio
app.get('/status', auth, (req, res) => {
    res.json({
        estado,
        cola: colaEnvios.length,
        enviando: enviandoAhora,
        qr_disponible: !!qrDataUrl
    });
});

// QR para escanear
app.get('/qr', auth, (req, res) => {
    if (!qrDataUrl) {
        return res.json({ qr: null, estado, mensaje: estado === 'conectado' ? 'Ya conectado' : 'QR no disponible aún' });
    }
    res.json({ qr: qrDataUrl, estado });
});

// Conectar / reconectar
app.post('/conectar', auth, (req, res) => {
    iniciarCliente();
    res.json({ ok: true, mensaje: 'Iniciando conexión, esperá el QR' });
});

// Desconectar
app.post('/desconectar', auth, async (req, res) => {
    if (clienteWsp) {
        try { await clienteWsp.logout(); } catch(e) {}
        try { await clienteWsp.destroy(); } catch(e) {}
        clienteWsp = null;
    }
    estado = 'desconectado';
    res.json({ ok: true });
});

// Enviar campaña masiva
// Body: { campania_id, mensaje, imagen_base64 (opcional), destinatarios: [{numero, nombre}] }
app.post('/campania', auth, (req, res) => {
    if (estado !== 'conectado') {
        return res.status(400).json({ error: 'WhatsApp no conectado. Escaneá el QR primero.' });
    }
    const { campania_id, mensaje, imagen_base64, destinatarios } = req.body;
    if (!mensaje || !destinatarios?.length) {
        return res.status(400).json({ error: 'Faltan mensaje o destinatarios' });
    }

    // Limpiar log de esta campaña
    logCampana = logCampana.filter(l => l.campaniaId !== campania_id);

    // Encolar
    for (const d of destinatarios) {
        if (!d.numero) continue;
        colaEnvios.push({
            numero: d.numero,
            mensaje: mensaje.replace('{nombre}', d.nombre || ''),
            imagenBase64: imagen_base64 || null,
            campaniaId: campania_id
        });
    }

    // Lanzar procesamiento en background
    procesarCola();

    res.json({
        ok: true,
        encolados: destinatarios.length,
        mensaje: `${destinatarios.length} mensajes encolados. Delay ~8-20s entre cada uno.`
    });
});

// Estado de una campaña (resultados parciales/totales)
app.get('/campania/:id/log', auth, (req, res) => {
    const logs = logCampana.filter(l => l.campaniaId === req.params.id);
    const enviados = logs.filter(l => l.estado === 'enviado').length;
    const errores = logs.filter(l => l.estado === 'error').length;
    res.json({ logs, enviados, errores, pendientes: colaEnvios.filter(c => c.campaniaId === req.params.id).length });
});

// Envío único (para testing)
app.post('/enviar', auth, async (req, res) => {
    if (estado !== 'conectado') {
        return res.status(400).json({ error: 'WhatsApp no conectado' });
    }
    const { numero, mensaje } = req.body;
    try {
        const chatId = formatearNumero(numero);
        await clienteWsp.sendMessage(chatId, mensaje);
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Arranque ───────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[WSP] Servicio corriendo en puerto ${PORT}`);
    // Intentar reconectar si hay sesión guardada
    iniciarCliente();
});
