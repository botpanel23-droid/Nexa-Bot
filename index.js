// ═══════════════════════════════════════════════
//           ⚡ NEXA BOT - FULL FIXED VERSION
//  Fixes: ESM→CJS, missing deps, socket errors,
//  warns undefined, settings mismatch, pair code,
//  QR web support, channel auto-join/react, all bugs
// ═══════════════════════════════════════════════

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  getContentType,
  downloadContentFromMessage,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const pino       = require('pino');
const express    = require('express');
const cors       = require('cors');
const QRCode     = require('qrcode');
const fs         = require('fs-extra');
const path       = require('path');
const axios      = require('axios');
const bodyParser = require('body-parser');

// ═══════════════════════════════════════════════
//                  SETUP
// ═══════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const logger = pino({ level: 'silent' });

// FIX: Ensure settings.json exists with all required keys
const DEFAULT_SETTINGS = {
  botName:          'Nexa Bot',
  prefix:           '.',
  ownerNumber:      ['94742271802'],
  botNumber:        '',
  language:         'si',
  timezone:         'Asia/Colombo',
  version:          '1.0.0',
  botMode:          'public',          // FIX: was missing
  workMode:         { group: true, inbox: true, private: true }, // FIX: was missing
  autoRead:         true,
  autoTyping:       true,
  autoRecording:    false,
  autoReply:        false,
  autoReplyMessage: 'I am busy right now.',
  welcomeMessage:   true,
  goodbyeMessage:   true,
  antiSpam:         true,
  antiLink:         false,
  antiDelete:       false,
  autoStatus:       false,
  maxWarn:          3,
  spamThreshold:    5,
  spamTime:         10,
  channelJid:       '120363405932644483@newsletter',
  autoJoinChannel:  true,
  autoReactChannel: true,
  thumbnail:        'https://files.catbox.moe/1zj41k.png',
  footer:           '⚡ Powered by Nexa Bot',
  themeColor:       '#00D4FF'
};

if (!fs.existsSync('./settings.json')) {
  fs.writeJsonSync('./settings.json', DEFAULT_SETTINGS, { spaces: 2 });
}

// FIX: Merge existing settings with defaults to fill any missing keys
let rawSettings = {};
try { rawSettings = fs.readJsonSync('./settings.json'); } catch(e) {}
let settings = Object.assign({}, DEFAULT_SETTINGS, rawSettings);
// Ensure nested workMode exists
if (!settings.workMode) settings.workMode = { group: true, inbox: true, private: true };
fs.writeJsonSync('./settings.json', settings, { spaces: 2 });

const saveSettings = () => fs.writeJsonSync('./settings.json', settings, { spaces: 2 });
const loadSettings = () => {
  try {
    const raw = fs.readJsonSync('./settings.json');
    settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    if (!settings.workMode) settings.workMode = { group: true, inbox: true, private: true };
  } catch(e) { console.error('Settings load error:', e.message); }
};

// ═══════════════════════════════════════════════
//              STATE VARIABLES
// ═══════════════════════════════════════════════

let botSocket     = null;
let botConnected  = false;
let currentQR     = null;
let pairCodeCache = null;
let botStartTime  = Date.now();

// FIX: warns was used but never declared
const warns       = {};

// FIX: spam tracker
const spamTracker = {};

// ═══════════════════════════════════════════════
//              HELPER FUNCTIONS
// ═══════════════════════════════════════════════

const getPrefix = () => settings.prefix || '.';

// FIX: isOwner now handles both settings.ownerNumber formats
const isOwner = (jid) => {
  const num = jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
  const owners = Array.isArray(settings.ownerNumber) ? settings.ownerNumber : [settings.ownerNumber];
  return owners.some(o => String(o).replace(/[^0-9]/g, '') === num);
};

// FIX: reply() - removed incorrect 4th param usage throughout
const reply = async (sock, msg, text) => {
  try {
    await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
  } catch (e) {
    console.error('reply() error:', e.message);
  }
};

const react = async (sock, msg, emoji) => {
  try {
    await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
  } catch (e) {}
};

// FIX: safe media download using baileys downloadContentFromMessage
const downloadMedia = async (message) => {
  try {
    const type = getContentType(message);
    if (!type) return null;
    const mediaType = type.replace('Message', '');
    const stream = await downloadContentFromMessage(message[type], mediaType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
  } catch (e) {
    console.error('downloadMedia error:', e.message);
    return null;
  }
};

const formatUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${d}d ${h}h ${m}m ${sec}s`;
};

// Channel forward context builder
const channelCtx = () => ({
  forwardingScore: 1,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: settings.channelJid,
    newsletterName: settings.botName,
    serverMessageId: Math.floor(Math.random() * 9999)
  }
});

// ═══════════════════════════════════════════════
//              COMMAND HANDLER
// ═══════════════════════════════════════════════

const handleCommand = async (sock, msg, text, isGroup, sender) => {
  const prefix = getPrefix();
  if (!text || !text.startsWith(prefix)) return;

  const parts = text.slice(prefix.length).trim().split(/\s+/);
  const cmd   = parts.shift().toLowerCase();
  const args  = parts;
  const body  = args.join(' ');
  const jid   = msg.key.remoteJid;
  const owner = isOwner(sender);

  // Work mode check
  if (isGroup && !settings.workMode.group) return;
  if (!isGroup && !settings.workMode.inbox) return;

  if (settings.botMode === 'private' && !owner) {
    return await reply(sock, msg, `🔒 *${settings.botName}* is in *Private Mode*.\nOnly owner can use commands!`);
  }

  // ─── ANTI-SPAM ──────────────────────────────
  if (settings.antiSpam && !owner) {
    const now = Date.now();
    if (!spamTracker[sender]) spamTracker[sender] = [];
    spamTracker[sender] = spamTracker[sender].filter(t => now - t < (settings.spamTime || 10) * 1000);
    spamTracker[sender].push(now);
    if (spamTracker[sender].length > (settings.spamThreshold || 5)) {
      return await reply(sock, msg, '⚠️ *Slow down!* You are sending commands too fast.');
    }
  }

  switch (cmd) {

    // ─── MENU ──────────────────────────────────
    case 'menu':
    case 'help': {
      await react(sock, msg, '📋');
      const p = prefix;
      const menuText = `
╔════════════════════════╗
║   🤖 *${settings.botName} MENU*   ║
╚════════════════════════╝

*📊 INFO COMMANDS*
├ ${p}menu - Show this menu
├ ${p}ping - Check bot speed
├ ${p}info - Bot information
├ ${p}owner - Owner info
└ ${p}runtime - Bot uptime

*🎮 FUN COMMANDS*
├ ${p}quote - Random quote
├ ${p}joke - Random joke
├ ${p}fact - Random fact
└ ${p}flip - Coin flip

*🔧 UTILITY*
├ ${p}calc [expr] - Calculator
├ ${p}time - Current time
├ ${p}weather [city] - Weather
└ ${p}shorten [url] - Short URL

*👥 GROUP COMMANDS*
├ ${p}tagall - Tag all members
├ ${p}add [number] - Add member
├ ${p}kick @user - Kick member
├ ${p}promote @user - Make admin
├ ${p}demote @user - Remove admin
├ ${p}mute / ${p}unmute - Group lock
├ ${p}link - Get invite link
├ ${p}revoke - Reset link
├ ${p}warn @user - Warn member
├ ${p}listwarn - List warnings
└ ${p}clearwarn @user - Clear warns

*👑 OWNER ONLY*
├ ${p}settings - View settings
├ ${p}setprefix [x] - Change prefix
├ ${p}setmode [public/private]
├ ${p}setwork [group/inbox] [on/off]
├ ${p}toggle [feature] - Toggle feature
├ ${p}broadcast [msg] - Broadcast
├ ${p}block / ${p}unblock @user
└ ${p}restart - Restart bot

━━━━━━━━━━━━━━━━━━━━━━━━
🤖 *${settings.botName}* v${settings.version}
Prefix: *${p}* | Mode: *${settings.botMode}*
━━━━━━━━━━━━━━━━━━━━━━━━`;
      await reply(sock, msg, menuText);
      break;
    }

    // ─── PING ───────────────────────────────────
    case 'ping': {
      const start = Date.now();
      await reply(sock, msg, '🏓 Pinging...');
      const ms = Date.now() - start;
      await sock.sendMessage(jid, {
        text: `🏓 *Pong!*\n⚡ Speed: *${ms}ms*\n🤖 Status: Online ✅`,
        contextInfo: channelCtx()
      }, { quoted: msg });
      break;
    }

    // ─── INFO ───────────────────────────────────
    case 'info': {
      await react(sock, msg, 'ℹ️');
      await reply(sock, msg, `
╔═══════════════════╗
║  🤖 *${settings.botName} INFO*  ║
╚═══════════════════╝

🏷️ Name: *${settings.botName}*
📌 Version: *${settings.version}*
⚙️ Prefix: *${getPrefix()}*
🌐 Mode: *${settings.botMode}*
⏱️ Uptime: *${formatUptime(Date.now() - botStartTime)}*
📦 Platform: *Node.js ${process.version}*
💾 Memory: *${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB*
━━━━━━━━━━━━━━━━━━━
${settings.footer}`);
      break;
    }

    // ─── RUNTIME ────────────────────────────────
    case 'runtime': {
      await reply(sock, msg, `⏱️ *Bot Runtime*\n\n${formatUptime(Date.now() - botStartTime)}`);
      break;
    }

    // ─── OWNER ──────────────────────────────────
    case 'owner': {
      const ownerNums = Array.isArray(settings.ownerNumber) ? settings.ownerNumber : [settings.ownerNumber];
      await reply(sock, msg, `👑 *Bot Owner*\n\nOwner: wa.me/${ownerNums[0]}\n📱 ${ownerNums[0]}`);
      break;
    }

    // ─── SETTINGS ───────────────────────────────
    case 'settings': {
      if (!owner) return await reply(sock, msg, '❌ Owner only command!');
      await react(sock, msg, '⚙️');
      loadSettings();
      const p = prefix;
      await reply(sock, msg, `
╔══════════════════════╗
║  ⚙️ *${settings.botName} SETTINGS*  ║
╚══════════════════════╝

🤖 *Bot Name:* ${settings.botName}
📌 *Prefix:* ${settings.prefix}
🌐 *Bot Mode:* ${settings.botMode}
🔤 *Language:* ${settings.language}

*📍 Work Modes:*
├ 👥 Group: ${settings.workMode?.group ? '✅' : '❌'}
├ 📩 Inbox: ${settings.workMode?.inbox ? '✅' : '❌'}
└ 🔒 Private: ${settings.workMode?.private ? '✅' : '❌'}

*🔧 Auto Features:*
├ 📖 Auto Read: ${settings.autoRead ? '✅' : '❌'}
├ ⌨️ Auto Typing: ${settings.autoTyping ? '✅' : '❌'}
├ 🎤 Auto Recording: ${settings.autoRecording ? '✅' : '❌'}
├ 💬 Auto Reply: ${settings.autoReply ? '✅' : '❌'}
├ 🛡️ Anti Delete: ${settings.antiDelete ? '✅' : '❌'}
├ 🔗 Anti Link: ${settings.antiLink ? '✅' : '❌'}
└ 🚫 Anti Spam: ${settings.antiSpam ? '✅' : '❌'}

*👥 Group Features:*
├ 👋 Welcome: ${settings.welcomeMessage ? '✅' : '❌'}
└ 👋 Goodbye: ${settings.goodbyeMessage ? '✅' : '❌'}

━━━━━━━━━━━━━━━━━━━━━━
${p}setmode [public/private]
${p}setprefix [symbol]
${p}toggle [feature]`);
      break;
    }

    case 'setprefix': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      if (!body) return await reply(sock, msg, `Usage: ${prefix}setprefix [symbol]`);
      const oldPrefix = settings.prefix;
      settings.prefix = body.trim()[0];
      saveSettings();
      await reply(sock, msg, `✅ Prefix changed: *${oldPrefix}* → *${settings.prefix}*`);
      break;
    }

    case 'setmode': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mode = body.toLowerCase();
      if (!['public', 'private'].includes(mode)) return await reply(sock, msg, `Usage: ${prefix}setmode [public/private]`);
      settings.botMode = mode;
      saveSettings();
      await reply(sock, msg, `✅ Bot mode set to *${mode}*`);
      break;
    }

    case 'setwork': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const [workType, status] = args;
      if (!workType || !status) return await reply(sock, msg, `Usage: ${prefix}setwork [group/inbox/private] [on/off]`);
      if (!['group', 'inbox', 'private'].includes(workType.toLowerCase())) {
        return await reply(sock, msg, '❌ Use: group / inbox / private');
      }
      if (!settings.workMode) settings.workMode = { group: true, inbox: true, private: true };
      settings.workMode[workType.toLowerCase()] = status.toLowerCase() === 'on';
      saveSettings();
      await reply(sock, msg, `✅ *${workType}*: ${settings.workMode[workType.toLowerCase()] ? '✅ ON' : '❌ OFF'}`);
      break;
    }

    case 'toggle': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const feature = body.toLowerCase();
      const toggleMap = {
        'autoread':      'autoRead',
        'autotyping':    'autoTyping',
        'autorecording': 'autoRecording',
        'antidelete':    'antiDelete',
        'antilink':      'antiLink',
        'antispam':      'antiSpam',
        'autoreply':     'autoReply',
        'autostatus':    'autoStatus',
        'welcome':       'welcomeMessage',
        'goodbye':       'goodbyeMessage',
        'autochannel':   'autoJoinChannel',
        'autoreact':     'autoReactChannel',
      };
      if (!toggleMap[feature]) {
        return await reply(sock, msg, `❌ Available: ${Object.keys(toggleMap).join(', ')}`);
      }
      const key = toggleMap[feature];
      settings[key] = !settings[key];
      saveSettings();
      await reply(sock, msg, `✅ *${feature}*: ${settings[key] ? '✅ ON' : '❌ OFF'}`);
      break;
    }

    case 'setautoreply': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      if (!body) return await reply(sock, msg, `Usage: ${prefix}setautoreply [message]`);
      settings.autoReplyMessage = body;
      saveSettings();
      await reply(sock, msg, `✅ Auto reply message updated!`);
      break;
    }

    // ─── FUN ────────────────────────────────────
    case 'quote': {
      await react(sock, msg, '💬');
      const quotes = [
        'The only way to do great work is to love what you do. — Steve Jobs',
        'In the middle of every difficulty lies opportunity. — Einstein',
        'Life is what happens when you\'re busy making other plans. — Lennon',
        'The future belongs to those who believe in their dreams. — Roosevelt',
        'Spread love everywhere you go. — Mother Teresa',
        'It is during our darkest moments we must focus to see the light. — Aristotle'
      ];
      await reply(sock, msg, `💬 *Quote*\n\n_"${quotes[Math.floor(Math.random() * quotes.length)]}"_`);
      break;
    }

    case 'joke': {
      await react(sock, msg, '😂');
      const jokes = [
        "Why don't scientists trust atoms? Because they make up everything! 😂",
        "I told my wife she was drawing her eyebrows too high. She looked surprised! 😄",
        "Why did the scarecrow win an award? He was outstanding in his field! 🌾",
        "I used to hate facial hair but then it grew on me! 😆",
        "Why did the bicycle fall over? Because it was two-tired! 🚲",
        "What do you call a fake noodle? An Impasta! 🍝"
      ];
      await reply(sock, msg, `😂 *Joke*\n\n${jokes[Math.floor(Math.random() * jokes.length)]}`);
      break;
    }

    case 'fact': {
      await react(sock, msg, '🧠');
      const facts = [
        '🐙 Octopuses have three hearts and blue blood!',
        '🍯 Honey never expires — archaeologists found 3000-year-old honey!',
        '🌙 The Moon is moving away from Earth at ~3.8 cm per year.',
        '🦋 Butterflies taste with their feet!',
        '🐘 Elephants are the only animals that can\'t jump!',
        '⚡ Lightning strikes Earth about 100 times per second!'
      ];
      await reply(sock, msg, `🧠 *Fact*\n\n${facts[Math.floor(Math.random() * facts.length)]}`);
      break;
    }

    case 'flip': {
      await react(sock, msg, '🪙');
      await reply(sock, msg, `🪙 *Coin Flip:* ${Math.random() < 0.5 ? '🦅 Heads' : '🦁 Tails'}`);
      break;
    }

    case 'calc': {
      if (!body) return await reply(sock, msg, `Usage: ${prefix}calc [expr]\nExample: ${prefix}calc 2+2*5`);
      try {
        const sanitized = body.replace(/[^0-9+\-*/.()%\s]/g, '');
        // FIX: safe eval using Function
        const result = Function(`'use strict'; return (${sanitized})`)();
        await reply(sock, msg, `🧮 *Calculator*\n\n📥 ${body}\n📤 Result: *${result}*`);
      } catch (e) {
        await reply(sock, msg, `❌ Invalid expression!`);
      }
      break;
    }

    case 'time': {
      const now = new Date().toLocaleString('en-US', {
        timeZone: settings.timezone || 'Asia/Colombo',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
      });
      await reply(sock, msg, `🕐 *Current Time*\n\n${now}`);
      break;
    }

    case 'weather': {
      if (!body) return await reply(sock, msg, `Usage: ${prefix}weather [city]`);
      try {
        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(body)}&appid=2d61a72574c11c4f36173b627f8cb177&units=metric`, { timeout: 8000 });
        const d = res.data;
        await reply(sock, msg, `🌍 *${d.name}, ${d.sys.country}*\n🌡️ Temp: ${d.main.temp}°C (feels ${d.main.feels_like}°C)\n☁️ ${d.weather[0].description}\n💨 Wind: ${d.wind.speed} m/s\n💧 Humidity: ${d.main.humidity}%\n\n${settings.footer}`);
      } catch (e) {
        await reply(sock, msg, `❌ City not found or weather API error.`);
      }
      break;
    }

    case 'shorten': {
      if (!body) return await reply(sock, msg, `Usage: ${prefix}shorten [url]`);
      try {
        const res = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(body)}`, { timeout: 5000 });
        await reply(sock, msg, `🔗 *Short URL*\n\n${res.data.trim()}`);
      } catch (e) {
        await reply(sock, msg, `❌ URL shortening failed.`);
      }
      break;
    }

    // ─── SAVESTATUS (FIX: was using wrong var `socket` instead of `sock`) ──
    case 'savestatus': {
      await react(sock, msg, '💾');
      try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) {
          return await reply(sock, msg, `📌 Reply to a status to save it!`);
        }
        const buf = await downloadMedia(quotedMsg);
        if (!buf) return await reply(sock, msg, `❌ Failed to download status media.`);
        const imgMsg  = quotedMsg.imageMessage;
        const vidMsg  = quotedMsg.videoMessage;
        const ext     = imgMsg ? 'jpg' : 'mp4';
        const mime    = imgMsg ? 'image/jpeg' : 'video/mp4';
        const fname   = `status_${Date.now()}.${ext}`;
        await sock.sendMessage(jid, {
          document: buf,
          mimetype: mime,
          fileName: fname,
          caption: `✅ Status saved!\n${settings.footer}`
        }, { quoted: msg });
      } catch (e) {
        console.error('savestatus error:', e.message);
        await reply(sock, msg, `❌ Couldn't save status. Try again.`);
      }
      break;
    }

    // ─── STICKER ────────────────────────────────
    case 'sticker': {
      await react(sock, msg, '🎨');
      try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) return await reply(sock, msg, `❌ Reply to an image with ${prefix}sticker`);
        const buf = await downloadMedia(quotedMsg);
        if (!buf) return await reply(sock, msg, `❌ Couldn't download image.`);
        await sock.sendMessage(jid, { sticker: buf }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Sticker creation failed: ${e.message}`);
      }
      break;
    }

    // ─── GROUP COMMANDS ──────────────────────────
    case 'tagall': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      try {
        const meta    = await sock.groupMetadata(jid);
        const members = meta.participants;
        const mentions = members.map(m => m.id);
        let text = `📢 *Tag All*\n\n${body ? body + '\n\n' : ''}`;
        members.forEach((m, i) => {
          text += `@${m.id.split('@')[0]} `;
          if ((i + 1) % 10 === 0) text += '\n';
        });
        await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'add': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const numToAdd = body.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      if (!numToAdd.length > 12) return await reply(sock, msg, `Usage: ${prefix}add [number]`);
      try {
        await sock.groupParticipantsUpdate(jid, [numToAdd], 'add');
        await reply(sock, msg, `✅ Added @${numToAdd.split('@')[0]}`);
      } catch (e) {
        await reply(sock, msg, `❌ Add failed: ${e.message}`);
      }
      break;
    }

    case 'kick': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) return await reply(sock, msg, `Usage: ${prefix}kick @user`);
      try {
        await sock.groupParticipantsUpdate(jid, [mentioned[0]], 'remove');
        await sock.sendMessage(jid, { text: `✅ Kicked @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Kick failed: ${e.message}`);
      }
      break;
    }

    case 'promote': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) return await reply(sock, msg, `Usage: ${prefix}promote @user`);
      try {
        await sock.groupParticipantsUpdate(jid, [mentioned[0]], 'promote');
        await sock.sendMessage(jid, { text: `✅ Promoted @${mentioned[0].split('@')[0]} to admin!`, mentions: [mentioned[0]] }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'demote': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) return await reply(sock, msg, `Usage: ${prefix}demote @user`);
      try {
        await sock.groupParticipantsUpdate(jid, [mentioned[0]], 'demote');
        await sock.sendMessage(jid, { text: `✅ Demoted @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'mute': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      try {
        await sock.groupSettingUpdate(jid, 'announcement');
        await reply(sock, msg, '🔇 Group muted! Only admins can send messages.');
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'unmute': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      try {
        await sock.groupSettingUpdate(jid, 'not_announcement');
        await reply(sock, msg, '🔊 Group unmuted! Everyone can send messages.');
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'link': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      try {
        const code = await sock.groupInviteCode(jid);
        await reply(sock, msg, `🔗 *Group Link:*\nhttps://chat.whatsapp.com/${code}`);
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'revoke': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      try {
        await sock.groupRevokeInvite(jid);
        const newCode = await sock.groupInviteCode(jid);
        await reply(sock, msg, `✅ Link revoked!\n🔗 New: https://chat.whatsapp.com/${newCode}`);
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    // FIX: warns was undefined — now declared at top
    case 'warn': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) return await reply(sock, msg, `Usage: ${prefix}warn @user`);
      const warnJid = mentioned[0];
      if (!warns[jid]) warns[jid] = {};
      warns[jid][warnJid] = (warns[jid][warnJid] || 0) + 1;
      const warnCount = warns[jid][warnJid];
      await sock.sendMessage(jid, {
        text: `⚠️ *Warning!*\n@${warnJid.split('@')[0]} warned!\nWarnings: ${warnCount}/${settings.maxWarn}`,
        mentions: [warnJid]
      }, { quoted: msg });
      if (warnCount >= settings.maxWarn) {
        try {
          await sock.groupParticipantsUpdate(jid, [warnJid], 'remove');
          warns[jid][warnJid] = 0;
          await sock.sendMessage(jid, {
            text: `🚫 @${warnJid.split('@')[0]} kicked for reaching max warnings!`,
            mentions: [warnJid]
          }, { quoted: msg });
        } catch (e) {}
      }
      break;
    }

    case 'listwarn': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only!');
      if (!warns[jid] || Object.keys(warns[jid]).length === 0) {
        return await reply(sock, msg, '✅ No warnings in this group!');
      }
      let warnList = `⚠️ *Warning List*\n\n`;
      for (const [wJid, count] of Object.entries(warns[jid])) {
        warnList += `@${wJid.split('@')[0]}: ${count}/${settings.maxWarn}\n`;
      }
      await sock.sendMessage(jid, { text: warnList, mentions: Object.keys(warns[jid]) }, { quoted: msg });
      break;
    }

    case 'clearwarn': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) {
        if (isGroup) {
          warns[jid] = {};
          return await reply(sock, msg, '✅ All warnings cleared!');
        }
        return await reply(sock, msg, `Usage: ${prefix}clearwarn @user`);
      }
      if (warns[jid]) warns[jid][mentioned[0]] = 0;
      await sock.sendMessage(jid, { text: `✅ Warnings cleared for @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
      break;
    }

    // ─── OWNER COMMANDS ─────────────────────────
    case 'broadcast': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      if (!body) return await reply(sock, msg, `Usage: ${prefix}broadcast [message]`);
      await reply(sock, msg, `📡 Broadcasting...`);
      try {
        const chats = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const chatId of Object.keys(chats)) {
          try {
            await sock.sendMessage(chatId, { text: `📢 *Broadcast from ${settings.botName}*\n\n${body}` });
            count++;
            await new Promise(r => setTimeout(r, 1000));
          } catch (e) {}
        }
        await reply(sock, msg, `✅ Sent to *${count}* groups!`);
      } catch (e) {
        await reply(sock, msg, `❌ Broadcast error: ${e.message}`);
      }
      break;
    }

    case 'block': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) return await reply(sock, msg, `Usage: ${prefix}block @user`);
      try {
        await sock.updateBlockStatus(mentioned[0], 'block');
        await sock.sendMessage(jid, { text: `✅ Blocked @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'unblock': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned?.[0]) return await reply(sock, msg, `Usage: ${prefix}unblock @user`);
      try {
        await sock.updateBlockStatus(mentioned[0], 'unblock');
        await sock.sendMessage(jid, { text: `✅ Unblocked @${mentioned[0].split('@')[0]}`, mentions: [mentioned[0]] }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'restart': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      await reply(sock, msg, '🔄 Restarting...');
      setTimeout(() => process.exit(0), 1500);
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

// ═══════════════════════════════════════════════
//        AUTO FEATURE HANDLERS
// ═══════════════════════════════════════════════

const setupAutoFeatures = (sock) => {

  // Auto read, typing, recording
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;

    try {
      if (settings.autoRead) await sock.readMessages([msg.key]);
      if (settings.autoTyping) await sock.sendPresenceUpdate('composing', jid);
      if (settings.autoRecording) await sock.sendPresenceUpdate('recording', jid);
    } catch (e) {}
  });

  // Auto status view/like
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.remoteJid !== 'status@broadcast' || !msg.key.participant) return;
    try {
      if (settings.autoStatus) {
        await sock.readMessages([msg.key]);
        const emojis = ['💜', '⚡', '🌟', '✨', '👍'];
        await sock.sendMessage('status@broadcast',
          { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key } },
          { statusJidList: [msg.key.participant] }
        );
      }
    } catch (e) {}
  });

  // Channel auto react
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.key) return;
    if (msg.key.remoteJid !== settings.channelJid) return;
    if (!settings.autoReactChannel) return;
    try {
      const emojis = ['💜', '⚡', '🌟', '✨', '🔥'];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      const msgId = msg.newsletterServerId;
      if (msgId) {
        await sock.newsletterReactMessage(settings.channelJid, String(msgId), emoji);
        console.log(`✅ Channel react: ${emoji}`);
      }
    } catch (e) {}
  });

  // Welcome / Goodbye
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (action === 'add' && settings.welcomeMessage) {
        for (const user of participants) {
          await sock.sendMessage(id, {
            text: `👋 Welcome @${user.split('@')[0]}!\nType ${settings.prefix}menu for commands.`,
            mentions: [user]
          });
        }
      }
      if (action === 'remove' && settings.goodbyeMessage) {
        for (const user of participants) {
          await sock.sendMessage(id, {
            text: `👋 Goodbye @${user.split('@')[0]}! We'll miss you.`,
            mentions: [user]
          });
        }
      }
    } catch (e) {}
  });

  // Anti-link
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!settings.antiLink) return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid?.endsWith('@g.us')) return;
    const sender = msg.key.participant;
    if (isOwner(sender)) return;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const linkRegex = /https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+/i;
    if (linkRegex.test(text)) {
      try {
        await sock.sendMessage(jid, {
          delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
        });
        await sock.sendMessage(jid, {
          text: `⚠️ @${sender.split('@')[0]} links are not allowed!`,
          mentions: [sender]
        });
      } catch (e) {}
    }
  });
};

// ═══════════════════════════════════════════════
//         BOT START WITH PAIR CODE SUPPORT
// ═══════════════════════════════════════════════

const startBot = async (number, res) => {
  const sanitized = String(number || '').replace(/[^0-9]/g, '');
  const sessionPath = `./auth_info_baileys${sanitized ? '_' + sanitized : ''}`;
  fs.ensureDirSync(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: !number, // only print QR to terminal when no number given
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true
  });

  botSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  // ── Request pair code if number provided and not registered ──
  if (sanitized && !sock.authState.creds.registered) {
    let retries = 3;
    while (retries > 0) {
      try {
        await new Promise(r => setTimeout(r, 1500));
        const code = await sock.requestPairingCode(sanitized);
        pairCodeCache = code;
        console.log(`📲 Pair Code for ${sanitized}: ${code}`);
        if (res && !res.headersSent) {
          return res.json({ code });
        }
        break;
      } catch (e) {
        retries--;
        console.warn(`Pair code attempt failed (${retries} left): ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (res && !res.headersSent) {
      res.status(500).json({ error: 'Failed to generate pair code. Make sure number is correct.' });
    }
  }

  // ── QR code capture ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        console.log('📱 QR code generated');
      } catch (e) {}
    }

    if (connection === 'open') {
      botConnected = true;
      botStartTime  = Date.now();
      currentQR    = null;
      console.log('✅ Nexa Bot Connected!');

      // Auto join channel
      if (settings.autoJoinChannel && settings.channelJid) {
        try {
          await sock.newsletterFollow(settings.channelJid);
          console.log(`✅ Followed channel: ${settings.channelJid}`);
        } catch (e) {
          console.warn('Channel follow error:', e.message);
        }
      }

      // Send welcome message to self
      try {
        const selfJid = jidNormalizedUser(sock.user.id);
        await sock.sendMessage(selfJid, {
          image: { url: settings.thumbnail },
          caption: `
⚡ *${settings.botName} Connected!*

📱 Number: ${sock.user.id.split(':')[0]}
🕒 Time: ${new Date().toLocaleString('en-US', { timeZone: settings.timezone })}
📦 Type: ${settings.prefix}menu

${settings.footer}`
        });
      } catch (e) {}
    }

    if (connection === 'close') {
      botConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('🚪 Logged out!');
      }
    }
  });

  // ── Message handler ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;
    const isGroup = jid.endsWith('@g.us');
    const sender  = isGroup ? msg.key.participant : jid;
    const msgType = getContentType(msg.message);

    let text = '';
    if (msgType === 'conversation')        text = msg.message.conversation;
    else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || '';
    else if (msgType === 'imageMessage')   text = msg.message.imageMessage?.caption || '';
    else if (msgType === 'videoMessage')   text = msg.message.videoMessage?.caption || '';

    if (text) await handleCommand(sock, msg, text, isGroup, sender);
  });

  setupAutoFeatures(sock);
};

// ═══════════════════════════════════════════════
//              WEB API ROUTES
// ═══════════════════════════════════════════════

// Pair code endpoint - supports both GET and POST
const handlePair = async (req, res) => {
  const number = req.body?.phone || req.body?.number || req.query?.number || '';
  const sanitized = String(number).replace(/[^0-9]/g, '');
  if (sanitized.length < 7) return res.status(400).json({ success: false, message: 'Invalid number. Include country code.' });

  if (botConnected) {
    return res.json({ success: false, message: 'Bot already connected!' });
  }

  try {
    // Start bot with number and intercept code
    const sessionPath = `./auth_info_baileys_${sanitized}`;
    fs.ensureDirSync(sessionPath);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch(e) { version = [2, 3000, 1015901307]; }

    const sock = makeWASocket({
      version, logger,
      printQRInTerminal: false,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: true
    });
    botSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
      let retries = 3;
      let code = null;
      while (retries > 0 && !code) {
        try {
          await new Promise(r => setTimeout(r, 1500));
          code = await sock.requestPairingCode(sanitized);
        } catch (e) {
          retries--;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!code) return res.status(500).json({ success: false, message: 'Failed to get pair code. Check number.' });
      pairCodeCache = code;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { try { currentQR = await QRCode.toDataURL(qr); } catch(e) {} }
        if (connection === 'open') {
          botConnected = true; botStartTime = Date.now(); currentQR = null;
          if (settings.autoJoinChannel) { try { await sock.newsletterFollow(settings.channelJid); } catch(e) {} }
        }
        if (connection === 'close') {
          botConnected = false;
          const sc = lastDisconnect?.error?.output?.statusCode;
          if (sc !== DisconnectReason.loggedOut) setTimeout(() => startBot(), 5000);
        }
      });
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid; if (!jid) return;
        const isGroup = jid.endsWith('@g.us');
        const sender = isGroup ? msg.key.participant : jid;
        const msgType = getContentType(msg.message);
        let text = '';
        if (msgType === 'conversation') text = msg.message.conversation;
        else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || '';
        if (text) await handleCommand(sock, msg, text, isGroup, sender);
      });
      setupAutoFeatures(sock);
      return res.json({ success: true, code });
    } else {
      return res.json({ success: false, message: 'Already registered. Bot restarting...' });
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
  }
};
app.get('/api/pair', handlePair);
app.post('/api/pair', handlePair);

// Logout endpoint
app.post('/api/logout', async (req, res) => {
  try {
    if (botSocket) {
      await botSocket.logout();
      botSocket = null;
      botConnected = false;
    }
    res.json({ success: true, message: '✅ Bot logged out successfully!' });
  } catch (e) {
    res.json({ success: false, message: 'Logout error: ' + e.message });
  }
});

// Settings GET/POST
app.get('/api/settings', (req, res) => {
  loadSettings();
  res.json({ success: true, settings });
});
app.post('/api/settings', (req, res) => {
  try {
    const updates = req.body;
    for (const key of Object.keys(updates)) {
      if (key === 'workMode' && typeof updates[key] === 'object') {
        settings.workMode = Object.assign({}, settings.workMode, updates[key]);
      } else {
        settings[key] = updates[key];
      }
    }
    saveSettings();
    res.json({ success: true, message: 'Settings updated!' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// QR endpoint
app.get('/api/qr', (req, res) => {
  if (botConnected) return res.json({ status: 'connected', message: 'Bot already connected!' });
  if (currentQR)    return res.json({ qr: currentQR });
  // Start bot (QR mode — no number)
  if (!botSocket) startBot().catch(e => console.error(e));
  return res.json({ status: 'generating', message: 'QR is being generated. Try again in 5 seconds.' });
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    connected: botConnected,
    uptime: formatUptime(Date.now() - botStartTime),
    botName: settings.botName,
    version: settings.version
  });
});

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback for old /code route
app.get('/code', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).json({ error: 'Number required' });
  try {
    await startBot(String(number).replace(/[^0-9]/g, ''), res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
//              START SERVER
// ═══════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════╗
║  ⚡ ${settings.botName}
║  🌐 Port : ${PORT}
║  🚀 Status: ONLINE
╚══════════════════════════════╝
  `);
  // Auto start bot (QR mode) on server start
  startBot().catch(e => console.error('Bot start error:', e.message));
});
