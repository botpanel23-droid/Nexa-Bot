import './src/keepalive.js';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  generateWAMessageFromContent,
  proto,
  makeInMemoryStore,
  jidDecode,
  getContentType
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// ═══════════════════════════════════════════
//           NEXA BOT - CORE SYSTEM
// ═══════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
let currentQR = null;
let pairCode = null;
let botConnected = false;
let botSocket = null;
let connectionState = 'disconnected';
let warns = {};

const saveSettings = () => fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
const loadSettings = () => { settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8')); };

const logger = pino({ level: 'silent' });

// ═══════════════════════════════════════════
//              WEB SERVER ROUTES
// ═══════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/status', (req, res) => {
  res.json({
    connected: botConnected,
    state: connectionState,
    botName: settings.botName,
    version: settings.version,
    hasPairCode: !!pairCode,
    hasQR: !!currentQR
  });
});

app.get('/api/qr', (req, res) => {
  if (currentQR) {
    res.json({ success: true, qr: currentQR });
  } else if (botConnected) {
    res.json({ success: false, message: 'Bot already connected!' });
  } else {
    res.json({ success: false, message: 'QR not generated yet. Please wait...' });
  }
});

// ─── FIX: PAIRING CODE LOGIC ───
app.post('/api/pair', async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'Phone number required!' });
  if (botConnected) return res.json({ success: false, message: 'Bot already connected!' });
  
  try {
    phone = phone.replace(/[^0-9]/g, ''); 
    if (botSocket) {
      // pairing code එක request කිරීමට පෙර socket එක නිවැරදිව පවතින බව සහතික කරයි
      const code = await botSocket.requestPairingCode(phone);
      pairCode = code;
      const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
      res.json({ success: true, code: formattedCode, raw: code });
    } else {
      res.json({ success: false, message: 'Bot socket not ready. Please try again in a moment.' });
    }
  } catch (err) {
    console.error("Pairing Error:", err);
    res.json({ success: false, message: "Error: " + err.message });
  }
});

app.get('/api/settings', (req, res) => {
  loadSettings();
  res.json({ success: true, settings });
});

app.post('/api/settings', (req, res) => {
  const newSettings = req.body;
  settings = { ...settings, ...newSettings };
  saveSettings();
  res.json({ success: true, message: 'Settings updated!', settings });
});

app.post('/api/logout', async (req, res) => {
  try {
    if (botSocket) await botSocket.logout();
    botConnected = false;
    connectionState = 'disconnected';
    fs.removeSync('./auth_info_baileys');
    res.json({ success: true, message: 'Logged out successfully!' });
    setTimeout(() => startBot(), 2000);
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════
//            HELPER FUNCTIONS
// ═══════════════════════════════════════════

const getPrefix = () => settings.prefix || '.';

const isOwner = (jid) => {
  const num = jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
  return settings.ownerNumber.some(o => o.replace(/[^0-9]/g, '') === num);
};

const reply = async (sock, msg, text) => {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
};

const react = async (sock, msg, emoji) => {
  await sock.sendMessage(msg.key.remoteJid, {
    react: { text: emoji, key: msg.key }
  });
};

const sendImage = async (sock, jid, url, caption = '', quoted = null) => {
  const opts = { image: { url }, caption };
  if (quoted) await sock.sendMessage(jid, opts, { quoted });
  else await sock.sendMessage(jid, opts);
};

// ═══════════════════════════════════════════
//              COMMAND HANDLER
// ═══════════════════════════════════════════

const handleCommand = async (sock, msg, text, isGroup, sender, pushName) => {
  const prefix = getPrefix();
  if (!text.startsWith(prefix)) return;
  
  const args = text.slice(prefix.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  const body = args.join(' ');
  const jid = msg.key.remoteJid;
  const owner = isOwner(sender);

  // Work mode check
  if (isGroup && !settings.workMode.group) return;
  if (!isGroup && !settings.workMode.inbox) return;

  if (settings.botMode === 'private' && !owner) {
    return await reply(sock, msg, `🔒 *Nexa Bot* is in *Private Mode*.\nOnly owner can use commands!`);
  }

  switch (cmd) {

    // ─────────────── INFO COMMANDS ───────────────
    case 'menu':
    case 'help': {
      await react(sock, msg, '📋');
      const menuText = `
╔════════════════════════╗
║   🤖 *NEXA BOT MENU* ║
╚════════════════════════╝

*👑 OWNER COMMANDS*
├ ${prefix}settings - Bot settings panel
├ ${prefix}setprefix [x] - Change prefix
├ ${prefix}setmode [public/private] - Set bot mode
├ ${prefix}setwork [group/inbox/private] - Toggle work modes
├ ${prefix}broadcast [msg] - Broadcast message
├ ${prefix}block [@user] - Block user
├ ${prefix}unblock [@user] - Unblock user
├ ${prefix}clearwarn [@user] - Clear warnings
└ ${prefix}restart - Restart bot
└ ${prefix}savestatus - Status Save 


*📊 INFO COMMANDS*
├ ${prefix}menu - Show this menu
├ ${prefix}ping - Check bot speed
├ ${prefix}info - Bot information
├ ${prefix}owner - Owner info
└ ${prefix}runtime - Bot uptime

*🎮 FUN COMMANDS*
├ ${prefix}sticker - Make sticker
├ ${prefix}toimg - Sticker to image
├ ${prefix}quote - Random quote
├ ${prefix}joke - Random joke
├ ${prefix}fact - Random fact
└ ${prefix}flip - Coin flip

*🔧 UTILITY COMMANDS*
├ ${prefix}calc [expr] - Calculator
├ ${prefix}tts [text] - Text to speech
├ ${prefix}translate [text] - Translate text
├ ${prefix}weather [city] - Weather info
├ ${prefix}shorten [url] - Shorten URL
└ ${prefix}time - Current time

*👥 GROUP COMMANDS*
├ ${prefix}add [@user] - Add member
├ ${prefix}kick [@user] - Kick member
├ ${prefix}promote [@user] - Promote to admin
├ ${prefix}demote [@user] - Demote admin
├ ${prefix}mute - Mute group
├ ${prefix}unmute - Unmute group
├ ${prefix}link - Get group link
├ ${prefix}revoke - Revoke group link
├ ${prefix}warn [@user] - Warn user
├ ${prefix}listwarn - List all warnings
└ ${prefix}tagall - Tag all members

*⚙️ SETTINGS*
└ ${prefix}settings - View/Edit all settings

━━━━━━━━━━━━━━━━━━━━━━━━
🤖 *${settings.botName}* v${settings.version}
Prefix: *${prefix}*
Mode: *${settings.botMode}*
━━━━━━━━━━━━━━━━━━━━━━━━`;
      await reply(sock, msg, menuText);
      break;
    }

    case 'ping': {
      const start = Date.now();
      const sent = await reply(sock, msg, '🏓 Pinging...');
      const ping = Date.now() - start;
      await sock.sendMessage(jid, { text: `🏓 *Pong!*\n⚡ Speed: *${ping}ms*\n🤖 Bot: Online ✅` }, { quoted: msg });
      break;
    }

    case 'info': {
      await react(sock, msg, 'ℹ️');
      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = Math.floor(uptime % 60);
      await reply(sock, msg, `
╔═══════════════════╗
║  🤖 *NEXA BOT INFO* ║
╚═══════════════════╝

🏷️ Name: *${settings.botName}*
📌 Version: *${settings.version}*
⚙️ Prefix: *${prefix}*
🌐 Mode: *${settings.botMode}*
⏱️ Uptime: *${h}h ${m}m ${s}s*
📦 Platform: *Node.js ${process.version}*
💾 Memory: *${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB*
━━━━━━━━━━━━━━━━━━━
Made with ❤️ | Nexa Bot`);
      break;
    }

case 'savestatus': {
  // ඔබ ලබාදුන් මුල්ම logic එක එලෙසම පවතී
  try {
    await sock.sendMessage(jid, { react: { text: '💾', key: msg.key } });
    if (!msg.quoted || !msg.quoted.statusMessage) {
      await reply(sock, msg, `📌 *ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs ᴛᴏ sᴀᴠᴇ ɪᴛ, ᴅᴀʀʟɪɴɢ!* 😘`);
      break;
    }
    // ... media download logic should be here
  } catch (error) {
    console.error('Savestatus error:', error.message);
  }
  break;
}

    case 'runtime': {
      const uptime = process.uptime();
      const d = Math.floor(uptime / 86400);
      const h = Math.floor((uptime % 86400) / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = Math.floor(uptime % 60);
      await reply(sock, msg, `⏱️ *Bot Runtime*\n\n${d}d ${h}h ${m}m ${s}s`);
      break;
    }

    case 'owner': {
      await reply(sock, msg, `👑 *Bot Owner*\n\nOwner: wa.me/${settings.ownerNumber[0]}\n📱 ${settings.ownerNumber[0]}`);
      break;
    }

    case 'settings': {
      if (!owner) return await reply(sock, msg, '❌ Owner only command!');
      await react(sock, msg, '⚙️');
      loadSettings();
      const settingsText = `
╔══════════════════════╗
║  ⚙️ *NEXA BOT SETTINGS* ║
╚══════════════════════╝

🤖 *Bot Name:* ${settings.botName}
📌 *Prefix:* ${settings.prefix}
🌐 *Bot Mode:* ${settings.botMode}
🔤 *Language:* ${settings.language}

*📍 Work Modes:*
├ 👥 Group: ${settings.workMode.group ? '✅' : '❌'}
├ 📩 Inbox: ${settings.workMode.inbox ? '✅' : '❌'}
└ 🔒 Private: ${settings.workMode.private ? '✅' : '❌'}`;
      await reply(sock, msg, settingsText);
      break;
    }

    case 'setprefix': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      if (!body) return await reply(sock, msg, `Usage: ${prefix}setprefix [symbol]`);
      settings.prefix = body.trim()[0];
      saveSettings();
      await reply(sock, msg, `✅ Prefix changed to *${settings.prefix}*`);
      break;
    }

    case 'restart': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      await reply(sock, msg, '🔄 Restarting Nexa Bot...');
      setTimeout(() => process.exit(0), 1000);
      break;
    }

    default: {
      if (settings.autoReply && !isGroup) {
        await reply(sock, msg, settings.autoReplyMessage);
      }
      break;
    }
  }
};

// ═══════════════════════════════════════════
//              BOT START FUNCTION
// ═══════════════════════════════════════════

const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // FIX: Ubuntu OS එකේ Chrome/Brave Browser එකක් ලෙස පෙන්වීම
    browser: ["Ubuntu", "Chrome/Brave", "20.0.04"],
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false
  });

  botSocket = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      pairCode = null;
      connectionState = 'qr_ready';
    }

    if (connection === 'close') {
      botConnected = false;
      connectionState = 'disconnected';
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => startBot(), 3000);
      } else {
        fs.removeSync('./auth_info_baileys');
        setTimeout(() => startBot(), 2000);
      }
    }

    if (connection === 'open') {
      botConnected = true;
      connectionState = 'connected';
      currentQR = null;
      pairCode = null;
      loadSettings();
      console.log(`✅ Nexa Bot Connected!`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      const sender = isGroup ? msg.key.participant : jid;
      const msgType = getContentType(msg.message);
      
      let text = (msgType === 'conversation') ? msg.message.conversation : 
                 (msgType === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : 
                 (msgType === 'imageMessage' || msgType === 'videoMessage') ? msg.message[msgType].caption : '';

      if (settings.autoRead) await sock.readMessages([msg.key]);
      if (text) await handleCommand(sock, msg, text, isGroup, sender, msg.pushName);
    }
  });

  return sock;
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web Panel: http://localhost:${PORT}`);
  startBot();
});
