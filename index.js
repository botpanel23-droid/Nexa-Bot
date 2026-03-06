
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  getContentType,
  downloadContentFromMessage
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

// Ensure settings exist
if (!fs.existsSync('./settings.json')) {
    const defaultSettings = {
        prefix: '.',
        ownerNumber: ['94712345678'],
        botName: 'Nexa Bot',
        version: '1.0.0',
        botMode: 'public',
        workMode: { group: true, inbox: true, private: true },
        autoRead: false,
        autoTyping: false,
        autoRecording: false,
        autoReply: false,
        autoReplyMessage: 'I am busy right now.',
        maxWarn: 3,
        welcomeMessage: true,
        goodbyeMessage: true
    };
    fs.writeFileSync('./settings.json', JSON.stringify(defaultSettings, null, 2));
}

let settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
let botSocket = null;
let botConnected = false;

const saveSettings = () => fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
const loadSettings = () => { settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8')); };
const logger = pino({ level: 'silent' });

// ═══════════════════════════════════════════
//              HELPER FUNCTIONS
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
  await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
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
║   🤖 *NEXA BOT MENU*   ║
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
║  🤖 *NEXA BOT INFO*  ║
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
  try {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });

    if (!msg.quoted || !msg.quoted.statusMessage) {
      await socket.sendMessage(sender, {
        text: `📌 *ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs ᴛᴏ sᴀᴠᴇ ɪᴛ, ᴅᴀʀʟɪɴɢ!* 😘`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *sᴀᴠɪɴɢ sᴛᴀᴛᴜs, sᴡᴇᴇᴛɪᴇ...* 😘`
    }, { quoted: msg });

    const media = await socket.downloadMediaMessage(msg.quoted);
    const fileExt = msg.quoted.imageMessage ? 'jpg' : 'mp4';
    const filePath = `./status_${Date.now()}.${fileExt}`;
    fs.writeFileSync(filePath, media);

    await sock.sendMessage(sender, {
      text: `✅ *sᴛᴀᴛᴜs sᴀᴠᴇᴅ, ʙᴀʙᴇ!* 😘\n` +
            `📁 *ғɪʟᴇ:* status_${Date.now()}.${fileExt}\n` +
            `> © Nexa Bot`,
      document: { url: filePath },
      mimetype: msg.quoted.imageMessage ? 'image/jpeg' : 'video/mp4',
      fileName: `status_${Date.now()}.${fileExt}`
    }, { quoted: msg });

  } catch (error) {
    console.error('Savestatus command error:', error.message);
    await socket.sendMessage(sender, {
      text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ sᴀᴠᴇ ᴛʜᴀᴛ sᴛᴀᴛᴜs! 😢*\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
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

    // ─────────────── SETTINGS COMMANDS ───────────────
    case 'settings': {
      if (!owner) return await reply(sock, msg, '❌ Owner only command!');
      await react(sock, msg, '⚙️');
      loadSettings();
      const settingsText = `
╔══════════════════════╗
║  ⚙️ *NEXA BOT SETTINGS*  ║
╚══════════════════════╝

🤖 *Bot Name:* ${settings.botName}
📌 *Prefix:* ${settings.prefix}
🌐 *Bot Mode:* ${settings.botMode}
🔤 *Language:* ${settings.language}

*📍 Work Modes:*
├ 👥 Group: ${settings.workMode.group ? '✅' : '❌'}
├ 📩 Inbox: ${settings.workMode.inbox ? '✅' : '❌'}
└ 🔒 Private: ${settings.workMode.private ? '✅' : '❌'}

*🔧 Auto Features:*
├ 📖 Auto Read: ${settings.autoRead ? '✅' : '❌'}
├ ⌨️ Auto Typing: ${settings.autoTyping ? '✅' : '❌'}
├ 🎤 Auto Recording: ${settings.autoRecording ? '✅' : '❌'}
├ 💬 Auto Reply: ${settings.autoReply ? '✅' : '❌'}
├ 🛡️ Anti Delete: ${settings.antiDelete ? '✅' : '❌'}
├ 🔗 Anti Link: ${settings.antiLink ? '✅' : '❌'}
└ 🚫 Anti Spam: ${settings.antiSpam ? '✅' : '❌'}

*👥 Group Features:*
├ 👋 Welcome Msg: ${settings.welcomeMessage ? '✅' : '❌'}
└ 👋 Goodbye Msg: ${settings.goodbyeMessage ? '✅' : '❌'}

━━━━━━━━━━━━━━━━━━━━━━
*Commands to change:*
${prefix}setmode [public/private]
${prefix}setprefix [symbol]
${prefix}setwork [group/inbox] [on/off]
${prefix}toggle [autoread/autotyping/antidelete/antilink/antispam/autoreply/welcome/goodbye]`;
      await reply(sock, msg, settingsText);
      break;
    }

    case 'setprefix': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      if (!body) return await reply(sock, msg, `Usage: ${prefix}setprefix [symbol]`);
      const oldPrefix = settings.prefix;
      settings.prefix = body.trim()[0];
      saveSettings();
      await reply(sock, msg, `✅ Prefix changed from *${oldPrefix}* to *${settings.prefix}*`);
      break;
    }

    case 'setmode': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mode = body.toLowerCase();
      if (!['public', 'private'].includes(mode)) return await reply(sock, msg, `Usage: ${prefix}setmode [public/private]`);
      settings.botMode = mode;
      saveSettings();
      await reply(sock, msg, `✅ Bot mode set to *${mode}*\n${mode === 'private' ? '🔒 Only owner can use bot' : '🌐 Everyone can use bot'}`);
      break;
    }

    case 'setwork': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const [workType, status] = args;
      if (!workType || !status) return await reply(sock, msg, `Usage: ${prefix}setwork [group/inbox/private] [on/off]`);
      if (!['group', 'inbox', 'private'].includes(workType.toLowerCase())) return await reply(sock, msg, '❌ Invalid work type! Use: group/inbox/private');
      const isOn = status.toLowerCase() === 'on';
      settings.workMode[workType.toLowerCase()] = isOn;
      saveSettings();
      await reply(sock, msg, `✅ *${workType}* work mode: ${isOn ? '✅ ON' : '❌ OFF'}`);
      break;
    }

    case 'toggle': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const feature = body.toLowerCase();
      const toggleMap = {
        'autoread': 'autoRead',
        'autotyping': 'autoTyping',
        'autorecording': 'autoRecording',
        'antidelete': 'antiDelete',
        'antilink': 'antiLink',
        'antispam': 'antiSpam',
        'autoreply': 'autoReply',
        'welcome': 'welcomeMessage',
        'goodbye': 'goodbyeMessage'
      };
      if (!toggleMap[feature]) return await reply(sock, msg, `❌ Unknown feature! Available: ${Object.keys(toggleMap).join(', ')}`);
      const key = toggleMap[feature];
      settings[key] = !settings[key];
      saveSettings();
      await reply(sock, msg, `✅ *${feature}* is now: ${settings[key] ? '✅ ON' : '❌ OFF'}`);
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

    // ─────────────── FUN COMMANDS ───────────────
    case 'quote': {
      await react(sock, msg, '💬');
      const quotes = [
        "The only way to do great work is to love what you do. - Steve Jobs",
        "In the middle of every difficulty lies opportunity. - Albert Einstein",
        "Life is what happens when you're busy making other plans. - John Lennon",
        "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
        "It is during our darkest moments that we must focus to see the light. - Aristotle",
        "Spread love everywhere you go. - Mother Teresa",
        "When you reach the end of your rope, tie a knot in it and hang on. - Franklin D. Roosevelt",
        "Always remember that you are absolutely unique. Just like everyone else. - Margaret Mead"
      ];
      const q = quotes[Math.floor(Math.random() * quotes.length)];
      await reply(sock, msg, `💬 *Quote of the Day*\n\n_"${q}"_`);
      break;
    }

    case 'joke': {
      await react(sock, msg, '😂');
      const jokes = [
        "Why don't scientists trust atoms? Because they make up everything! 😂",
        "I told my wife she was drawing her eyebrows too high. She looked surprised! 😄",
        "Why did the scarecrow win an award? Because he was outstanding in his field! 🌾",
        "I used to hate facial hair but then it grew on me! 😆",
        "Why did the bicycle fall over? Because it was two-tired! 🚲",
        "What do you call a fake noodle? An Impasta! 🍝",
        "Why did the math book look so sad? Because it had too many problems! 📚"
      ];
      const j = jokes[Math.floor(Math.random() * jokes.length)];
      await reply(sock, msg, `😂 *Random Joke*\n\n${j}`);
      break;
    }

    case 'fact': {
      await react(sock, msg, '🧠');
      const facts = [
        "🐙 Octopuses have three hearts and blue blood!",
        "🍯 Honey never expires - archaeologists found 3000-year-old honey in Egyptian tombs!",
        "🌙 The Moon is moving away from Earth at about 3.8 cm per year!",
        "🦋 Butterflies taste with their feet!",
        "🐘 Elephants are the only animals that can't jump!",
        "🌊 About 71% of Earth's surface is covered in water!",
        "⚡ Lightning strikes Earth about 100 times per second!"
      ];
      const f = facts[Math.floor(Math.random() * facts.length)];
      await reply(sock, msg, `🧠 *Random Fact*\n\n${f}`);
      break;
    }

    case 'flip': {
      await react(sock, msg, '🪙');
      const result = Math.random() < 0.5 ? '🦅 Heads' : '🦁 Tails';
      await reply(sock, msg, `🪙 *Coin Flip Result:* ${result}`);
      break;
    }

    case 'calc': {
      if (!body) return await reply(sock, msg, `Usage: ${prefix}calc [expression]\nExample: ${prefix}calc 2+2`);
      try {
        const sanitized = body.replace(/[^0-9+\-*/.()%\s]/g, '');
        const result = Function(`'use strict'; return (${sanitized})`)();
        await reply(sock, msg, `🧮 *Calculator*\n\n📥 Input: ${body}\n📤 Result: *${result}*`);
      } catch (e) {
        await reply(sock, msg, `❌ Invalid expression!`);
      }
      break;
    }

    case 'time': {
      const now = new Date();
      const time = now.toLocaleString('en-US', {
        timeZone: 'Asia/Colombo',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
      });
      await reply(sock, msg, `🕐 *Current Time (Sri Lanka)*\n\n${time}`);
      break;
    }

    case 'sticker': {
      await react(sock, msg, '🎨');
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) return await reply(sock, msg, `❌ Reply to an image to make sticker!\nUsage: Reply to image + ${prefix}sticker`);
      // Sticker creation would need media handling
      await reply(sock, msg, `⚠️ Reply to an image/video with this command to create sticker!`);
      break;
    }

    // ─────────────── GROUP COMMANDS ───────────────
    case 'tagall': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      try {
        const groupMeta = await sock.groupMetadata(jid);
        const members = groupMeta.participants;
        let mention = members.map(m => m.id);
        let text = `📢 *Tag All Members*\n\n`;
        members.forEach((m, i) => {
          text += `@${m.id.split('@')[0]} `;
          if ((i + 1) % 10 === 0) text += '\n';
        });
        await sock.sendMessage(jid, { text, mentions: mention }, { quoted: msg });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'add': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const numToAdd = body.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      try {
        await sock.groupParticipantsUpdate(jid, [numToAdd], 'add');
        await reply(sock, msg, `✅ Successfully added @${body.replace(/[^0-9]/g, '')}`, { mentions: [numToAdd] });
      } catch (e) {
        await reply(sock, msg, `❌ Couldn't add user: ${e.message}`);
      }
      break;
    }

    case 'kick': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) return await reply(sock, msg, `Usage: ${prefix}kick @user`);
      try {
        await sock.groupParticipantsUpdate(jid, [mentioned[0]], 'remove');
        await reply(sock, msg, `✅ Kicked @${mentioned[0].split('@')[0]}`, { mentions: [mentioned[0]] });
      } catch (e) {
        await reply(sock, msg, `❌ Couldn't kick: ${e.message}`);
      }
      break;
    }

    case 'promote': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) return await reply(sock, msg, `Usage: ${prefix}promote @user`);
      try {
        await sock.groupParticipantsUpdate(jid, [mentioned[0]], 'promote');
        await reply(sock, msg, `✅ Promoted @${mentioned[0].split('@')[0]} to admin!`, { mentions: [mentioned[0]] });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'demote': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) return await reply(sock, msg, `Usage: ${prefix}demote @user`);
      try {
        await sock.groupParticipantsUpdate(jid, [mentioned[0]], 'demote');
        await reply(sock, msg, `✅ Demoted @${mentioned[0].split('@')[0]} from admin!`, { mentions: [mentioned[0]] });
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'mute': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
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
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
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
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      try {
        const code = await sock.groupInviteCode(jid);
        await reply(sock, msg, `🔗 *Group Link:*\nhttps://chat.whatsapp.com/${code}`);
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'revoke': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      try {
        await sock.groupRevokeInvite(jid);
        const newCode = await sock.groupInviteCode(jid);
        await reply(sock, msg, `✅ Group link revoked!\n🔗 New link: https://chat.whatsapp.com/${newCode}`);
      } catch (e) {
        await reply(sock, msg, `❌ Error: ${e.message}`);
      }
      break;
    }

    case 'warn': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) return await reply(sock, msg, `Usage: ${prefix}warn @user`);
      const warnJid = mentioned[0];
      if (!warns[jid]) warns[jid] = {};
      warns[jid][warnJid] = (warns[jid][warnJid] || 0) + 1;
      const warnCount = warns[jid][warnJid];
      await reply(sock, msg, `⚠️ *Warning!*\n@${warnJid.split('@')[0]} has been warned!\nWarnings: ${warnCount}/${settings.maxWarn}`, { mentions: [warnJid] });
      if (warnCount >= settings.maxWarn) {
        await sock.groupParticipantsUpdate(jid, [warnJid], 'remove');
        warns[jid][warnJid] = 0;
        await reply(sock, msg, `🚫 @${warnJid.split('@')[0]} has been kicked for reaching max warnings!`, { mentions: [warnJid] });
      }
      break;
    }

    case 'listwarn': {
      if (!isGroup) return await reply(sock, msg, '❌ Group only command!');
      if (!warns[jid] || Object.keys(warns[jid]).length === 0) return await reply(sock, msg, '✅ No warnings in this group!');
      let warnList = `⚠️ *Warning List*\n\n`;
      for (const [wJid, count] of Object.entries(warns[jid])) {
        warnList += `@${wJid.split('@')[0]}: ${count}/${settings.maxWarn} warnings\n`;
      }
      const warnMentions = Object.keys(warns[jid]);
      await sock.sendMessage(jid, { text: warnList, mentions: warnMentions }, { quoted: msg });
      break;
    }

    case 'clearwarn': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) {
        if (isGroup) { warns[jid] = {}; return await reply(sock, msg, '✅ All warnings cleared in this group!'); }
        return await reply(sock, msg, `Usage: ${prefix}clearwarn @user`);
      }
      if (warns[jid]) warns[jid][mentioned[0]] = 0;
      await reply(sock, msg, `✅ Warnings cleared for @${mentioned[0].split('@')[0]}`, { mentions: [mentioned[0]] });
      break;
    }

    // ─────────────── OWNER COMMANDS ───────────────
    case 'broadcast': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      if (!body) return await reply(sock, msg, `Usage: ${prefix}broadcast [message]`);
      await reply(sock, msg, `📡 Broadcasting message...`);
      const chats = await sock.groupFetchAllParticipating();
      let count = 0;
      for (const chatId of Object.keys(chats)) {
        try {
          await sock.sendMessage(chatId, { text: `📢 *Broadcast from ${settings.botName}*\n\n${body}` });
          count++;
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {}
      }
      await reply(sock, msg, `✅ Broadcast sent to *${count}* groups!`);
      break;
    }

    case 'block': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) return await reply(sock, msg, `Usage: ${prefix}block @user`);
      await sock.updateBlockStatus(mentioned[0], 'block');
      await reply(sock, msg, `✅ Blocked @${mentioned[0].split('@')[0]}`, { mentions: [mentioned[0]] });
      break;
    }

    case 'unblock': {
      if (!owner) return await reply(sock, msg, '❌ Owner only!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || !mentioned[0]) return await reply(sock, msg, `Usage: ${prefix}unblock @user`);
      await sock.updateBlockStatus(mentioned[0], 'unblock');
      await reply(sock, msg, `✅ Unblocked @${mentioned[0].split('@')[0]}`, { mentions: [mentioned[0]] });
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
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true
  });

  botSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      botConnected = true;
      console.log('✅ Nexa Bot Connected!');
    }
    if (connection === 'close') {
      botConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : jid;
    const msgType = getContentType(msg.message);
    
    let text = "";
    if (msgType === 'conversation') text = msg.message.conversation;
    else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
    
    if (text) await handleCommand(sock, msg, text, isGroup, sender, msg.pushName);
  });
};

// ═══════════════════════════════════════════
//              START SERVER
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Nexa Bot is running!'));
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  startBot();
});
