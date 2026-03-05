import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  getContentType
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════
//  GLOBAL STATE
// ═══════════════════════════════════════
let settings        = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
let currentQR       = null;
let pairCode        = null;
let botConnected    = false;
let botSocket       = null;
let connectionState = 'disconnected';
let warns           = {};

const logger      = pino({ level: 'silent' });
const saveSettings = () => fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
const loadSettings = () => { settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8')); };

// ═══════════════════════════════════════
//  WEB API ROUTES
// ═══════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/status', (req, res) => res.json({
  connected: botConnected,
  state: connectionState,
  botName: settings.botName,
  version: settings.version,
  hasPairCode: !!pairCode,
  hasQR: !!currentQR
}));

app.get('/api/qr', (req, res) => {
  if (currentQR)    return res.json({ success: true,  qr: currentQR });
  if (botConnected) return res.json({ success: false, message: 'Bot already connected!' });
  res.json({ success: false, message: 'QR not ready yet, please wait...' });
});

// ─────────────────────────────────────────────────────────────
//  PAIR CODE ROUTE  (FIXED)
//
//  THE BUG:  requestPairingCode() was called AFTER the QR frame
//            arrived from WhatsApp (~3-5 s).  WhatsApp only
//            accepts a pairing request BEFORE it sends QR data,
//            so the request was always rejected → "Couldn't link".
//
//  THE FIX:  1. Wipe auth so we start a brand-new session.
//            2. Create a fresh socket.
//            3. On the VERY FIRST connection.update event (before
//               WhatsApp has time to send QR), call
//               requestPairingCode() immediately.
//            4. Return the code to the browser.
// ─────────────────────────────────────────────────────────────
app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone)      return res.json({ success: false, message: 'Phone number required!' });
  if (botConnected) return res.json({ success: false, message: 'Bot already connected!' });

  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 7)
    return res.json({ success: false, message: 'Invalid phone number!' });

  try {
    // 1 — tear down existing socket
    if (botSocket) {
      try { botSocket.ev.removeAllListeners(); botSocket.ws?.close(); } catch (_) {}
      botSocket = null;
    }

    // 2 — wipe credentials so WhatsApp treats this as a new device
    fs.removeSync('./auth_info_baileys');
    currentQR       = null;
    pairCode        = null;
    connectionState = 'pairing';

    // 3 — build a fresh socket
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger),
      },
      // Standard desktop Chrome is required — mobile/modified
      // browser strings cause "Couldn't link device"
      browser:                        ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect:            true,
      generateHighQualityLinkPreview: false,
      syncFullHistory:                false,
      connectTimeoutMs:               60_000,
      keepAliveIntervalMs:            25_000,
    });

    botSocket = sock;

    // 4 — wrap in a Promise so we can await the code
    const codePromise = new Promise((resolve, reject) => {
      let codeSent = false;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── Call requestPairingCode on the very first update ──
        // At this point the TCP/WebSocket handshake just finished
        // but WhatsApp has NOT yet sent QR data.
        if (!codeSent) {
          codeSent = true;
          try {
            console.log('🔑 Requesting pair code for:', cleanPhone);
            const raw = await sock.requestPairingCode(cleanPhone);
            const fmt = raw?.match(/.{1,4}/g)?.join('-') ?? raw;
            pairCode  = fmt;
            console.log('✅ Pair code ready:', fmt);
            resolve(fmt);
          } catch (err) {
            console.error('❌ requestPairingCode error:', err.message);
            reject(err);
          }
        }

        // QR received means we were too slow — save it as fallback
        if (qr) {
          currentQR       = await qrcode.toDataURL(qr);
          connectionState = 'qr_ready';
          if (!pairCode) reject(new Error('QR already received — pair code was too slow. Please try again.'));
        }

        if (connection === 'close') {
          botConnected    = false;
          connectionState = 'disconnected';
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== DisconnectReason.loggedOut) {
            setTimeout(() => startBot(), 3000);
          } else {
            fs.removeSync('./auth_info_baileys');
            setTimeout(() => startBot(), 2000);
          }
        }

        if (connection === 'open') {
          botConnected    = true;
          connectionState = 'connected';
          currentQR       = null;
          loadSettings();
          console.log('✅ Nexa Bot connected via Pair Code!');
          attachHandlers(sock, saveCreds);
          try {
            const ownerJid = settings.ownerNumber[0].replace(/\D/g, '') + '@s.whatsapp.net';
            await sock.sendMessage(ownerJid, {
              text: `╔══════════════════╗\n║  🤖 *NEXA BOT ONLINE*  ║\n╚══════════════════╝\n\n✅ Connected via Pair Code!\n📌 Prefix: *${settings.prefix}*\n🌐 Mode: *${settings.botMode}*\n⏰ ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}\n\nType *${settings.prefix}menu* for commands!`
            });
          } catch (_) {}
        }
      });

      sock.ev.on('creds.update', saveCreds);
    });

    // 5 — wait up to 20 s
    const code = await Promise.race([
      codePromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Timed out — please try again.')), 20_000))
    ]);

    res.json({ success: true, code, raw: code.replace(/-/g, '') });

  } catch (err) {
    console.error('Pair route error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/settings', (req, res) => { loadSettings(); res.json({ success: true, settings }); });

app.post('/api/settings', (req, res) => {
  settings = { ...settings, ...req.body };
  saveSettings();
  res.json({ success: true, message: 'Settings updated!', settings });
});

app.post('/api/logout', async (req, res) => {
  try {
    if (botSocket) await botSocket.logout().catch(() => {});
    botConnected    = false;
    connectionState = 'disconnected';
    fs.removeSync('./auth_info_baileys');
    res.json({ success: true, message: 'Logged out successfully!' });
    setTimeout(() => startBot(), 2000);
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', connected: botConnected, uptime: process.uptime() }));

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
const getPrefix = () => settings.prefix || '.';
const isOwner   = (jid) => {
  const num = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  return settings.ownerNumber.some(o => o.replace(/\D/g, '') === num);
};
const reply = (sock, msg, text) =>
  sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
const react = (sock, msg, emoji) =>
  sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });

// ═══════════════════════════════════════
//  COMMAND HANDLER
// ═══════════════════════════════════════
const handleCommand = async (sock, msg, text, isGroup, sender) => {
  const prefix = getPrefix();
  if (!text.startsWith(prefix)) return;

  const args  = text.slice(prefix.length).trim().split(/\s+/);
  const cmd   = args.shift().toLowerCase();
  const body  = args.join(' ');
  const jid   = msg.key.remoteJid;
  const owner = isOwner(sender);

  if (isGroup  && !settings.workMode.group)  return;
  if (!isGroup && !settings.workMode.inbox)  return;
  if (settings.botMode === 'private' && !owner)
    return reply(sock, msg, `🔒 *Nexa Bot* is in *Private Mode*.\nOnly owner can use commands!`);

  switch (cmd) {

    case 'menu': case 'help': {
      await react(sock, msg, '📋');
      await reply(sock, msg, `╔════════════════════════╗\n║   🤖 *NEXA BOT MENU*   ║\n╚════════════════════════╝\n\n*👑 OWNER COMMANDS*\n├ ${prefix}settings - Bot settings\n├ ${prefix}setprefix [x] - Change prefix\n├ ${prefix}setmode [public/private]\n├ ${prefix}setwork [group/inbox/private] [on/off]\n├ ${prefix}toggle [feature] - Toggle features\n├ ${prefix}broadcast [msg]\n├ ${prefix}block / ${prefix}unblock [@user]\n├ ${prefix}clearwarn [@user]\n└ ${prefix}restart\n\n*📊 INFO*\n├ ${prefix}ping | ${prefix}info | ${prefix}runtime | ${prefix}owner\n\n*🎮 FUN*\n├ ${prefix}quote | ${prefix}joke | ${prefix}fact | ${prefix}flip | ${prefix}calc\n\n*👥 GROUP*\n├ ${prefix}tagall | ${prefix}add | ${prefix}kick\n├ ${prefix}promote | ${prefix}demote\n├ ${prefix}mute | ${prefix}unmute\n├ ${prefix}link | ${prefix}revoke\n└ ${prefix}warn | ${prefix}listwarn | ${prefix}clearwarn\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n🤖 *${settings.botName}* v${settings.version} | Prefix: *${prefix}*\n━━━━━━━━━━━━━━━━━━━━━━━━`);
      break;
    }

    case 'ping': {
      const t = Date.now();
      await reply(sock, msg, `🏓 *Pong!* ⚡ ${Date.now() - t}ms`);
      break;
    }

    case 'info': {
      const up = process.uptime();
      await reply(sock, msg, `╔═══════════════════╗\n║  🤖 *NEXA BOT INFO*  ║\n╚═══════════════════╝\n\n🏷️ *${settings.botName}* v${settings.version}\n⚙️ Prefix: *${prefix}* | Mode: *${settings.botMode}*\n⏱️ Uptime: *${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${Math.floor(up%60)}s*\n📦 Node: *${process.version}*\n💾 RAM: *${(process.memoryUsage().rss/1024/1024).toFixed(1)} MB*\n━━━━━━━━━━━━━━━━━━━\nMade with ❤️ | Nexa Bot`);
      break;
    }

    case 'runtime': {
      const up = process.uptime();
      await reply(sock, msg, `⏱️ *Runtime:* ${Math.floor(up/86400)}d ${Math.floor((up%86400)/3600)}h ${Math.floor((up%3600)/60)}m ${Math.floor(up%60)}s`);
      break;
    }

    case 'owner':
      await reply(sock, msg, `👑 *Owner:* wa.me/${settings.ownerNumber[0]}`);
      break;

    // SETTINGS
    case 'settings': {
      if (!owner) return reply(sock, msg, '❌ Owner only!');
      loadSettings();
      await reply(sock, msg, `╔══════════════════════╗\n║  ⚙️ *NEXA BOT SETTINGS*  ║\n╚══════════════════════╝\n\n🤖 Name: *${settings.botName}* | Prefix: *${settings.prefix}*\n🌐 Mode: *${settings.botMode}*\n\n📍 *Work Modes:*\n├ Group: ${settings.workMode.group?'✅':'❌'} | Inbox: ${settings.workMode.inbox?'✅':'❌'} | Private: ${settings.workMode.private?'✅':'❌'}\n\n🔧 *Auto Features:*\n├ Auto Read: ${settings.autoRead?'✅':'❌'} | Typing: ${settings.autoTyping?'✅':'❌'}\n├ Auto Reply: ${settings.autoReply?'✅':'❌'} | Anti-Delete: ${settings.antiDelete?'✅':'❌'}\n├ Anti-Link: ${settings.antiLink?'✅':'❌'} | Anti-Spam: ${settings.antiSpam?'✅':'❌'}\n└ Welcome: ${settings.welcomeMessage?'✅':'❌'} | Goodbye: ${settings.goodbyeMessage?'✅':'❌'}\n\n${prefix}toggle [autoread/autotyping/autoreply/antidelete/antilink/antispam/welcome/goodbye]`);
      break;
    }

    case 'setprefix': {
      if (!owner || !body) return reply(sock, msg, !owner ? '❌ Owner only!' : `Usage: ${prefix}setprefix [x]`);
      const old = settings.prefix; settings.prefix = body.trim()[0]; saveSettings();
      await reply(sock, msg, `✅ Prefix: *${old}* → *${settings.prefix}*`);
      break;
    }

    case 'setmode': {
      if (!owner) return reply(sock, msg, '❌ Owner only!');
      const m = body.toLowerCase();
      if (!['public','private'].includes(m)) return reply(sock, msg, `Usage: ${prefix}setmode [public/private]`);
      settings.botMode = m; saveSettings();
      await reply(sock, msg, `✅ Mode: *${m}*`);
      break;
    }

    case 'setwork': {
      if (!owner) return reply(sock, msg, '❌ Owner only!');
      const [wt, ws] = args;
      if (!wt || !ws || !['group','inbox','private'].includes(wt.toLowerCase()))
        return reply(sock, msg, `Usage: ${prefix}setwork [group/inbox/private] [on/off]`);
      settings.workMode[wt.toLowerCase()] = ws.toLowerCase()==='on'; saveSettings();
      await reply(sock, msg, `✅ Work *${wt}*: ${settings.workMode[wt.toLowerCase()]?'✅ ON':'❌ OFF'}`);
      break;
    }

    case 'toggle': {
      if (!owner) return reply(sock, msg, '❌ Owner only!');
      const map = { autoread:'autoRead', autotyping:'autoTyping', autorecording:'autoRecording', antidelete:'antiDelete', antilink:'antiLink', antispam:'antiSpam', autoreply:'autoReply', welcome:'welcomeMessage', goodbye:'goodbyeMessage' };
      const key = map[body.toLowerCase()];
      if (!key) return reply(sock, msg, `❌ Available: ${Object.keys(map).join(', ')}`);
      settings[key] = !settings[key]; saveSettings();
      await reply(sock, msg, `✅ *${body}*: ${settings[key]?'✅ ON':'❌ OFF'}`);
      break;
    }

    // FUN
    case 'quote': {
      const q = ['The only way to do great work is to love what you do. — Steve Jobs','In the middle of every difficulty lies opportunity. — Einstein','Life is what happens when you\'re busy making other plans. — John Lennon','The future belongs to those who believe in the beauty of their dreams. — Roosevelt'];
      await reply(sock, msg, `💬 *Quote*\n\n_"${q[Math.floor(Math.random()*q.length)]}"_`);
      break;
    }

    case 'joke': {
      const j = ["Why don't scientists trust atoms? They make up everything! 😂","I told my wife she was drawing eyebrows too high. She looked surprised! 😄","Why did the scarecrow win an award? Outstanding in his field! 🌾","Why did the bicycle fall over? It was two-tired! 🚲"];
      await reply(sock, msg, `😂 *Joke*\n\n${j[Math.floor(Math.random()*j.length)]}`);
      break;
    }

    case 'fact': {
      const f = ["🐙 Octopuses have 3 hearts and blue blood!","🍯 Honey never expires — 3000-yr-old honey found in Egypt!","🌙 The Moon moves away ~3.8 cm/year!","⚡ Lightning strikes Earth ~100 times per second!"];
      await reply(sock, msg, `🧠 *Fact*\n\n${f[Math.floor(Math.random()*f.length)]}`);
      break;
    }

    case 'flip':
      await reply(sock, msg, `🪙 *Coin:* ${Math.random()<0.5?'🦅 Heads':'🦁 Tails'}`);
      break;

    case 'calc': {
      if (!body) return reply(sock, msg, `Usage: ${prefix}calc 2+2`);
      try { await reply(sock, msg, `🧮 *${body}* = *${Function(`'use strict';return(${body.replace(/[^0-9+\-*/.()%\s]/g,'')})`)()}*`); }
      catch { await reply(sock, msg, '❌ Invalid expression!'); }
      break;
    }

    case 'time':
      await reply(sock, msg, `🕐 *SL Time:*\n${new Date().toLocaleString('en-US',{timeZone:'Asia/Colombo',weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})}`);
      break;

    // GROUP
    case 'tagall': {
      if (!isGroup) return reply(sock, msg, '❌ Group only!');
      try {
        const meta = await sock.groupMetadata(jid);
        const mentions = meta.participants.map(p => p.id);
        let t = `📢 *Tag All*\n\n`;
        meta.participants.forEach((p,i) => { t+=`@${p.id.split('@')[0]} `; if((i+1)%10===0) t+='\n'; });
        await sock.sendMessage(jid, { text:t, mentions }, { quoted:msg });
      } catch(e) { await reply(sock, msg, `❌ ${e.message}`); }
      break;
    }

    case 'add': {
      if (!isGroup||!owner) return reply(sock, msg, !isGroup?'❌ Group only!':'❌ Owner only!');
      try { await sock.groupParticipantsUpdate(jid,[body.replace(/\D/g,'')+'@s.whatsapp.net'],'add'); await reply(sock,msg,'✅ Added!'); }
      catch(e) { await reply(sock,msg,`❌ ${e.message}`); }
      break;
    }

    case 'kick': {
      if (!isGroup||!owner) return reply(sock, msg, !isGroup?'❌ Group only!':'❌ Owner only!');
      const m = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!m?.[0]) return reply(sock,msg,`Usage: ${prefix}kick @user`);
      try { await sock.groupParticipantsUpdate(jid,[m[0]],'remove'); await reply(sock,msg,`✅ Kicked @${m[0].split('@')[0]}`); }
      catch(e) { await reply(sock,msg,`❌ ${e.message}`); }
      break;
    }

    case 'promote': case 'demote': {
      if (!isGroup||!owner) return reply(sock, msg, !isGroup?'❌ Group only!':'❌ Owner only!');
      const m = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!m?.[0]) return reply(sock,msg,`Usage: ${prefix}${cmd} @user`);
      try { await sock.groupParticipantsUpdate(jid,[m[0]],cmd); await reply(sock,msg,`✅ ${cmd==='promote'?'Promoted':'Demoted'} @${m[0].split('@')[0]}!`); }
      catch(e) { await reply(sock,msg,`❌ ${e.message}`); }
      break;
    }

    case 'mute': case 'unmute': {
      if (!isGroup||!owner) return reply(sock,msg,!isGroup?'❌ Group only!':'❌ Owner only!');
      try { await sock.groupSettingUpdate(jid,cmd==='mute'?'announcement':'not_announcement'); await reply(sock,msg,cmd==='mute'?'🔇 Muted!':'🔊 Unmuted!'); }
      catch(e) { await reply(sock,msg,`❌ ${e.message}`); }
      break;
    }

    case 'link': {
      if (!isGroup) return reply(sock,msg,'❌ Group only!');
      try { const c=await sock.groupInviteCode(jid); await reply(sock,msg,`🔗 https://chat.whatsapp.com/${c}`); }
      catch(e) { await reply(sock,msg,`❌ ${e.message}`); }
      break;
    }

    case 'revoke': {
      if (!isGroup||!owner) return reply(sock,msg,!isGroup?'❌ Group only!':'❌ Owner only!');
      try { await sock.groupRevokeInvite(jid); const c=await sock.groupInviteCode(jid); await reply(sock,msg,`✅ Revoked!\n🔗 New: https://chat.whatsapp.com/${c}`); }
      catch(e) { await reply(sock,msg,`❌ ${e.message}`); }
      break;
    }

    case 'warn': {
      if (!isGroup||!owner) return reply(sock,msg,!isGroup?'❌ Group only!':'❌ Owner only!');
      const m = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!m?.[0]) return reply(sock,msg,`Usage: ${prefix}warn @user`);
      const wj=m[0]; if(!warns[jid]) warns[jid]={};
      warns[jid][wj]=(warns[jid][wj]||0)+1;
      const wc=warns[jid][wj];
      await sock.sendMessage(jid,{text:`⚠️ *Warning ${wc}/${settings.maxWarn}*\n@${wj.split('@')[0]} warned!`,mentions:[wj]},{quoted:msg});
      if(wc>=settings.maxWarn){ try{await sock.groupParticipantsUpdate(jid,[wj],'remove');}catch(_){} warns[jid][wj]=0; await sock.sendMessage(jid,{text:`🚫 @${wj.split('@')[0]} kicked for max warnings!`,mentions:[wj]}); }
      break;
    }

    case 'listwarn': {
      if (!isGroup) return reply(sock,msg,'❌ Group only!');
      if (!warns[jid]||!Object.keys(warns[jid]).length) return reply(sock,msg,'✅ No warnings!');
      let list='⚠️ *Warnings*\n\n';
      for(const[w,c] of Object.entries(warns[jid])) list+=`@${w.split('@')[0]}: ${c}/${settings.maxWarn}\n`;
      await sock.sendMessage(jid,{text:list,mentions:Object.keys(warns[jid])},{quoted:msg});
      break;
    }

    case 'clearwarn': {
      if (!owner) return reply(sock,msg,'❌ Owner only!');
      const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if(!m?.[0]){ if(isGroup){warns[jid]={};return reply(sock,msg,'✅ All cleared!');} return reply(sock,msg,`Usage: ${prefix}clearwarn @user`); }
      if(warns[jid]) warns[jid][m[0]]=0;
      await reply(sock,msg,`✅ Cleared @${m[0].split('@')[0]}`);
      break;
    }

    case 'broadcast': {
      if (!owner) return reply(sock,msg,'❌ Owner only!');
      if (!body)  return reply(sock,msg,`Usage: ${prefix}broadcast [msg]`);
      await reply(sock,msg,'📡 Broadcasting...');
      const chats=await sock.groupFetchAllParticipating(); let cnt=0;
      for(const cid of Object.keys(chats)){ try{await sock.sendMessage(cid,{text:`📢 *Broadcast*\n\n${body}`});cnt++;await new Promise(r=>setTimeout(r,1000));}catch(_){} }
      await reply(sock,msg,`✅ Sent to *${cnt}* groups!`);
      break;
    }

    case 'block': case 'unblock': {
      if (!owner) return reply(sock,msg,'❌ Owner only!');
      const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if(!m?.[0]) return reply(sock,msg,`Usage: ${prefix}${cmd} @user`);
      await sock.updateBlockStatus(m[0],cmd);
      await reply(sock,msg,`✅ ${cmd==='block'?'Blocked':'Unblocked'} @${m[0].split('@')[0]}`);
      break;
    }

    case 'restart': {
      if (!owner) return reply(sock,msg,'❌ Owner only!');
      await reply(sock,msg,'🔄 Restarting...');
      setTimeout(()=>process.exit(0),1000);
      break;
    }

    default:
      if (settings.autoReply && !isGroup) await reply(sock, msg, settings.autoReplyMessage);
      break;
  }
};

// ═══════════════════════════════════════
//  SHARED EVENT HANDLERS
// ═══════════════════════════════════════
function attachHandlers(sock, saveCreds) {
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid     = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      const sender  = isGroup ? msg.key.participant : jid;
      const mtype   = getContentType(msg.message);
      let text = '';
      if      (mtype==='conversation')        text=msg.message.conversation;
      else if (mtype==='extendedTextMessage') text=msg.message.extendedTextMessage.text;
      else if (mtype==='imageMessage')        text=msg.message.imageMessage?.caption||'';
      else if (mtype==='videoMessage')        text=msg.message.videoMessage?.caption||'';

      if (settings.autoRead)
        await sock.readMessages([msg.key]).catch(()=>{});
      if (settings.autoTyping && text.startsWith(getPrefix()))
        await sock.sendPresenceUpdate('composing', jid).catch(()=>{});
      if (text)
        await handleCommand(sock, msg, text, isGroup, sender).catch(e=>console.error('Cmd error:',e.message));
      if (settings.autoTyping)
        await sock.sendPresenceUpdate('paused', jid).catch(()=>{});
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    loadSettings();
    for (const p of participants) {
      if (action==='add' && settings.welcomeMessage) {
        try {
          const meta = await sock.groupMetadata(id);
          await sock.sendMessage(id, { text:`╔══════════════════╗\n║  👋 *WELCOME!*  ║\n╚══════════════════╝\n\nWelcome @${p.split('@')[0]} to *${meta.subject}*! 🎉\n👥 Members: ${meta.participants.length}`, mentions:[p] });
        } catch(_){}
      }
      if (action==='remove' && settings.goodbyeMessage) {
        try { await sock.sendMessage(id, { text:`👋 Goodbye @${p.split('@')[0]}! We'll miss you! 💔`, mentions:[p] }); } catch(_){}
      }
    }
  });
}

// ═══════════════════════════════════════
//  NORMAL QR-MODE START
// ═══════════════════════════════════════
const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, logger,
    printQRInTerminal: false,
    auth: { creds:state.creds, keys:makeCacheableSignalKeyStore(state.keys,logger) },
    browser:                        ['Ubuntu','Chrome','20.0.04'],
    markOnlineOnConnect:            true,
    generateHighQualityLinkPreview: false,
    syncFullHistory:                false,
    connectTimeoutMs:               60_000,
    keepAliveIntervalMs:            25_000,
  });

  botSocket = sock;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR       = await qrcode.toDataURL(qr);
      pairCode        = null;
      connectionState = 'qr_ready';
      console.log('📱 QR ready — open web panel');
    }
    if (connection==='close') {
      botConnected=false; connectionState='disconnected'; currentQR=null;
      const reason=lastDisconnect?.error?.output?.statusCode;
      if (reason!==DisconnectReason.loggedOut) { setTimeout(()=>startBot(),3000); }
      else { fs.removeSync('./auth_info_baileys'); setTimeout(()=>startBot(),2000); }
    }
    if (connection==='open') {
      botConnected=true; connectionState='connected'; currentQR=null;
      loadSettings();
      console.log(`✅ Nexa Bot Connected! — ${settings.botName}`);
      attachHandlers(sock, saveCreds);
      try {
        const ownerJid=settings.ownerNumber[0].replace(/\D/g,'')+'@s.whatsapp.net';
        await sock.sendMessage(ownerJid,{text:`╔══════════════════╗\n║  🤖 *NEXA BOT ONLINE*  ║\n╚══════════════════╝\n\n✅ Connected!\n📌 Prefix: *${settings.prefix}* | Mode: *${settings.botMode}*\n⏰ ${new Date().toLocaleString('en-US',{timeZone:'Asia/Colombo'})}\n\nType *${settings.prefix}menu* for commands!`});
      } catch(_){}
    }
  });

  sock.ev.on('creds.update', saveCreds);
};

// ═══════════════════════════════════════
//  KEEP-ALIVE (Render free tier)
// ═══════════════════════════════════════
if (process.env.RENDER_EXTERNAL_URL) {
  const https  = (await import('https')).default;
  const pingUrl = process.env.RENDER_EXTERNAL_URL + '/health';
  setInterval(() => https.get(pingUrl,()=>{}).on('error',()=>{}), 14*60*1000);
}

// ═══════════════════════════════════════
//  START
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════╗\n║    🤖  NEXA BOT SERVER   ║\n╚══════════════════════════╝\n🌐 Panel: http://localhost:${PORT}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  startBot();
});

process.on('uncaughtException',  e => console.error('Uncaught:',  e.message));
process.on('unhandledRejection', e => console.error('Unhandled:', e?.message ?? e));
