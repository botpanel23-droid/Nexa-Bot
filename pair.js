const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const router = express.Router();
const pino = require('pino');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const os = require('os');
const { sms, downloadMediaMessage } = require('./msg');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

// node-fetch compatibility wrapper
const nodeFetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const res = await axios({ url, method, data: opts.body || undefined, headers: opts.headers || {}, responseType: 'arraybuffer', timeout: 20000 });
    const raw = res.data;
    return {
        json: async () => JSON.parse(Buffer.from(raw).toString('utf-8')),
        arrayBuffer: async () => raw,
        text: async () => Buffer.from(raw).toString('utf-8'),
        ok: res.status >= 200 && res.status < 300,
        status: res.status
    };
};

// ==================== CONFIG ====================
const config = {
    BOT_NAME: 'Nexa Bot',
    PREFIX: '.',
    BOT_LOGO: 'https://files.catbox.moe/1zj41k.png',
    CHANNEL_JID: '120363405932644483@newsletter',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VarMBjc8LnROcm6KQp44',
    AUTO_VIEW_STATUS: true,
    AUTO_LIKE_STATUS: true,
    AUTO_RECORDING: true,
    AUTO_REACT_CHANNEL: true,
    AUTO_JOIN_CHANNEL: true,
    MAX_RETRIES: 5,
    version: '3.0.0',
    BOT_FOOTER: '> 𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 ⚡',
    AUTO_LIKE_EMOJI: ['💜', '⚡', '🌟', '✨', '💫', '🔮', '👾', '🎯'],
};

// ==================== STATE ====================
const activeSockets = new Map();
const socketCreationTime = new Map();
const qrDataMap = new Map();
const SESSION_BASE_PATH = './sessions';
if (!fs.existsSync(SESSION_BASE_PATH)) fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });

// ==================== HELPERS ====================
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n${footer || config.BOT_FOOTER}`;
}
async function totalcmds() {
    try {
        const text = await fs.readFile('./pair.js', 'utf-8');
        let count = 0;
        for (const line of text.split('\n')) {
            if (line.trim().startsWith('//') || line.trim().startsWith('/*')) continue;
            if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) count++;
        }
        return count;
    } catch { return 80; }
}

// ==================== CHANNEL HANDLERS ====================
async function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;
        const jid = message.key.remoteJid;
        if (jid !== config.CHANNEL_JID) return;
        if (config.AUTO_REACT_CHANNEL) {
            try {
                const emojis = ['💜', '⚡', '🌟', '✨', '🔮'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                const messageId = message.newsletterServerId;
                if (messageId) {
                    for (let i = 0; i < 3; i++) {
                        try { await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji); break; }
                        catch { await delay(1500); }
                    }
                }
            } catch {}
        }
    });
}

// ==================== STATUS HANDLERS ====================
async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
        try {
            if (config.AUTO_RECORDING) await socket.sendPresenceUpdate('recording', message.key.remoteJid);
            if (config.AUTO_VIEW_STATUS) await socket.readMessages([message.key]);
            if (config.AUTO_LIKE_STATUS) {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
            }
        } catch {}
    });
}

// ==================== COMMAND HANDLERS ====================
function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const type = getContentType(msg.message);
        msg.message = (type === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;

        const m = sms(socket, msg);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');

        const body =
            (type === 'conversation') ? msg.message.conversation
            : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage?.text
            : (type === 'imageMessage') ? msg.message.imageMessage?.caption
            : (type === 'videoMessage') ? msg.message.videoMessage?.caption
            : (type === 'interactiveResponseMessage')
                ? (() => { try { return msg.message.interactiveResponseMessage?.nativeFlowResponseMessage && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson || '{}')?.id; } catch { return ''; } })()
            : (type === 'buttonsResponseMessage') ? msg.message.buttonsResponseMessage?.selectedButtonId
            : (type === 'listResponseMessage') ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
            : (type === 'templateButtonReplyMessage') ? msg.message.templateButtonReplyMessage?.selectedId
            : '';

        if (!body) return;

        const sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net') : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const botNumber = socket.user.id.split(':')[0];
        const isBot = botNumber === senderNumber;
        const isOwner = isBot;
        const prefix = config.PREFIX;
        const isCmd = body.startsWith(prefix);
        if (!isCmd) return;

        const command = body.slice(prefix.length).trim().split(' ').shift().toLowerCase();
        const args = body.trim().split(/ +/).slice(1);
        const q = args.join(' ');

        const channelContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.CHANNEL_JID,
                newsletterName: config.BOT_NAME,
                serverMessageId: Math.floor(Math.random() * 9999)
            }
        };

        const fakevCard = {
            key: { fromMe: false, participant: '0@s.whatsapp.net', remoteJid: 'status@broadcast' },
            message: { contactMessage: { displayName: config.BOT_NAME, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${config.BOT_NAME}\nORG:Nexa;\nTEL;type=CELL;waid=94000000000:+94000000000\nEND:VCARD` } }
        };

        async function isGroupAdmin(jid, user) {
            try {
                const meta = await socket.groupMetadata(jid);
                const p = meta.participants.find(p => p.id === user);
                return p?.admin === 'admin' || p?.admin === 'superadmin' || false;
            } catch { return false; }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;
        const count = await totalcmds();

        try {
            switch (command) {

// ==================== ALIVE ====================
case 'alive': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), min = Math.floor((uptime % 3600) / 60), sec = Math.floor(uptime % 60);
    await socket.sendMessage(sender, {
        image: { url: config.BOT_LOGO },
        caption: `╭━━━━━━━━━━━━━━━⭓\n│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑶𝑵𝑳𝑰𝑵𝑬*\n│\n│ 🕒 ᴜᴘᴛɪᴍᴇ: ${h}h ${min}m ${sec}s\n│ 📱 ɴᴜᴍ: ${number}\n│ 🤖 ᴀᴄᴛɪᴠᴇ: ${activeSockets.size}\n│ 💾 ᴍᴇᴍ: ${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB\n│ 📦 ᴄᴍᴅs: ${count}\n│ 🔖 ᴠ${config.version}\n╰━━━━━━━━━━━━━━━⭓\n${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== MENU ====================
case 'menu': {
    await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), min = Math.floor((uptime % 3600) / 60);
    const usedMem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    await socket.sendMessage(from, {
        image: { url: config.BOT_LOGO },
        caption: `╭━━━━━━━━━━━━━━━⭓\n│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑴𝒆𝒏𝒖*\n│ 👤 @${sender.split('@')[0]}\n│ 🕒 ${h}h ${min}m │ 💾 ${usedMem}MB\n│ 📦 ${count} ᴄᴍᴅs │ 🔖 ${prefix}\n╰━━━━━━━━━━━━━━━⭓\n\n⭓『 🌐 ɢᴇɴᴇʀᴀʟ 』\n│ alive│ping│stats│fancy│pair│repo│fc\n\n⭓『 📥 ᴅᴏᴡɴʟᴏᴀᴅ 』\n│ song│ytmp4│tiktok│fb│ig│twitter\n│ pinterest│apk│tourl2│sticker\n\n⭓『 👥 ɢʀᴏᴜᴘ 』\n│ add│kick│promote│demote│open│close\n│ tagall│hidetag│kickall│invite│join\n│ setname│setdesc│revoke│groupinfo\n\n⭓『 🔧 ᴛᴏᴏʟs 』\n│ ai│aiimg│pp│winfo│weather│shorturl\n│ qr│calc│translate│tts│lyrics│savestatus\n│ viewonce│sticker│tourl2\n\n⭓『 🎭 ғᴜɴ 』\n│ joke│quote│fact│meme│waifu│roast\n│ lovequote│8ball│truth│dare│rps│flip\n│ dice│rate│compliment│cat│dog│nasa\n\n⭓『 📰 ɴᴇᴡs 』\n│ news│gossip│cricket\n\n${config.BOT_FOOTER}`,
        mentions: [nowsender],
        contextInfo: channelContext
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    break;
}

// ==================== ALLMENU ====================
case 'allmenu': {
    await socket.sendMessage(sender, { react: { text: '📋', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), min = Math.floor((uptime % 3600) / 60), sec = Math.floor(uptime % 60);
    await socket.sendMessage(from, {
        image: { url: config.BOT_LOGO },
        caption: `╭━━━━━━━━━━━━━━━⭓\n│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑭𝒖𝒍𝒍 𝑴𝒆𝒏𝒖*\n│ 👤 @${sender.split('@')[0]}\n│ 🕒 ${h}h ${min}m ${sec}s │ 📦 ${count} ᴄᴍᴅs\n╰━━━━━━━━━━━━━━━⭓\n\n⭓━『 🌐 ɢᴇɴᴇʀᴀʟ 』\n⬡ alive ⬡ menu ⬡ allmenu ⬡ ping\n⬡ stats ⬡ pair ⬡ fancy ⬡ repo ⬡ fc\n\n⭓━『 📥 ᴅᴏᴡɴʟᴏᴀᴅ 』\n⬡ song ⬡ ytmp4 ⬡ tiktok ⬡ fb ⬡ ig\n⬡ twitter ⬡ pinterest ⬡ apk\n⬡ sticker ⬡ tourl2\n\n⭓━『 👥 ɢʀᴏᴜᴘ 』\n⬡ add ⬡ kick ⬡ promote ⬡ demote\n⬡ open ⬡ close ⬡ tagall ⬡ hidetag\n⬡ kickall ⬡ invite ⬡ revoke ⬡ join\n⬡ setname ⬡ setdesc ⬡ groupinfo\n\n⭓━『 🔧 ᴛᴏᴏʟs 』\n⬡ ai ⬡ aiimg ⬡ pp ⬡ winfo ⬡ weather\n⬡ shorturl ⬡ qr ⬡ calc ⬡ translate\n⬡ tts ⬡ lyrics ⬡ savestatus ⬡ viewonce\n\n⭓━『 🎭 ғᴜɴ 』\n⬡ joke ⬡ quote ⬡ fact ⬡ meme ⬡ waifu\n⬡ roast ⬡ lovequote ⬡ 8ball ⬡ truth\n⬡ dare ⬡ rps ⬡ flip ⬡ dice ⬡ rate\n⬡ compliment ⬡ cat ⬡ dog\n\n⭓━『 📰 ɴᴇᴡs 』\n⬡ news ⬡ gossip ⬡ cricket ⬡ nasa\n\n${config.BOT_FOOTER}`,
        mentions: [nowsender],
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== STATS ====================
case 'stats': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600), min = Math.floor((uptime % 3600) / 60), sec = Math.floor(uptime % 60);
    await socket.sendMessage(sender, {
        image: { url: config.BOT_LOGO },
        caption: `╭━━━━━━━━━━━━━━━⭓\n│ 📊 *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑺𝒕𝒂𝒕𝒔*\n│\n│ 🕒 ᴜᴘᴛɪᴍᴇ: ${h}h ${min}m ${sec}s\n│ 💾 ᴍᴇᴍ: ${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB / ${Math.round(os.totalmem()/1024/1024)}MB\n│ 🖥️ ᴄᴘᴜ: ${os.cpus()[0]?.model?.slice(0,25)}\n│ 👥 ᴀᴄᴛɪᴠᴇ: ${activeSockets.size}\n│ 📦 ᴄᴍᴅs: ${count}\n│ 🔖 ᴠᴇʀsɪᴏɴ: ${config.version}\n│ 🌐 ɴᴏᴅᴇ: ${process.version}\n╰━━━━━━━━━━━━━━━⭓\n${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== PING ====================
case 'ping': {
    const start = Date.now();
    const pingMsg = await socket.sendMessage(sender, { text: '📡 *ᴘɪɴɢɪɴɢ...*' });
    const speed = Date.now() - start;
    await socket.sendMessage(sender, { text: `🏓 *Pong!*\n⚡ Speed: *${speed}ms*\n🌐 Status: *Online*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    break;
}

// ==================== PAIR ====================
case 'pair': {
    await socket.sendMessage(sender, { react: { text: '📲', key: msg.key } });
    const pairNum = q.replace(/[^0-9]/g, '');
    if (!pairNum || pairNum.length < 7) return await socket.sendMessage(sender, { text: `📌 *ᴜsᴀɢᴇ:* ${prefix}pair 94xxxxxxxxx` }, { quoted: msg });
    try {
        const pairSessionPath = path.join('./sessions', `session_${pairNum}`);
        try { if (fs.existsSync(pairSessionPath)) fs.removeSync(pairSessionPath); } catch {}
        fs.ensureDirSync(pairSessionPath);
        const { state: ps, saveCreds: psc } = await useMultiFileAuthState(pairSessionPath);
        const pLogger = pino({ level: 'silent' });
        const pSocket = makeWASocket({ auth: { creds: ps.creds, keys: makeCacheableSignalKeyStore(ps.keys, pLogger) }, printQRInTerminal: false, logger: pLogger, browser: Browsers.macOS('Safari'), syncFullHistory: false, markOnlineOnConnect: false });
        pSocket.ev.on('creds.update', psc);
        await delay(3000);
        const code = await pSocket.requestPairingCode(pairNum);
        const fmtCode = code?.includes('-') ? code : code?.match(/.{1,4}/g)?.join('-') || code;
        await socket.sendMessage(sender, { text: `⚡ *Nexa Bot Pair Code*\n\n🔑 *ᴄᴏᴅᴇ:* \`${fmtCode}\`\n\n📌 Open WhatsApp → Linked Devices → Link with phone number\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        setupStatusHandlers(pSocket); setupCommandHandlers(pSocket, pairNum); setupNewsletterHandlers(pSocket);
        pSocket.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                activeSockets.set(pairNum, pSocket); socketCreationTime.set(pairNum, Date.now());
                if (config.AUTO_JOIN_CHANNEL) { try { await pSocket.newsletterFollow(config.CHANNEL_JID); } catch {} }
            }
            if (update.connection === 'close') { activeSockets.delete(pairNum); socketCreationTime.delete(pairNum); }
        });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ᴘᴀɪʀ ᴇʀʀᴏʀ: ${e.message}` }); }
    break;
}

// ==================== FC ====================
case 'fc': {
    const jid = args[0];
    if (!jid || !jid.endsWith('@newsletter')) return await socket.sendMessage(sender, { text: `❗ Usage: ${prefix}fc <jid@newsletter>` });
    try {
        await socket.sendMessage(sender, { react: { text: '📡', key: msg.key } });
        await socket.newsletterFollow(jid);
        await socket.sendMessage(sender, { text: `✅ ғᴏʟʟᴏᴡᴇᴅ: ${jid}` });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}

// ==================== FANCY ====================
case 'fancy': {
    await socket.sendMessage(sender, { react: { text: '🖋', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}fancy <ᴛᴇxᴛ>` });
    try {
        const res = await axios.get(`https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(q)}`);
        if (!res.data?.result) throw new Error('no result');
        const fontList = res.data.result.slice(0,15).map(f => `*${f.name}:*\n${f.result}`).join('\n\n');
        await socket.sendMessage(sender, { text: `🎨 *Nexa Fancy Text*\n\n${fontList}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ fancy failed' }); }
    break;
}

// ==================== SONG ====================
case 'song':
case 'play': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}song <title>` }, { quoted: fakevCard });
    try {
        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        const yts = require('yt-search');
        const ddownr = require('denethdev-ytmp3');
        const search = await yts(q);
        const video = search.videos[0];
        if (!video) throw new Error('not found');
        const dur = `${Math.floor(video.seconds/60)}:${String(Math.floor(video.seconds%60)).padStart(2,'0')}`;
        await socket.sendMessage(sender, { image: { url: video.thumbnail }, caption: `🎵 *${video.title}*\n👤 ${video.author.name}\n⏱ ${dur}\n👁 ${video.views.toLocaleString()}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
        const result = await ddownr.download(video.url, 'mp3');
        const resp = await axios.get(result.downloadUrl, { responseType: 'arraybuffer', timeout: 60000 });
        await socket.sendMessage(sender, { audio: Buffer.from(resp.data), mimetype: 'audio/mpeg', fileName: `${video.title.substring(0,30)}.mp3` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ: ${e.message}` }); }
    break;
}

// ==================== YTMP4 ====================
case 'ytmp4':
case 'ytvideo': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}ytmp4 <title or url>` }, { quoted: fakevCard });
    try {
        await socket.sendMessage(sender, { react: { text: '🎬', key: msg.key } });
        const yts = require('yt-search');
        const search = await yts(q);
        const video = search.videos[0];
        if (!video) throw new Error('not found');
        const dur = `${Math.floor(video.seconds/60)}:${String(Math.floor(video.seconds%60)).padStart(2,'0')}`;
        await socket.sendMessage(sender, { image: { url: video.thumbnail }, caption: `🎬 *${video.title}*\n👤 ${video.author.name}\n⏱ ${dur}\n\n⏳ ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ...\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
        const res = await axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(video.url)}`, { timeout: 30000 });
        const dlUrl = res.data?.data?.dl || res.data?.dl;
        if (!dlUrl) throw new Error('no download url');
        const vidRes = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000 });
        await socket.sendMessage(sender, { video: Buffer.from(vidRes.data), mimetype: 'video/mp4', caption: `🎬 *${video.title}*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ʏᴛᴍᴘ4 ғᴀɪʟᴇᴅ: ${e.message}` }); }
    break;
}

// ==================== TIKTOK ====================
case 'tiktok':
case 'tt': {
    const ttUrl = q.trim();
    if (!ttUrl) return await socket.sendMessage(sender, { text: `📌 ${prefix}tiktok <url>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const res = await axios.get(`https://api.tikwm.com/?url=${encodeURIComponent(ttUrl)}&hd=1`, { timeout: 20000 });
        const d = res.data?.data;
        if (!d) throw new Error('no data');
        await socket.sendMessage(sender, { image: { url: d.cover || config.BOT_LOGO }, caption: `🎬 *${d.title}*\n👤 @${d.author?.unique_id}\n❤️ ${(d.digg_count||0).toLocaleString()}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
        const vidRes = await axios.get(d.play, { responseType: 'arraybuffer', timeout: 60000 });
        await socket.sendMessage(sender, { video: Buffer.from(vidRes.data), mimetype: 'video/mp4', caption: config.BOT_FOOTER }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ TikTok failed: ${e.message}` }); }
    break;
}

// ==================== FACEBOOK ====================
case 'fb':
case 'fbdl': {
    const fbUrl = q.trim();
    if (!fbUrl) return await socket.sendMessage(sender, { text: `📌 ${prefix}fb <url>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(fbUrl)}`, { timeout: 20000 });
        const d = res.data;
        if (!d?.status) throw new Error('no data');
        const vidUrl = d.data?.hd || d.data?.sd || d.data?.video || null;
        if (!vidUrl) throw new Error('no video url');
        const vidRes = await axios.get(vidUrl, { responseType: 'arraybuffer', timeout: 60000 });
        await socket.sendMessage(sender, { video: Buffer.from(vidRes.data), mimetype: 'video/mp4', caption: `📘 *Facebook Video*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ FB ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== INSTAGRAM ====================
case 'ig':
case 'instagram': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}ig <url>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const { igdl } = require('ruhend-scraper');
        const res = await igdl(q);
        if (!res?.data?.[0]?.url) throw new Error('no url');
        const media = res.data[0];
        if (media.type === 'video') {
            const vidRes = await axios.get(media.url, { responseType: 'arraybuffer', timeout: 60000 });
            await socket.sendMessage(sender, { video: Buffer.from(vidRes.data), mimetype: 'video/mp4', caption: config.BOT_FOOTER }, { quoted: fakevCard });
        } else {
            await socket.sendMessage(sender, { image: { url: media.url }, caption: `📸 *Instagram*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        }
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ IG ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== TWITTER/X ====================
case 'twitter':
case 'xdl':
case 'twit': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}twitter <url>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/twitter?url=${encodeURIComponent(q)}`, { timeout: 20000 });
        const d = res.data?.data;
        if (!d) throw new Error('no data');
        const vidUrl = d.video?.[0]?.url || d.url;
        if (!vidUrl) throw new Error('no url');
        const vidRes = await axios.get(vidUrl, { responseType: 'arraybuffer', timeout: 60000 });
        await socket.sendMessage(sender, { video: Buffer.from(vidRes.data), mimetype: 'video/mp4', caption: `🐦 *Twitter/X Video*\n${d.text || ''}\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Twitter ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== PINTEREST ====================
case 'pinterest':
case 'pin': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}pinterest <url or search>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        // If URL, download direct image; if search term, search Pinterest
        if (q.includes('pinterest.com') || q.includes('pin.it')) {
            const res = await axios.get(`https://api.siputzx.my.id/api/d/pinterest?url=${encodeURIComponent(q)}`, { timeout: 20000 });
            const imgUrl = res.data?.data?.image || res.data?.image;
            if (!imgUrl) throw new Error('no image');
            await socket.sendMessage(sender, { image: { url: imgUrl }, caption: `📌 *Pinterest Image*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        } else {
            const res = await axios.get(`https://api.siputzx.my.id/api/s/pinterest?q=${encodeURIComponent(q)}`, { timeout: 20000 });
            const results = res.data?.data;
            if (!results?.length) throw new Error('no results');
            const img = results[0].image || results[0].url;
            await socket.sendMessage(sender, { image: { url: img }, caption: `📌 *Pinterest: ${q}*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        }
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ Pinterest ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== APK ====================
case 'apk': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}apk <app name>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const res = await nodeFetch(`https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(q)}&apikey=free_key@maher_apis`);
        const data = await res.json();
        if (data?.status !== 200 || !data.result) throw new Error('not found');
        const { name, size, dllink, icon } = data.result;
        await socket.sendMessage(sender, { image: { url: icon || config.BOT_LOGO }, caption: `📦 *${name}*\n📏 ${size}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
        const apkRes = await axios.get(dllink, { responseType: 'arraybuffer', timeout: 120000 });
        await socket.sendMessage(sender, { document: Buffer.from(apkRes.data), mimetype: 'application/vnd.android.package-archive', fileName: `${name}.apk`, caption: config.BOT_FOOTER }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ APK ɴᴏᴛ ғᴏᴜɴᴅ` }); }
    break;
}

// ==================== STICKER ====================
case 'sticker':
case 's': {
    await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
    try {
        const target = m.quoted || m;
        const targetMime = target.msg?.mimetype || target.mimetype || '';
        if (!targetMime) return await socket.sendMessage(from, { text: '⚠️ ʀᴇᴘʟʏ ᴡɪᴛʜ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ' });
        if (!/image|video/i.test(targetMime)) return await socket.sendMessage(from, { text: '⚠️ ʀᴇᴘʟʏ ᴡɪᴛʜ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ' });
        const media = await downloadMediaMessage(target, 'buffer');
        if (media) await socket.sendMessage(from, { sticker: media }, { quoted: msg });
    } catch (e) { await socket.sendMessage(from, { text: '❌ sᴛɪᴄᴋᴇʀ ғᴀɪʟᴇᴅ' }); }
    break;
}

// ==================== TOURL2 ====================
case 'tourl2': {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key } });
    try {
        const target = m.quoted;
        if (!target) return await socket.sendMessage(sender, { text: '📌 ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇᴅɪᴀ' });
        const buf = await downloadMediaMessage(target, 'buffer');
        if (!buf) throw new Error('download failed');
        const ext = target.mimetype?.includes('image') ? '.jpg' : target.mimetype?.includes('video') ? '.mp4' : '.bin';
        const name = `file_${Date.now()}${ext}`;
        const tmp = path.join(os.tmpdir(), name);
        fs.writeFileSync(tmp, buf);
        const form = new FormData();
        form.append('fileToUpload', fs.createReadStream(tmp), name);
        form.append('reqtype', 'fileupload');
        const res = await axios.post('https://catbox.moe/user/api.php', form, { headers: form.getHeaders(), timeout: 60000 });
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        await socket.sendMessage(sender, { text: `✅ *ᴜᴘʟᴏᴀᴅᴇᴅ*\n🔗 ${res.data}\n${config.BOT_FOOTER}` }, { quoted: msg });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ᴜᴘʟᴏᴀᴅ ғᴀɪʟᴇᴅ: ${e.message}` }); }
    break;
}

// ==================== VIEW ONCE ====================
case 'viewonce':
case 'vv':
case 'rvo': {
    await socket.sendMessage(sender, { react: { text: '👁️', key: msg.key } });
    try {
        if (!m.quoted) return await socket.sendMessage(sender, { text: '📌 ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ' });
        const quotedMsg = m.quoted.message;
        if (!quotedMsg) throw new Error('no quoted message');
        let fileType = null, mediaMessage = null;
        if (quotedMsg.viewOnceMessageV2) {
            const c = quotedMsg.viewOnceMessageV2.message;
            if (c.imageMessage) { fileType = 'image'; mediaMessage = c.imageMessage; }
            else if (c.videoMessage) { fileType = 'video'; mediaMessage = c.videoMessage; }
        } else if (quotedMsg.imageMessage?.viewOnce) { fileType = 'image'; mediaMessage = quotedMsg.imageMessage; }
        else if (quotedMsg.videoMessage?.viewOnce) { fileType = 'video'; mediaMessage = quotedMsg.videoMessage; }
        if (!fileType) return await socket.sendMessage(sender, { text: '❌ ɴᴏᴛ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ' });
        const stream = await downloadContentFromMessage(mediaMessage, fileType);
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        if (fileType === 'image') await socket.sendMessage(sender, { image: buf, caption: `✨ ʀᴇᴠᴇᴀʟᴇᴅ!\n${config.BOT_FOOTER}` });
        else await socket.sendMessage(sender, { video: buf, caption: `✨ ʀᴇᴠᴇᴀʟᴇᴅ!\n${config.BOT_FOOTER}` });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ᴠɪᴇᴡᴏɴᴄᴇ ᴇʀʀᴏʀ: ${e.message}` }); }
    break;
}

// ==================== SAVE STATUS ====================
case 'savestatus': {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });
    try {
        if (!m.quoted) return await socket.sendMessage(sender, { text: '📌 ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs' });
        const buf = await downloadMediaMessage(m.quoted, 'buffer');
        if (!buf) throw new Error('download failed');
        const ext = m.quoted.mimetype?.includes('image') ? 'jpg' : 'mp4';
        const tmp = path.join(os.tmpdir(), `status_${Date.now()}.${ext}`);
        fs.writeFileSync(tmp, buf);
        await socket.sendMessage(sender, { document: fs.readFileSync(tmp), mimetype: ext === 'jpg' ? 'image/jpeg' : 'video/mp4', fileName: `status.${ext}`, caption: `✅ sᴛᴀᴛᴜs sᴀᴠᴇᴅ!\n${config.BOT_FOOTER}` }, { quoted: msg });
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (e) { await socket.sendMessage(sender, { text: '❌ sᴀᴠᴇsᴛᴀᴛᴜs ғᴀɪʟᴇᴅ' }); }
    break;
}

// ==================== AI ====================
case 'ai': {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}ai <ask me>` });
    try {
        const prompt = `You are Nexa Bot AI. Be helpful, friendly, use emojis. Reply in same language as user. User: ${q}`;
        const res = await axios.get(`https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`, { timeout: 30000 });
        const reply = res.data?.result || res.data?.response || 'ᴄᴏᴜʟᴅɴ\'ᴛ ɢᴇᴛ ʀᴇsᴘᴏɴsᴇ';
        await socket.sendMessage(sender, { image: { url: config.BOT_LOGO }, caption: `🤖 *Nexa AI*\n\n${reply}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ AI ᴇʀʀᴏʀ: ${e.message}` }); }
    break;
}

// ==================== AI IMAGE ====================
case 'aiimg': {
    await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}aiimg <prompt>` });
    try {
        await socket.sendMessage(sender, { text: '🧠 ɢᴇɴᴇʀᴀᴛɪɴɢ...' });
        const res = await axios.get(`https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(q)}`, { responseType: 'arraybuffer', timeout: 30000 });
        await socket.sendMessage(sender, { image: Buffer.from(res.data), caption: `🎨 *AI Image*\n📌 ${q}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ AI Image ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== QR GENERATOR ====================
case 'qr':
case 'qrcode': {
    await socket.sendMessage(sender, { react: { text: '📱', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}qr <text or url>` });
    try {
        const qrBuf = await QRCode.toBuffer(q, { errorCorrectionLevel: 'H', width: 512 });
        await socket.sendMessage(sender, { image: qrBuf, caption: `📱 *QR Code Generated*\n📌 ${q.substring(0,80)}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ QR ɢᴇɴᴇʀᴀᴛɪᴏɴ ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== CALCULATOR ====================
case 'calc':
case 'calculate': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}calc <expression>\nExample: ${prefix}calc 5+3*2` });
    try {
        // Safe eval using Function (limited scope)
        const sanitized = q.replace(/[^0-9+\-*/().,% ]/g, '');
        if (!sanitized) throw new Error('invalid expression');
        const result = Function('"use strict"; return (' + sanitized + ')')();
        await socket.sendMessage(sender, { text: `🧮 *Calculator*\n\n📝 ${sanitized}\n💡 = *${result}*\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ɪɴᴠᴀʟɪᴅ ᴇxᴘʀᴇssɪᴏɴ` }); }
    break;
}

// ==================== TRANSLATE ====================
case 'translate':
case 'tr': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}translate <lang> <text>\nExample: ${prefix}translate si Hello World` });
    try {
        await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
        const parts = q.split(' ');
        const lang = parts[0];
        const text = parts.slice(1).join(' ');
        if (!text) return await socket.sendMessage(sender, { text: `📌 ${prefix}translate <lang> <text>` });
        const res = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${lang}`, { timeout: 15000 });
        const translated = res.data?.responseData?.translatedText;
        if (!translated) throw new Error('translation failed');
        await socket.sendMessage(sender, { text: `🌐 *Translation*\n\n📝 *Original:* ${text}\n🔄 *Translated (${lang}):* ${translated}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ᴛʀᴀɴsʟᴀᴛᴇ ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== TTS ====================
case 'tts': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}tts <text>` });
    await socket.sendMessage(sender, { react: { text: '🔊', key: msg.key } });
    try {
        const parts = q.split(' ');
        let lang = 'en', text = q;
        if (parts[0].length === 2 && /^[a-z]+$/.test(parts[0])) { lang = parts[0]; text = parts.slice(1).join(' '); }
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
        const res = await axios.get(ttsUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
        await socket.sendMessage(sender, { audio: Buffer.from(res.data), mimetype: 'audio/mpeg', ptt: true }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ TTS ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== LYRICS ====================
case 'lyrics': {
    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}lyrics <song name>` });
    try {
        const res = await axios.get(`https://api.siputzx.my.id/api/s/lyrics?q=${encodeURIComponent(q)}`, { timeout: 20000 });
        const d = res.data?.data;
        if (!d?.lyrics) throw new Error('not found');
        const lyrics = d.lyrics.substring(0, 3000);
        await socket.sendMessage(sender, {
            text: `🎵 *${d.title || q}*\n👤 ${d.artist || 'Unknown'}\n\n${lyrics}${d.lyrics.length > 3000 ? '\n...(truncated)' : ''}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ʟʏʀɪᴄs ɴᴏᴛ ғᴏᴜɴᴅ` }); }
    break;
}

// ==================== PROFILE PIC ====================
case 'pp':
case 'getpp': {
    await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let target = sender;
        if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        else if (m.quoted) target = m.quoted.sender;
        const pp = await socket.profilePictureUrl(target, 'image').catch(() => null);
        if (pp) await socket.sendMessage(from, { image: { url: pp }, caption: `👤 @${target.split('@')[0]} Profile Pic\n${config.BOT_FOOTER}`, mentions: [target] });
        else await socket.sendMessage(from, { text: `❌ ɴᴏ ᴘᴘ ᴀᴠᴀɪʟᴀʙʟᴇ` });
    } catch (e) { await socket.sendMessage(from, { text: '❌ ᴘᴘ ғᴀɪʟᴇᴅ' }); }
    break;
}

// ==================== WINFO ====================
case 'winfo': {
    await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
    if (!args[0]) return await socket.sendMessage(sender, { text: `📌 ${prefix}winfo <number>` });
    const inputNum = args[0].replace(/[^0-9]/g, '');
    const jid = `${inputNum}@s.whatsapp.net`;
    try {
        const [user] = await socket.onWhatsApp(jid).catch(() => []);
        if (!user?.exists) return await socket.sendMessage(sender, { text: '❌ ɴᴏᴛ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ' });
        const pp = await socket.profilePictureUrl(jid, 'image').catch(() => config.BOT_LOGO);
        await socket.sendMessage(sender, { image: { url: pp }, caption: `🔍 *User Info*\n📱 +${inputNum}\n💼 ${user.isBusiness ? 'Business' : 'Personal'}\n✅ Registered\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ winfo ᴇʀʀᴏʀ` }); }
    break;
}

// ==================== WEATHER ====================
case 'weather': {
    await socket.sendMessage(sender, { react: { text: '🌦️', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}weather <city>` });
    try {
        const apiKey = '2d61a72574c11c4f36173b627f8cb177';
        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${apiKey}&units=metric`, { timeout: 15000 });
        const d = res.data;
        await socket.sendMessage(sender, { text: `🌍 *${d.name}, ${d.sys.country}*\n🌡️ ${d.main.temp}°C (feels ${d.main.feels_like}°C)\n☁️ ${d.weather[0].description}\n💨 Wind: ${d.wind.speed}m/s\n💧 Humidity: ${d.main.humidity}%\n👁️ Visibility: ${(d.visibility/1000).toFixed(1)}km\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ City not found` }); }
    break;
}

// ==================== SHORTURL ====================
case 'shorturl': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}shorturl <url>` });
    try {
        const res = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(q)}`, { timeout: 10000 });
        await socket.sendMessage(sender, { text: `✅ *Short URL*\n🔗 ${res.data.trim()}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: msg });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ shorturl ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== REPO ====================
case 'repo': {
    await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
    await socket.sendMessage(sender, { image: { url: config.BOT_LOGO }, caption: `╭━━━━━━━━━━━━━━━⭓\n│ ⚡ *Nexa Bot Repo*\n│\n│ 🌐 GitHub:\n│ https://github.com/NexaBot\n│\n│ 📡 Channel:\n│ ${config.CHANNEL_LINK}\n╰━━━━━━━━━━━━━━━⭓\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== GROUP - ADD ====================
case 'add': {
    await socket.sendMessage(sender, { react: { text: '➕', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    if (!args[0]) return await socket.sendMessage(sender, { text: `📌 ${prefix}add <number>` });
    try {
        await socket.groupParticipantsUpdate(from, [args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net'], 'add');
        await socket.sendMessage(sender, { text: `✅ ᴀᴅᴅᴇᴅ ${args[0]}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ add ғᴀɪʟᴇᴅ: ${e.message}` }); }
    break;
}

// ==================== GROUP - KICK ====================
case 'kick': {
    await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let target = m.quoted ? m.quoted.sender : mentionedJid || (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
        if (!target || target === 'undefined@s.whatsapp.net') return await socket.sendMessage(sender, { text: `📌 ${prefix}kick @user or reply` });
        await socket.groupParticipantsUpdate(from, [target], 'remove');
        await socket.sendMessage(sender, { text: `✅ kicked @${target.split('@')[0]}`, mentions: [target] }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ kick ғᴀɪʟᴇᴅ: ${e.message}` }); }
    break;
}

// ==================== GROUP - PROMOTE ====================
case 'promote': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let target = m.quoted ? m.quoted.sender : mentionedJid;
        if (!target) return await socket.sendMessage(sender, { text: `📌 ${prefix}promote @user` });
        await socket.groupParticipantsUpdate(from, [target], 'promote');
        await socket.sendMessage(sender, { text: `✅ ᴘʀᴏᴍᴏᴛᴇᴅ @${target.split('@')[0]}`, mentions: [target] }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ promote ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - DEMOTE ====================
case 'demote': {
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let target = m.quoted ? m.quoted.sender : mentionedJid;
        if (!target) return await socket.sendMessage(sender, { text: `📌 ${prefix}demote @user` });
        await socket.groupParticipantsUpdate(from, [target], 'demote');
        await socket.sendMessage(sender, { text: `✅ ᴅᴇᴍᴏᴛᴇᴅ @${target.split('@')[0]}`, mentions: [target] }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ demote ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - OPEN/CLOSE ====================
case 'open':
case 'unmute': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try { await socket.groupSettingUpdate(from, 'not_announcement'); await socket.sendMessage(sender, { text: '🔓 *ɢʀᴏᴜᴘ ᴏᴘᴇɴᴇᴅ*' }, { quoted: fakevCard }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}

case 'close':
case 'mute': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try { await socket.groupSettingUpdate(from, 'announcement'); await socket.sendMessage(sender, { text: '🔒 *ɢʀᴏᴜᴘ ᴄʟᴏsᴇᴅ*' }, { quoted: fakevCard }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ ${e.message}` }); }
    break;
}

// ==================== GROUP - TAGALL ====================
case 'tagall': {
    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const meta = await socket.groupMetadata(from);
        const mentions = meta.participants.map(p => p.id);
        const text = meta.participants.map(p => `@${p.id.split('@')[0]}`).join('\n');
        await socket.sendMessage(from, { image: { url: config.BOT_LOGO }, caption: `📢 *tagall* - ${meta.subject}\n👥 ${meta.participants.length} members\n${q || ''}\n\n${text}\n\n${config.BOT_FOOTER}`, mentions }, { quoted: msg });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ tagall ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - HIDETAG ====================
case 'hidetag':
case 'everyone': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const meta = await socket.groupMetadata(from);
        const mentions = meta.participants.map(p => p.id);
        await socket.sendMessage(from, { text: q || `📢 *${config.BOT_NAME}*\n${config.BOT_FOOTER}`, mentions }, { quoted: msg });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ hidetag ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - KICKALL ====================
case 'kickall': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isOwner) return await socket.sendMessage(sender, { text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ' });
    try {
        const meta = await socket.groupMetadata(from);
        const botJid = socket.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const toRemove = meta.participants.filter(p => !p.admin && p.id !== botJid).map(p => p.id);
        if (!toRemove.length) return await socket.sendMessage(sender, { text: '❌ ɴᴏ ᴍᴇᴍʙᴇʀs' });
        for (let i = 0; i < toRemove.length; i += 50) { await socket.groupParticipantsUpdate(from, toRemove.slice(i, i+50), 'remove'); await delay(2000); }
        await socket.sendMessage(sender, { text: `✅ ᴋɪᴄᴋᴇᴅ ${toRemove.length} ᴍᴇᴍʙᴇʀs` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ kickall ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - INVITE ====================
case 'invite':
case 'grouplink': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const code = await socket.groupInviteCode(from);
        await socket.sendMessage(sender, { text: `🔗 *Group Link*\nhttps://chat.whatsapp.com/${code}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ invite ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - REVOKE ====================
case 'revoke': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        await socket.groupRevokeInvite(from);
        const newCode = await socket.groupInviteCode(from);
        await socket.sendMessage(sender, { text: `✅ *Link Revoked!*\n🔗 New: https://chat.whatsapp.com/${newCode}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ revoke ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - JOIN ====================
case 'join': {
    if (!isOwner) return await socket.sendMessage(sender, { text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ' });
    if (!args[0]) return await socket.sendMessage(sender, { text: `📌 ${prefix}join <invite link>` });
    try {
        const match = args[0].match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
        if (!match) return await socket.sendMessage(sender, { text: '❌ ɪɴᴠᴀʟɪᴅ ʟɪɴᴋ' });
        await socket.groupAcceptInvite(match[1]);
        await socket.sendMessage(sender, { text: `✅ ᴊᴏɪɴᴇᴅ!` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ join ғᴀɪʟᴇᴅ: ${e.message}` }); }
    break;
}

// ==================== GROUP - SETNAME ====================
case 'setname': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}setname <name>` });
    try { await socket.groupUpdateSubject(from, q); await socket.sendMessage(sender, { text: `✅ ɴᴀᴍᴇ: ${q}` }, { quoted: fakevCard }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ setname ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - SETDESC ====================
case 'setdesc':
case 'description': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}setdesc <description>` });
    try { await socket.groupUpdateDescription(from, q); await socket.sendMessage(sender, { text: `✅ ᴅᴇsᴄ ᴜᴘᴅᴀᴛᴇᴅ!` }, { quoted: fakevCard }); }
    catch (e) { await socket.sendMessage(sender, { text: `❌ setdesc ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - GROUPINFO ====================
case 'groupinfo':
case 'ginfo': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    try {
        const meta = await socket.groupMetadata(from);
        const admins = meta.participants.filter(p => p.admin).map(p => `@${p.id.split('@')[0]}`).join(', ');
        const pp = await socket.profilePictureUrl(from, 'image').catch(() => config.BOT_LOGO);
        await socket.sendMessage(sender, { image: { url: pp }, caption: `╭━━━━━━━━━━━━━━━⭓\n│ 👥 *Group Info*\n│\n│ 📋 ɴᴀᴍᴇ: ${meta.subject}\n│ 🆔 ɪᴅ: ${from.split('@')[0]}\n│ 👥 ᴍᴇᴍʙᴇʀs: ${meta.participants.length}\n│ 👑 ᴀᴅᴍɪɴs: ${admins || 'none'}\n│ 🔒 ᴀɴɴᴏᴜɴᴄᴇ: ${meta.announce ? 'yes' : 'no'}\n│ 📝 ${(meta.desc || 'No description').substring(0,80)}\n╰━━━━━━━━━━━━━━━⭓\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ginfo ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== GROUP - WARN ====================
case 'warn': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!mentionedJid) return await socket.sendMessage(sender, { text: `📌 ${prefix}warn @user` });
    const warnReason = args.slice(1).join(' ') || 'No reason';
    await socket.sendMessage(from, { text: `⚠️ *WARNING*\n\n👤 @${mentionedJid.split('@')[0]}\n📝 ʀᴇᴀsᴏɴ: ${warnReason}\n\n${config.BOT_FOOTER}`, mentions: [mentionedJid] }, { quoted: msg });
    break;
}

// ==================== NEWS ====================
case 'news': {
    await socket.sendMessage(sender, { react: { text: '📰', key: msg.key } });
    try {
        const res = await nodeFetch('https://suhas-bro-api.vercel.app/news/lnw');
        const data = await res.json();
        const { title, desc, date, link } = data.result;
        await socket.sendMessage(sender, { text: `📰 *Nexa News*\n\n*${title}*\n\n${desc}\n\n📅 ${date}\n🔗 ${link}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ ɴᴇᴡs ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

case 'gossip': {
    await socket.sendMessage(sender, { react: { text: '💬', key: msg.key } });
    try {
        const res = await nodeFetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
        const data = await res.json();
        const { title, desc, date, link } = data.result;
        await socket.sendMessage(sender, { text: `💬 *Gossip*\n\n*${title}*\n\n${desc}\n\n📅 ${date||''}\n🔗 ${link}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ gossip ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

case 'nasa': {
    try {
        const res = await axios.get('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY', { timeout: 15000 });
        const d = res.data;
        await socket.sendMessage(sender, { image: { url: d.url }, caption: `🚀 *NASA APOD*\n\n*${d.title}*\n📅 ${d.date}\n\n${d.explanation.substring(0,500)}...\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ NASA ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

case 'cricket': {
    await socket.sendMessage(sender, { react: { text: '🏏', key: msg.key } });
    try {
        const res = await nodeFetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
        const data = await res.json();
        const { title, score, to_win, crr, link } = data.result;
        await socket.sendMessage(sender, { text: `🏏 *Cricket*\n\n*${title}*\n\n🏆 ${score}\n🎯 To win: ${to_win}\n📈 CRR: ${crr}\n🔗 ${link}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: `❌ cricket ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` }); }
    break;
}

// ==================== FUN - JOKE ====================
case 'joke': {
    try {
        const res = await nodeFetch('https://official-joke-api.appspot.com/random_joke');
        const d = await res.json();
        await socket.sendMessage(sender, { text: `😂 *Joke*\n\n${d.setup}\n\n*${d.punchline}*\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ joke ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'quote': {
    try {
        const res = await nodeFetch('https://api.quotable.io/random');
        const d = await res.json();
        await socket.sendMessage(sender, { text: `💭 *Quote*\n\n"${d.content}"\n— *${d.author}*\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ quote ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'fact': {
    try {
        const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en', { timeout: 10000 });
        await socket.sendMessage(sender, { text: `🤓 *Random Fact*\n\n${res.data.text}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ fact ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'meme': {
    try {
        const res = await axios.get('https://meme-api.com/gimme', { timeout: 10000 });
        await socket.sendMessage(sender, { image: { url: res.data.url }, caption: `😂 *${res.data.title}*\n👍 ${res.data.ups}\n\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ meme ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'cat': {
    try {
        const res = await axios.get('https://api.thecatapi.com/v1/images/search', { timeout: 10000 });
        await socket.sendMessage(sender, { image: { url: res.data[0].url }, caption: `🐱 *Cute Cat!*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ cat ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'dog': {
    try {
        const res = await axios.get('https://dog.ceo/api/breeds/image/random', { timeout: 10000 });
        await socket.sendMessage(sender, { image: { url: res.data.message }, caption: `🐕 *Cute Dog!*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ dog ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'waifu': {
    try {
        const res = await axios.get('https://api.waifu.pics/sfw/waifu', { timeout: 10000 });
        await socket.sendMessage(sender, { image: { url: res.data.url }, caption: `🌸 *Waifu!*\n${config.BOT_FOOTER}` }, { quoted: fakevCard });
    } catch (e) { await socket.sendMessage(sender, { text: '❌ waifu ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' }); }
    break;
}

case 'roast': {
    const roasts = [
        "ᴀʀᴇ ʏᴏᴜ ᴀ ʙᴏɴᴜs ʟᴇᴠᴇʟ? ʙᴇᴄᴀᴜsᴇ ᴇᴠᴇʀʏᴏɴᴇ sᴋɪᴘs ʏᴏᴜ. 😂",
        "ɪ'ᴅ ᴀɢʀᴇᴇ ᴡɪᴛʜ ʏᴏᴜ ʙᴜᴛ ᴛʜᴇɴ ᴡᴇ'ᴅ ʙᴏᴛʜ ʙᴇ ᴡʀᴏɴɢ. 🔥",
        "ʏᴏᴜ'ʀᴇ ɴᴏᴛ sᴛᴜᴘɪᴅ, ʏᴏᴜ ᴊᴜsᴛ ʜᴀᴠᴇ ʙᴀᴅ ʟᴜᴄᴋ ᴛʜɪɴᴋɪɴɢ. 💀",
        "ɪ ᴡᴏᴜʟᴅ ɪɴsᴜʟᴛ ʏᴏᴜ, ʙᴜᴛ ᴍʏ ᴍᴏᴍ sᴀɪᴅ ɪ'ᴍ ɴᴏᴛ ᴀʟʟᴏᴡᴇᴅ ᴛᴏ ɪɴsᴜʟᴛ ɢᴀʀʙᴀɢᴇ. 😭",
        "ʏᴏᴜ ᴀʀᴇ ᴛʜᴇ ʀᴇᴀsᴏɴ ᴛʜᴇʏ ᴘᴜᴛ ɪɴsᴛʀᴜᴄᴛɪᴏɴs ᴏɴ sʜᴀᴍᴘᴏᴏ. 🤡"
    ];
    await socket.sendMessage(sender, { text: `🔥 *Roast*\n\n${roasts[Math.floor(Math.random()*roasts.length)]}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

case 'lovequote': {
    const quotes = [
        "ɪɴ ʏᴏᴜ, ɪ ʜᴀᴠᴇ ғᴏᴜɴᴅ ᴍʏ sᴀɴᴄᴛᴜᴀʀʏ. ❤️",
        "ʏᴏᴜ ᴀʀᴇ ᴇᴠᴇʀʏ ʀᴇᴀsᴏɴ, ᴇᴠᴇʀʏ ʜᴏᴘᴇ. 💜",
        "ᴛᴏ ʟᴏᴠᴇ ɪs ɴᴏᴛʜɪɴɢ. ᴛᴏ ʙᴇ ʟᴏᴠᴇᴅ ɪs ᴇᴠᴇʀʏᴛʜɪɴɢ. ✨",
        "ᴛʜᴇ ʙᴇsᴛ ᴛʜɪɴɢ ᴛᴏ ʜᴏʟᴅ ᴏɴᴛᴏ ɪɴ ʟɪғᴇ ɪs ᴇᴀᴄʜ ᴏᴛʜᴇʀ. 💑"
    ];
    await socket.sendMessage(sender, { text: `❤️ *Love Quote*\n\n${quotes[Math.floor(Math.random()*quotes.length)]}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - 8BALL ====================
case '8ball': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}8ball <question>` });
    const answers = ['✅ It is certain.', '✅ Without a doubt!', '✅ Yes, definitely!', '✅ Most likely.', '🤔 Reply hazy, try again.', '🤔 Ask again later.', '⛔ Don\'t count on it.', '❌ Very doubtful.', '❌ My sources say no.', '❌ Outlook not so good.'];
    await socket.sendMessage(sender, { text: `🎱 *Magic 8-Ball*\n\n❓ ${q}\n\n${answers[Math.floor(Math.random()*answers.length)]}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - TRUTH ====================
case 'truth': {
    const truths = [
        'ʏᴏᴜʀ ᴍᴏsᴛ ᴇᴍʙᴀʀʀᴀssɪɴɢ ᴍᴏᴍᴇɴᴛ?',
        'ᴡʜᴏ ᴅᴏ ʏᴏᴜ ʜᴀᴠᴇ ᴀ ᴄʀᴜsʜ ᴏɴ?',
        'ᴡʜᴀᴛ ɪs ʏᴏᴜʀ ʙɪɢɢᴇsᴛ ᴡᴇᴀᴋɴᴇss?',
        'ᴡʜᴀᴛ ɪs ᴛʜᴇ ʙɪɢɢᴇsᴛ ʟɪᴇ ʏᴏᴜ\'ᴠᴇ ᴛᴏʟᴅ?',
        'ᴡʜᴀᴛ ɪs ᴏɴᴇ ᴛʜɪɴɢ ɴᴏ ᴏɴᴇ ᴋɴᴏᴡs ᴀʙᴏᴜᴛ ʏᴏᴜ?',
        'ᴡʜᴏ ᴡᴏᴜʟᴅ ʏᴏᴜ ɴᴇᴠᴇʀ ᴡᴀɴᴛ ᴛᴏ ʙᴇ ɪɴ ᴀ ʀᴏᴏᴍ ᴡɪᴛʜ?',
        'ᴡʜᴀᴛ sᴏɴɢ ᴅᴇsᴄʀɪʙᴇs ʏᴏᴜʀ ʟᴏᴠᴇ ʟɪғᴇ?'
    ];
    await socket.sendMessage(sender, { text: `💬 *Truth*\n\n${truths[Math.floor(Math.random()*truths.length)]}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - DARE ====================
case 'dare': {
    const dares = [
        'sᴇɴᴅ ᴀ sᴇʟғɪᴇ ʀɪɢʜᴛ ɴᴏᴡ!',
        'ᴄᴀʟʟ ᴀ ʀᴀɴᴅᴏᴍ ᴘᴇʀsᴏɴ ᴀɴᴅ sɪɴɢ ᴛᴏ ᴛʜᴇᴍ.',
        'ᴘᴜᴛ ɪᴄᴇ ɪɴ ʏᴏᴜʀ sʜɪʀᴛ ғᴏʀ 30 sᴇᴄs.',
        'ᴅᴏ ʏᴏᴜʀ ʙᴇsᴛ ᴅᴀɴᴄᴇ ᴍᴏᴠᴇ.',
        'ᴛʏᴘᴇ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ʏᴏᴜʀ ᴇʟʙᴏᴡ.',
        'ᴛᴀʟᴋ ʟɪᴋᴇ ᴀ ʀᴏʙᴏᴛ ғᴏʀ ᴛʜᴇ ɴᴇxᴛ 3 ᴍɪɴᴜᴛᴇs.',
        'ᴛᴇxᴛ ʏᴏᴜʀ ᴄʀᴜsʜ ᴀ ʜᴇᴀʀᴛ ᴇᴍᴏᴊɪ. 💜'
    ];
    await socket.sendMessage(sender, { text: `⚡ *Dare*\n\n${dares[Math.floor(Math.random()*dares.length)]}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - RPS ====================
case 'rps': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}rps rock/paper/scissors` });
    const choices = ['rock', 'paper', 'scissors'];
    const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
    const userChoice = q.toLowerCase();
    if (!choices.includes(userChoice)) return await socket.sendMessage(sender, { text: `📌 Choose: rock, paper, or scissors` });
    const botChoice = choices[Math.floor(Math.random()*3)];
    let result;
    if (userChoice === botChoice) result = '🤝 Draw!';
    else if ((userChoice==='rock'&&botChoice==='scissors')||(userChoice==='paper'&&botChoice==='rock')||(userChoice==='scissors'&&botChoice==='paper')) result = '🎉 You Win!';
    else result = '😈 Bot Wins!';
    await socket.sendMessage(sender, { text: `🎮 *Rock Paper Scissors*\n\n👤 You: ${emojis[userChoice]} ${userChoice}\n🤖 Bot: ${emojis[botChoice]} ${botChoice}\n\n${result}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - FLIP ====================
case 'flip': {
    const result = Math.random() > 0.5 ? '🪙 Heads!' : '🪙 Tails!';
    await socket.sendMessage(sender, { text: `🪙 *Coin Flip*\n\n${result}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - DICE ====================
case 'dice': {
    const diceCount = Math.min(parseInt(args[0]) || 1, 6);
    const rolls = Array.from({length: diceCount}, () => Math.floor(Math.random()*6)+1);
    const diceEmojis = ['', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
    const result = rolls.map(r => `${diceEmojis[r]} ${r}`).join('\n');
    await socket.sendMessage(sender, { text: `🎲 *Dice Roll*\n\n${result}\n\n🔢 Total: ${rolls.reduce((a,b)=>a+b,0)}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - RATE ====================
case 'rate': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}rate <anything>` });
    const rating = Math.floor(Math.random()*101);
    const bar = '█'.repeat(Math.floor(rating/10)) + '░'.repeat(10-Math.floor(rating/10));
    await socket.sendMessage(sender, { text: `⭐ *Rating*\n\n📌 ${q}\n\n[${bar}] ${rating}%\n\n${rating>=80?'🔥 Amazing!':rating>=60?'✅ Good!':rating>=40?'😐 Average':rating>=20?'😕 Below average':'💀 Terrible!'}\n\n${config.BOT_FOOTER}`, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== FUN - COMPLIMENT ====================
case 'compliment': {
    const compliments = [
        'ʏᴏᴜ ʜᴀᴠᴇ ᴀ ᴡᴀʏ ᴏғ ʟɪɢʜᴛɪɴɢ ᴜᴘ ᴀɴʏ ʀᴏᴏᴍ. ✨',
        'ʏᴏᴜ ᴍᴀᴋᴇ ᴇᴠᴇʀʏᴅᴀʏ ʙᴇᴛᴛᴇʀ ɴᴏ ᴍᴀᴛᴛᴇʀ ʜᴏᴡ ʙᴀᴅ ɪᴛ sᴛᴀʀᴛᴇᴅ. 💜',
        'ʏᴏᴜ ᴀʀᴇ sᴍᴀʀᴛᴇʀ ᴛʜᴀɴ ʏᴏᴜ ᴛʜɪɴᴋ ʏᴏᴜ ᴀʀᴇ. 🧠',
        'ʏᴏᴜʀ sᴍɪʟᴇ ɪs ʟɪᴛᴇʀᴀʟʟʏ ᴄᴏɴᴛᴀɢɪᴏᴜs. 😊',
        'ᴛʜᴇ ᴡᴏʀʟᴅ ɪs ʙᴇᴛᴛᴇʀ ᴡɪᴛʜ ʏᴏᴜ ɪɴ ɪᴛ. 🌍'
    ];
    const target = m.quoted ? `@${m.quoted.sender.split('@')[0]}` : `@${nowsender.split('@')[0]}`;
    const mentions = m.quoted ? [m.quoted.sender] : [nowsender];
    await socket.sendMessage(from, { text: `💌 *Compliment*\n\n${target} - ${compliments[Math.floor(Math.random()*compliments.length)]}\n\n${config.BOT_FOOTER}`, mentions, contextInfo: channelContext }, { quoted: fakevCard });
    break;
}

// ==================== BOMB ====================
case 'bomb': {
    if (!isOwner) return await socket.sendMessage(sender, { text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ' });
    const times = Math.min(parseInt(args[0]) || 5, 20);
    const txt = args.slice(1).join(' ') || '⚡ Nexa Bot ⚡';
    for (let i = 0; i < times; i++) { await socket.sendMessage(sender, { text: txt }); await delay(500); }
    break;
}

            } // end switch
        } catch (error) {
            console.error('Command error:', error);
            try { await socket.sendMessage(sender, { image: { url: config.BOT_LOGO }, caption: `❌ *Command Error*\n${error.message || 'Unknown error'}\n\n${config.BOT_FOOTER}` }); } catch {}
        }
    });
}

// ==================== SOCKET MAKER ====================
function makeNexaSocket(sessionPath, logger) {
    return makeWASocket({
        auth: { creds: undefined, keys: undefined }, // placeholder, overwritten below
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Safari'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
    });
}

// ==================== NEXAPAIR ====================
async function NexaPair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // Clear stale unregistered session - main cause of "Couldn't link device"
    try {
        if (fs.existsSync(sessionPath)) {
            const credsFile = path.join(sessionPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
                const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                if (!creds.registered) { fs.removeSync(sessionPath); console.log(`🗑️ Cleared stale session: ${sanitizedNumber}`); }
            } else { fs.removeSync(sessionPath); }
        }
    } catch (e) { try { fs.removeSync(sessionPath); } catch {} }

    fs.ensureDirSync(sessionPath);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    try {
        const socket = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 25000,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' }),
        });

        socketCreationTime.set(sanitizedNumber, Date.now());
        socket.ev.on('creds.update', saveCreds);

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);

        if (!socket.authState.creds.registered) {
            // ✅ PROVEN FIX: Wait 3s for WA server handshake, then request code
            // Do NOT wait for QR event - that causes timing failures
            await delay(3000);

            let code;
            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    code = await socket.requestPairingCode(sanitizedNumber);
                    if (code && !code.includes('-')) code = code.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`✅ Pair code: ${sanitizedNumber} → ${code}`);
                    break;
                } catch (error) {
                    console.warn(`Pair retry ${config.MAX_RETRIES - retries + 1}: ${error.message}`);
                    retries--;
                    if (retries > 0) await delay(3000);
                }
            }

            if (!res.headersSent) {
                if (code) res.send({ code });
                else { res.status(503).send({ error: 'Failed to generate code. Try again.' }); return; }
            }
        } else {
            if (!res.headersSent) res.send({ status: 'already_registered' });
        }

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                activeSockets.set(sanitizedNumber, socket);
                socketCreationTime.set(sanitizedNumber, Date.now());
                console.log(`✅ Connected: ${sanitizedNumber}`);

                if (config.AUTO_JOIN_CHANNEL) {
                    try { await socket.newsletterFollow(config.CHANNEL_JID); console.log(`📡 Channel followed`); } catch {}
                }

                try {
                    const userJid = jidNormalizedUser(socket.user.id);
                    await socket.sendMessage(userJid, {
                        image: { url: config.BOT_LOGO },
                        caption: `╭━━━━━━━━━━━━━━━⭓\n│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑪𝒐𝒏𝒏𝒆𝒄𝒕𝒆𝒅!*\n│\n│ 📱 ɴᴜᴍ: ${sanitizedNumber}\n│ 🕒 ${new Date().toLocaleString()}\n│ 🔖 ᴠ${config.version}\n│ 📦 .menu ᴛᴏ sᴛᴀʀᴛ\n╰━━━━━━━━━━━━━━━⭓\n${config.BOT_FOOTER}`
                    });
                } catch {}
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log(`🔁 Reconnecting: ${sanitizedNumber}`);
                    await delay(5000);
                    const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
                    NexaPair(sanitizedNumber, mockRes);
                } else {
                    console.log(`🚪 Logged out: ${sanitizedNumber}`);
                    try { fs.removeSync(sessionPath); } catch {}
                }
            }
        });

    } catch (error) {
        console.error('NexaPair error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable. Try again.' });
    }
}

// ==================== NEXAQR ====================
async function NexaQR(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_qr_${sanitizedNumber}`);
    fs.ensureDirSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    const socket = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Safari'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
    });

    socket.ev.on('creds.update', saveCreds);
    let qrSent = false;

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !qrSent) {
            qrSent = true;
            try {
                const qrDataUrl = await QRCode.toDataURL(qr);
                qrDataMap.set(sanitizedNumber, qrDataUrl);
                if (!res.headersSent) res.send({ qr: qrDataUrl });
            } catch {}
        }

        if (connection === 'open') {
            activeSockets.set(sanitizedNumber, socket);
            socketCreationTime.set(sanitizedNumber, Date.now());
            qrDataMap.delete(sanitizedNumber);
            setupStatusHandlers(socket);
            setupCommandHandlers(socket, sanitizedNumber);
            setupNewsletterHandlers(socket);
            if (config.AUTO_JOIN_CHANNEL) { try { await socket.newsletterFollow(config.CHANNEL_JID); } catch {} }
            try {
                const userJid = jidNormalizedUser(socket.user.id);
                await socket.sendMessage(userJid, { image: { url: config.BOT_LOGO }, caption: `⚡ *Nexa Bot Connected via QR!*\n📱 ${sanitizedNumber}\n🕒 ${new Date().toLocaleString()}\n\n${config.BOT_FOOTER}` });
            } catch {}
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            if (statusCode !== DisconnectReason.loggedOut) {
                await delay(5000);
                const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
                NexaQR(sanitizedNumber, mockRes);
            } else { try { fs.removeSync(sessionPath); } catch {} }
        }
    });
}

// ==================== AUTO RECONNECT ====================
async function autoReconnect() {
    try {
        if (!fs.existsSync(SESSION_BASE_PATH)) return;
        const sessionDirs = fs.readdirSync(SESSION_BASE_PATH).filter(d => d.startsWith('session_'));
        for (const dir of sessionDirs) {
            const isQR = dir.startsWith('session_qr_');
            const num = isQR ? dir.replace('session_qr_', '') : dir.replace('session_', '');
            if (!num || activeSockets.has(num)) continue;
            // Only reconnect if session is registered
            try {
                const credsFile = path.join(SESSION_BASE_PATH, dir, 'creds.json');
                if (!fs.existsSync(credsFile)) continue;
                const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                if (!creds.registered) continue; // skip unregistered sessions
            } catch { continue; }
            const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
            if (isQR) NexaQR(num, mockRes);
            else NexaPair(num, mockRes);
            await delay(2000);
        }
    } catch (e) { console.error('Auto reconnect error:', e.message); }
}

autoReconnect();

// ==================== ROUTES ====================
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) return res.status(200).send({ status: 'already_connected', message: `${sanitized} already connected` });
    await NexaPair(sanitized, res);
});

router.get('/qr', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) return res.status(200).send({ status: 'already_connected' });
    await NexaQR(sanitized, res);
});

router.get('/active', (req, res) => {
    res.send({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

router.get('/ping', (req, res) => {
    res.send({ status: 'active', bot: config.BOT_NAME, version: config.version, active: activeSockets.size });
});

module.exports = router;
