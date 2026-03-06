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
// node-fetch compatibility wrapper using axios (avoids ESM issues with node-fetch v3)
const nodeFetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const res = await axios({
        url,
        method,
        data: opts.body || undefined,
        headers: opts.headers || {},
        responseType: 'arraybuffer',
        timeout: 15000
    });
    const raw = res.data;
    return {
        json: async () => JSON.parse(Buffer.from(raw).toString('utf-8')),
        arrayBuffer: async () => raw,
        text: async () => Buffer.from(raw).toString('utf-8'),
        ok: res.status >= 200 && res.status < 300,
        status: res.status
    };
};

// ==================== NEXA BOT CONFIG ====================
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
    AUTO_FORWARD_CHANNEL: true,
    MAX_RETRIES: 3,
    version: '2.0.0',
    BOT_FOOTER: '> 𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 ⚡',
    AUTO_LIKE_EMOJI: ['💜', '⚡', '🌟', '✨', '💫', '🔮', '👾', '🎯'],
};

// ==================== STATE ====================
const activeSockets = new Map();
const socketCreationTime = new Map();
const qrDataMap = new Map();
const SESSION_BASE_PATH = './sessions';

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// ==================== HELPERS ====================
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n${footer || config.BOT_FOOTER}`;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

// Count total commands
async function totalcmds() {
    try {
        const text = await fs.readFile('./pair.js', 'utf-8');
        const lines = text.split('\n');
        let count = 0;
        for (const line of lines) {
            if (line.trim().startsWith('//') || line.trim().startsWith('/*')) continue;
            if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) count++;
        }
        return count;
    } catch { return 0; }
}

// ==================== NEWSLETTER / CHANNEL ====================
async function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const jid = message.key.remoteJid;
        if (jid !== config.CHANNEL_JID) return;

        // Auto React to channel
        if (config.AUTO_REACT_CHANNEL) {
            try {
                const emojis = ['💜', '⚡', '🌟', '✨', '🔮'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                const messageId = message.newsletterServerId;
                if (messageId) {
                    let retries = 3;
                    while (retries-- > 0) {
                        try {
                            await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                            console.log(`✅ Reacted to channel ${jid} with ${randomEmoji}`);
                            break;
                        } catch (err) {
                            await delay(1500);
                        }
                    }
                }
            } catch (error) {
                console.error('Channel reaction error:', error.message);
            }
        }
    });
}

// ==================== STATUS HANDLERS ====================
async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;

        try {
            if (config.AUTO_RECORDING) {
                await socket.sendPresenceUpdate('recording', message.key.remoteJid);
            }
            if (config.AUTO_VIEW_STATUS) {
                await socket.readMessages([message.key]);
            }
            if (config.AUTO_LIKE_STATUS) {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                await socket.sendMessage(
                    message.key.remoteJid,
                    { react: { text: randomEmoji, key: message.key } },
                    { statusJidList: [message.key.participant] }
                );
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
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

        const quoted = type === 'extendedTextMessage' && msg.message.extendedTextMessage?.contextInfo?.quotedMessage
            ? msg.message.extendedTextMessage.contextInfo.quotedMessage : [];

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
        const nowsender = msg.key.fromMe
            ? (socket.user.id.split(':')[0] + '@s.whatsapp.net')
            : (msg.key.participant || msg.key.remoteJid);
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

        // Channel forward context
        const channelContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.CHANNEL_JID,
                newsletterName: config.BOT_NAME,
                serverMessageId: Math.floor(Math.random() * 9999)
            }
        };

        // Fake vCard for quoting
        const fakevCard = {
            key: { fromMe: false, participant: '0@s.whatsapp.net', remoteJid: 'status@broadcast' },
            message: {
                contactMessage: {
                    displayName: config.BOT_NAME,
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${config.BOT_NAME}\nORG:Nexa;\nTEL;type=CELL;waid=94000000000:+94000000000\nEND:VCARD`
                }
            }
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
    const h = Math.floor(uptime / 3600);
    const min = Math.floor((uptime % 3600) / 60);
    const sec = Math.floor(uptime % 60);

    const captionText = `
╭━━━━━━━━━━━━━━━⭓
│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑶𝑵𝑳𝑰𝑵𝑬*
│
│ 🕒 ᴜᴘᴛɪᴍᴇ: ${h}h ${min}m ${sec}s
│ 📱 ɴᴜᴍʙᴇʀ: ${number}
│ 🤖 ᴀᴄᴛɪᴠᴇ ᴜsᴇʀs: ${activeSockets.size}
│ 💾 ᴍᴇᴍᴏʀʏ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
│ 🔖 ᴠᴇʀsɪᴏɴ: ${config.version}
╰━━━━━━━━━━━━━━━⭓
${config.BOT_FOOTER}`;

    await socket.sendMessage(sender, {
        image: { url: config.BOT_LOGO },
        caption: captionText,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== MENU ====================
case 'menu': {
    await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const min = Math.floor((uptime % 3600) / 60);
    const usedMem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    const menuCaption = `
╭━━━━━━━━━━━━━━━⭓
│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑴𝒆𝒏𝒖*
│ 👤 ᴜsᴇʀ: @${sender.split('@')[0]}
│ 🕒 ᴜᴘᴛɪᴍᴇ: ${h}h ${min}m
│ 💾 ᴍᴇᴍᴏʀʏ: ${usedMem}MB
│ 📦 ᴄᴍᴅs: ${count}
│ 🔖 ᴘʀᴇғɪx: ${prefix}
╰━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 🌐 ɢᴇɴᴇʀᴀʟ 』
│ ⬡ alive │ ⬡ ping  │ ⬡ stats
│ ⬡ fancy │ ⬡ pair  │ ⬡ repo
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 📥 ᴅᴏᴡɴʟᴏᴀᴅ 』
│ ⬡ song  │ ⬡ tiktok │ ⬡ fb
│ ⬡ ig    │ ⬡ apk    │ ⬡ tourl2
│ ⬡ sticker
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 👥 ɢʀᴏᴜᴘ 』
│ ⬡ add    │ ⬡ kick   │ ⬡ open
│ ⬡ close  │ ⬡ promote│ ⬡ demote
│ ⬡ tagall │ ⬡ kickall│ ⬡ warn
│ ⬡ invite │ ⬡ setname
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 🔧 ᴛᴏᴏʟs 』
│ ⬡ ai     │ ⬡ aiimg  │ ⬡ pp
│ ⬡ winfo  │ ⬡ weather│ ⬡ shorturl
│ ⬡ savestatus │ ⬡ viewonce
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 🎭 ғᴜɴ & 📰 ɴᴇᴡs 』
│ ⬡ joke  │ ⬡ quote │ ⬡ fact
│ ⬡ meme  │ ⬡ waifu │ ⬡ roast
│ ⬡ news  │ ⬡ gossip│ ⬡ nasa
╰━━━━━━━━━━━━━━━━⭓
${config.BOT_FOOTER}`;

    await socket.sendMessage(from, {
        image: { url: config.BOT_LOGO },
        caption: menuCaption,
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
    const h = Math.floor(uptime / 3600);
    const min = Math.floor((uptime % 3600) / 60);
    const sec = Math.floor(uptime % 60);

    const allText = `
╭━━━━━━━━━━━━━━━⭓
│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑨𝒍𝒍 𝑪𝒎𝒅𝒔*
│ 👤 @${sender.split('@')[0]}
│ 🕒 ᴜᴘᴛɪᴍᴇ: ${h}h ${min}m ${sec}s
│ 📦 ᴛᴏᴛᴀʟ ᴄᴍᴅs: ${count}
│ 🔖 ᴘʀᴇғɪx: ${prefix}
╰━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 🌐 ɢᴇɴᴇʀᴀʟ 』
│ ⬡ alive │ ⬡ menu │ ⬡ allmenu
│ ⬡ ping  │ ⬡ stats │ ⬡ pair
│ ⬡ fancy │ ⬡ repo  │ ⬡ fc
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 📥 ᴅᴏᴡɴʟᴏᴀᴅ 』
│ ⬡ song  │ ⬡ tiktok │ ⬡ fb
│ ⬡ ig    │ ⬡ aiimg  │ ⬡ apk
│ ⬡ tourl2│ ⬡ sticker
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 👥 ɢʀᴏᴜᴘ 』
│ ⬡ add    │ ⬡ kick   │ ⬡ open
│ ⬡ close  │ ⬡ promote│ ⬡ demote
│ ⬡ tagall │ ⬡ kickall│ ⬡ join
│ ⬡ warn   │ ⬡ invite │ ⬡ setname
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 🔧 ᴛᴏᴏʟs 』
│ ⬡ ai      │ ⬡ aiimg   │ ⬡ pp
│ ⬡ winfo   │ ⬡ weather │ ⬡ whois
│ ⬡ shorturl│ ⬡ savestatus
│ ⬡ viewonce│ ⬡ bomb
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 🎭 ғᴜɴ 』
│ ⬡ joke │ ⬡ quote │ ⬡ fact
│ ⬡ meme │ ⬡ cat   │ ⬡ dog
│ ⬡ roast│ ⬡ waifu │ ⬡ lovequote
╰━━━━━━━━━━━━━━━━⭓

⭓━━━━━━━━━⭓『 📰 ɴᴇᴡs 』
│ ⬡ news │ ⬡ gossip │ ⬡ nasa
│ ⬡ cricket
╰━━━━━━━━━━━━━━━━⭓
${config.BOT_FOOTER}`;

    await socket.sendMessage(from, {
        image: { url: config.BOT_LOGO },
        caption: allText,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== STATS ====================
case 'stats':
case 'bot_stats': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const min = Math.floor((uptime % 3600) / 60);
    const sec = Math.floor(uptime % 60);

    await socket.sendMessage(sender, {
        image: { url: config.BOT_LOGO },
        caption: `
╭━━━━━━━━━━━━━━━⭓
│ 📊 *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑺𝒕𝒂𝒕𝒔*
│
│ 🕒 ᴜᴘᴛɪᴍᴇ: ${h}h ${min}m ${sec}s
│ 💾 ᴍᴇᴍᴏʀʏ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(os.totalmem() / 1024 / 1024)}MB
│ 👥 ᴀᴄᴛɪᴠᴇ: ${activeSockets.size}
│ 📦 ᴄᴍᴅs: ${count}
│ 🔖 ᴠᴇʀsɪᴏɴ: ${config.version}
╰━━━━━━━━━━━━━━━⭓
${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== PING ====================
case 'ping': {
    await socket.sendMessage(sender, { react: { text: '🏓', key: msg.key } });
    const start = Date.now();
    await socket.sendMessage(sender, { text: '⚡ ᴘɪɴɢɪɴɢ...' }, { quoted: msg });
    const latency = Date.now() - start;
    const quality = latency < 100 ? '🟢 ᴇxᴄᴇʟʟᴇɴᴛ' : latency < 300 ? '🟡 ɢᴏᴏᴅ' : '🔴 ᴘᴏᴏʀ';
    await socket.sendMessage(sender, {
        text: `╭━━━━━━━━━━━━━━━⭓\n│ 🏓 *PING*\n│ ⚡ sᴘᴇᴇᴅ: ${latency}ms\n│ ${quality}\n╰━━━━━━━━━━━━━━━⭓\n${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== PAIR ====================
case 'pair': {
    await socket.sendMessage(sender, { react: { text: '📲', key: msg.key } });
    const pairNum = q.replace(/[^0-9]/g, '');
    if (!pairNum || pairNum.length < 7) {
        return await socket.sendMessage(sender, { text: `📌 *ᴜsᴀɢᴇ:* ${prefix}pair 94xxxxxxxxx (ᴄᴏᴜɴᴛʀʏ ᴄᴏᴅᴇ + ɴᴜᴍʙᴇʀ)` }, { quoted: msg });
    }
    if (activeSockets.has(pairNum)) {
        return await socket.sendMessage(sender, { text: `✅ *${pairNum}* ɪs ᴀʟʀᴇᴀᴅʏ ᴄᴏɴɴᴇᴄᴛᴇᴅ!` });
    }
    try {
        // Direct pairing using baileys - generate pair code for the number
        const pairSessionPath = require('path').join('./sessions', `session_${pairNum}`);
        require('fs-extra').ensureDirSync(pairSessionPath);
        const { state: ps, saveCreds: psc } = await require('@whiskeysockets/baileys').useMultiFileAuthState(pairSessionPath);
        const pLogger = require('pino')({ level: 'silent' });
        const { default: makeWASocketDyn, makeCacheableSignalKeyStore: mCSKS, delay: d2, jidNormalizedUser: jNU } = require('@whiskeysockets/baileys');
        const pSocket = makeWASocketDyn({
            auth: { creds: ps.creds, keys: mCSKS(ps.keys, pLogger) },
            printQRInTerminal: false,
            logger: pLogger,
            browser: ['Nexa Bot', 'Chrome', '120.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            getMessage: async () => ({ conversation: '' }),
        });
        pSocket.ev.on('creds.update', psc);
        await d2(1500);
        const code = await pSocket.requestPairingCode(pairNum);
        await socket.sendMessage(sender, {
            text: `⚡ *Nexa Bot Pair Code*\n\n🔑 *ᴄᴏᴅᴇ:* ${code}\n\n📌 ᴏᴘᴇɴ ᴡʜᴀᴛsᴀᴘᴘ → Linked Devices → Link with phone number\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
        // Setup handlers for new socket
        setupStatusHandlers(pSocket);
        setupCommandHandlers(pSocket, pairNum);
        setupNewsletterHandlers(pSocket);
        pSocket.ev.on('connection.update', async (update) => {
            if(update.connection === 'open') {
                activeSockets.set(pairNum, pSocket);
                socketCreationTime.set(pairNum, Date.now());
                if(config.AUTO_JOIN_CHANNEL) { try { await pSocket.newsletterFollow(config.CHANNEL_JID); } catch(e){} }
                const uj = jNU(pSocket.user.id);
                await pSocket.sendMessage(uj, { image:{url:config.BOT_LOGO}, caption:`⚡ Nexa Bot ᴄᴏɴɴᴇᴄᴛᴇᴅ!\n${config.BOT_FOOTER}` });
            }
            if(update.connection === 'close') {
                activeSockets.delete(pairNum);
                socketCreationTime.delete(pairNum);
            }
        });
    } catch (e) {
        console.error('Pair command error:', e);
        await socket.sendMessage(sender, { text: `❌ ᴘᴀɪʀ ᴇʀʀᴏʀ: ${e.message || 'Try again'}` });
    }
    break;
}

case 'fc': {
    const jid = args[0];
    if (!jid || !jid.endsWith('@newsletter')) {
        return await socket.sendMessage(sender, { text: `❗ Usage: ${prefix}fc <jid@newsletter>` });
    }
    try {
        await socket.sendMessage(sender, { react: { text: '📡', key: msg.key } });
        await socket.newsletterFollow(jid);
        await socket.sendMessage(sender, { text: `✅ sᴜᴄᴄᴇssғᴜʟʟʏ ғᴏʟʟᴏᴡᴇᴅ: ${jid}` });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴇʀʀᴏʀ: ${e.message}` });
    }
    break;
}

// ==================== FANCY ====================
case 'fancy': {
    await socket.sendMessage(sender, { react: { text: '🖋', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}fancy <ᴛᴇxᴛ>` });
    try {
        const res = await axios.get(`https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(q)}`);
        if (!res.data?.result) throw new Error('no result');
        const fontList = res.data.result.map(f => `*${f.name}:*\n${f.result}`).join('\n\n');
        await socket.sendMessage(sender, {
            text: `🎨 *Nexa ғᴀɴᴄʏ ᴛᴇxᴛ*\n\n${fontList}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ғᴀɴᴄʏ ғᴀɪʟᴇᴅ!' });
    }
    break;
}

// ==================== SONG ====================
case 'song':
case 'play': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}song <ᴛɪᴛʟᴇ>` }, { quoted: fakevCard });
    try {
        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        const search = await yts(q);
        const video = search.videos[0];
        if (!video) throw new Error('no video');
        const dur = `${Math.floor(video.seconds / 60)}:${String(Math.floor(video.seconds % 60)).padStart(2, '0')}`;
        await socket.sendMessage(sender, {
            image: { url: video.thumbnail },
            caption: `🎵 *${video.title}*\n👤 ${video.author.name}\n⏱ ${dur}\n👁 ${video.views.toLocaleString()}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
        const result = await ddownr.download(video.url, 'mp3');
        const resp = await nodeFetch(result.downloadUrl);
        const buf = Buffer.from(await resp.arrayBuffer());
        await socket.sendMessage(sender, {
            audio: buf,
            mimetype: 'audio/mpeg',
            fileName: `${video.title.substring(0, 30)}.mp3`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ: ${e.message}` });
    }
    break;
}

// ==================== TIKTOK ====================
case 'tiktok': {
    const ttUrl = q.trim();
    if (!ttUrl) return await socket.sendMessage(sender, { text: `📌 ${prefix}tiktok <ᴜʀʟ>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const res = await axios.get(`https://api.tikwm.com/?url=${encodeURIComponent(ttUrl)}&hd=1`);
        const d = res.data?.data;
        if (!d) throw new Error('no data');
        await socket.sendMessage(sender, {
            image: { url: d.cover || config.BOT_LOGO },
            caption: `🎬 *${d.title}*\n👤 @${d.author?.unique_id}\n❤️ ${d.digg_count?.toLocaleString()}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
        const vidRes = await axios.get(d.play, { responseType: 'arraybuffer' });
        await socket.sendMessage(sender, {
            video: Buffer.from(vidRes.data),
            mimetype: 'video/mp4',
            caption: config.BOT_FOOTER
        }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ TikTok ғᴀɪʟᴇᴅ: ${e.message}` });
    }
    break;
}

// ==================== FACEBOOK ====================
case 'fb': {
    const fbUrl = q.trim();
    if (!fbUrl || !/facebook\.com|fb\.watch/.test(fbUrl)) {
        return await socket.sendMessage(sender, { text: '📌 ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ FB ᴜʀʟ' });
    }
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    try {
        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
        await socket.sendMessage(sender, {
            video: { url: res.data.result.sd },
            mimetype: 'video/mp4',
            caption: config.BOT_FOOTER
        }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ FB ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== INSTAGRAM ====================
case 'ig': {
    const igUrl = q.trim();
    if (!igUrl || !/instagram\.com/.test(igUrl)) {
        return await socket.sendMessage(sender, { text: '📌 ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀɴ ɪɢ ᴜʀʟ' });
    }
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    try {
        const { igdl } = require('ruhend-scraper');
        const res = await igdl(igUrl);
        if (res?.data?.[0]?.url) {
            await socket.sendMessage(sender, {
                video: { url: res.data[0].url },
                mimetype: 'video/mp4',
                caption: config.BOT_FOOTER
            }, { quoted: fakevCard });
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } else throw new Error('no url');
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ IG ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== AI ====================
case 'ai': {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}ai <ᴀsᴋ ᴍᴇ>` });
    try {
        const prompt = `You are Nexa Bot AI assistant. Be helpful, friendly and use emojis. Reply in the same language as the user. User: ${q}`;
        const res = await axios.get(`https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`);
        const reply = res.data?.result || res.data?.response || 'ᴄᴏᴜʟᴅɴ\'ᴛ ɢᴇᴛ ᴀɪ ʀᴇsᴘᴏɴsᴇ';
        await socket.sendMessage(sender, {
            image: { url: config.BOT_LOGO },
            caption: `🤖 *Nexa AI*\n\n${reply}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ AI ᴇʀʀᴏʀ: ${e.message}` });
    }
    break;
}

// ==================== AI IMAGE ====================
case 'aiimg': {
    await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}aiimg <ᴘʀᴏᴍᴘᴛ>` });
    try {
        await socket.sendMessage(sender, { text: '🧠 ɢᴇɴᴇʀᴀᴛɪɴɢ...' });
        const res = await axios.get(`https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(q)}`, { responseType: 'arraybuffer' });
        await socket.sendMessage(sender, {
            image: Buffer.from(res.data),
            caption: `🎨 *AI ɪᴍᴀɢᴇ*\n📌 ${q}\n\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ AI ɪᴍᴀɢᴇ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== PROFILE PIC ====================
case 'pp':
case 'getpp':
case 'profilepic': {
    await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let target = sender;
        if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (m.quoted) {
            target = m.quoted.sender;
        }
        const pp = await socket.profilePictureUrl(target, 'image').catch(() => null);
        if (pp) {
            await socket.sendMessage(from, {
                image: { url: pp },
                caption: `👤 @${target.split('@')[0]} ᴘʀᴏғɪʟᴇ ᴘɪᴄ\n${config.BOT_FOOTER}`,
                mentions: [target]
            });
        } else {
            await socket.sendMessage(from, { text: `❌ ɴᴏ ᴘᴘ ᴀᴠᴀɪʟᴀʙʟᴇ` });
        }
    } catch (e) {
        await socket.sendMessage(from, { text: '❌ ᴇʀʀᴏʀ ғᴇᴛᴄʜɪɴɢ ᴘᴘ' });
    }
    break;
}

// ==================== WINFO ====================
case 'winfo': {
    await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
    if (!args[0]) return await socket.sendMessage(sender, { text: `📌 ${prefix}winfo <ɴᴜᴍʙᴇʀ>` });
    const inputNum = args[0].replace(/[^0-9]/g, '');
    const jid = `${inputNum}@s.whatsapp.net`;
    try {
        const [user] = await socket.onWhatsApp(jid).catch(() => []);
        if (!user?.exists) return await socket.sendMessage(sender, { text: '❌ ɴᴏᴛ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ' });
        const pp = await socket.profilePictureUrl(jid, 'image').catch(() => config.BOT_LOGO);
        await socket.sendMessage(sender, {
            image: { url: pp },
            caption: formatMessage('🔍 𝐔𝐒𝐄𝐑 𝐈𝐍𝐅𝐎',
                `📱 ɴᴜᴍʙᴇʀ: +${inputNum}\n💼 ᴛʏᴘᴇ: ${user.isBusiness ? 'Business' : 'Personal'}`,
                config.BOT_FOOTER)
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ winfo ᴇʀʀᴏʀ: ${e.message}` });
    }
    break;
}

// ==================== WEATHER ====================
case 'weather': {
    await socket.sendMessage(sender, { react: { text: '🌦️', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}weather <ᴄɪᴛʏ>` });
    try {
        const apiKey = '2d61a72574c11c4f36173b627f8cb177';
        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${apiKey}&units=metric`);
        const d = res.data;
        await socket.sendMessage(sender, {
            text: `🌍 *${d.name}, ${d.sys.country}*\n🌡️ ${d.main.temp}°C (ғᴇᴇʟs ${d.main.feels_like}°C)\n☁️ ${d.weather[0].description}\n💨 ᴡɪɴᴅ: ${d.wind.speed}m/s\n💧 ʜᴜᴍɪᴅɪᴛʏ: ${d.main.humidity}%\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴄɪᴛʏ ɴᴏᴛ ғᴏᴜɴᴅ` });
    }
    break;
}

// ==================== SHORTURL ====================
case 'shorturl': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}shorturl <ᴜʀʟ>` });
    try {
        const res = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(q)}`, { timeout: 5000 });
        await socket.sendMessage(sender, {
            text: `✅ *sʜᴏʀᴛ ᴜʀʟ*\n🔗 ${res.data.trim()}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ sʜᴏʀᴛᴜʀʟ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== NEWS ====================
case 'news': {
    await socket.sendMessage(sender, { react: { text: '📰', key: msg.key } });
    try {
        const res = await nodeFetch('https://suhas-bro-api.vercel.app/news/lnw');
        const data = await res.json();
        const { title, desc, date, link } = data.result;
        await socket.sendMessage(sender, {
            text: `📰 *Nexa News*\n\n*${title}*\n\n${desc}\n\n📅 ${date}\n🔗 ${link}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ɴᴇᴡs ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== GOSSIP ====================
case 'gossip': {
    await socket.sendMessage(sender, { react: { text: '💬', key: msg.key } });
    try {
        const res = await nodeFetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
        const data = await res.json();
        const { title, desc, date, link } = data.result;
        await socket.sendMessage(sender, {
            text: `💬 *ɢᴏssɪᴘ*\n\n*${title}*\n\n${desc}\n\n📅 ${date || ''}\n🔗 ${link}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ɢᴏssɪᴘ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== NASA ====================
case 'nasa': {
    await socket.sendMessage(sender, { react: { text: '🚀', key: msg.key } });
    try {
        const res = await nodeFetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
        const data = await res.json();
        if (data.media_type === 'image') {
            await socket.sendMessage(sender, {
                image: { url: data.url },
                caption: `🚀 *NASA APOD*\n\n*${data.title}*\n\n${data.explanation.substring(0, 300)}...\n📅 ${data.date}\n\n${config.BOT_FOOTER}`,
                contextInfo: channelContext
            }, { quoted: fakevCard });
        } else {
            await socket.sendMessage(sender, { text: `🚀 *${data.title}*\n${data.explanation.substring(0, 300)}...\n${config.BOT_FOOTER}` });
        }
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ NASA ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== CRICKET ====================
case 'cricket': {
    await socket.sendMessage(sender, { react: { text: '🏏', key: msg.key } });
    try {
        const res = await nodeFetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
        const data = await res.json();
        const { title, score, to_win, crr, link } = data.result;
        await socket.sendMessage(sender, {
            text: `🏏 *ᴄʀɪᴄᴋᴇᴛ ɴᴇᴡs*\n\n*${title}*\n\n🏆 sᴄᴏʀᴇ: ${score}\n🎯 ᴛᴏ ᴡɪɴ: ${to_win}\n📈 ᴄʀʀ: ${crr}\n🔗 ${link}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴄʀɪᴄᴋᴇᴛ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ` });
    }
    break;
}

// ==================== FUN COMMANDS ====================
case 'joke': {
    try {
        const res = await nodeFetch('https://official-joke-api.appspot.com/random_joke');
        const d = await res.json();
        await socket.sendMessage(sender, {
            text: `😂 *Joke*\n\n${d.setup}\n\n${d.punchline}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ᴊᴏᴋᴇ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'quote': {
    try {
        const res = await nodeFetch('https://api.quotable.io/random');
        const d = await res.json();
        await socket.sendMessage(sender, {
            text: `💭 *Quote*\n\n"${d.content}"\n— ${d.author}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ǫᴜᴏᴛᴇ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'cat': {
    try {
        const res = await axios.get('https://api.thecatapi.com/v1/images/search');
        await socket.sendMessage(sender, {
            image: { url: res.data[0].url },
            caption: `🐱 *ᴄᴜᴛᴇ ᴄᴀᴛ!*\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ᴄᴀᴛ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'dog': {
    try {
        const res = await axios.get('https://dog.ceo/api/breeds/image/random');
        await socket.sendMessage(sender, {
            image: { url: res.data.message },
            caption: `🐕 *ᴄᴜᴛᴇ ᴅᴏɢ!*\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ᴅᴏɢ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'fact': {
    try {
        const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
        await socket.sendMessage(sender, {
            text: `💡 *ʀᴀɴᴅᴏᴍ ғᴀᴄᴛ*\n\n${res.data.text}\n\n${config.BOT_FOOTER}`,
            contextInfo: channelContext
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ғᴀᴄᴛ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'meme': {
    try {
        const res = await axios.get('https://meme-api.com/gimme');
        await socket.sendMessage(sender, {
            image: { url: res.data.url },
            caption: `😂 *${res.data.title}*\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ᴍᴇᴍᴇ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'waifu': {
    try {
        const res = await axios.get('https://api.waifu.pics/sfw/waifu');
        await socket.sendMessage(sender, {
            image: { url: res.data.url },
            caption: `🌸 *ᴡᴀɪғᴜ!*\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ ᴡᴀɪғᴜ ʟᴏᴀᴅ ғᴀɪʟᴇᴅ' });
    }
    break;
}

case 'roast': {
    const roasts = [
        "ᴀʀᴇ ʏᴏᴜ ᴀ ʙᴏɴᴜs ʟᴇᴠᴇʟ? ʙᴇᴄᴀᴜsᴇ ᴇᴠᴇʀʏᴏɴᴇ sᴋɪᴘs ʏᴏᴜ.",
        "ᴵ'ᵈ ᵃᵍʳᵉᵉ ʷⁱᵗʰ ʸᵒᵘ ᵇᵘᵗ ᵗʰᵉⁿ ʷᵉ'ᵈ ᵇᵒᵗʰ ᵇᵉ ʷʳᵒⁿᵍ.",
        "ʏᴏᴜ'ʀᴇ ɴᴏᴛ sᴛᴜᴘɪᴅ, ʏᴏᴜ ᴊᴜsᴛ ʜᴀᴠᴇ ʙᴀᴅ ʟᴜᴄᴋ ᴛʜɪɴᴋɪɴɢ.",
    ];
    await socket.sendMessage(sender, {
        text: `🔥 *ʀᴏᴀsᴛ*\n\n${roasts[Math.floor(Math.random() * roasts.length)]}\n\n${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

case 'lovequote': {
    const quotes = [
        "ɪɴ ʏᴏᴜ, ɪ ʜᴀᴠᴇ ғᴏᴜɴᴅ ᴍʏ sᴀɴᴄᴛᴜᴀʀʏ. ❤️",
        "ʏᴏᴜ ᴀʀᴇ ᴇᴠᴇʀʏ ʀᴇᴀsᴏɴ, ᴇᴠᴇʀʏ ʜᴏᴘᴇ. 💜",
        "ᴛᴏ ʟᴏᴠᴇ ɪs ɴᴏᴛʜɪɴɢ. ᴛᴏ ʙᴇ ʟᴏᴠᴇᴅ ɪs sᴏᴍᴇᴛʜɪɴɢ. ✨",
    ];
    await socket.sendMessage(sender, {
        text: `❤️ *ʟᴏᴠᴇ ǫᴜᴏᴛᴇ*\n\n${quotes[Math.floor(Math.random() * quotes.length)]}\n\n${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== VIEW ONCE ====================
case 'viewonce':
case 'vv':
case 'rvo': {
    await socket.sendMessage(sender, { react: { text: '👁️', key: msg.key } });
    try {
        if (!m.quoted) {
            return await socket.sendMessage(sender, { text: '📌 ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ' });
        }
        const quotedMsg = m.quoted.message;
        if (!quotedMsg) throw new Error('no quoted message');

        let fileType = null, mediaMessage = null;
        if (quotedMsg.viewOnceMessageV2) {
            const c = quotedMsg.viewOnceMessageV2.message;
            if (c.imageMessage) { fileType = 'image'; mediaMessage = c.imageMessage; }
            else if (c.videoMessage) { fileType = 'video'; mediaMessage = c.videoMessage; }
        } else if (quotedMsg.imageMessage?.viewOnce) {
            fileType = 'image'; mediaMessage = quotedMsg.imageMessage;
        } else if (quotedMsg.videoMessage?.viewOnce) {
            fileType = 'video'; mediaMessage = quotedMsg.videoMessage;
        }

        if (!fileType) return await socket.sendMessage(sender, { text: '❌ ɴᴏᴛ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ' });

        const stream = await downloadContentFromMessage(mediaMessage, fileType);
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);

        if (fileType === 'image') {
            await socket.sendMessage(sender, { image: buf, caption: `✨ ʀᴇᴠᴇᴀʟᴇᴅ!\n${config.BOT_FOOTER}` });
        } else {
            await socket.sendMessage(sender, { video: buf, caption: `✨ ʀᴇᴠᴇᴀʟᴇᴅ!\n${config.BOT_FOOTER}` });
        }
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴠɪᴇᴡᴏɴᴄᴇ ᴇʀʀᴏʀ: ${e.message}` });
    }
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
        if (/image|video/i.test(targetMime)) {
            const media = await downloadMediaMessage(target, 'buffer');
            if (media) {
                await socket.sendMessage(from, { sticker: media }, { quoted: msg });
            }
        } else {
            return await socket.sendMessage(from, { text: '⚠️ ʀᴇᴘʟʏ ᴡɪᴛʜ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ' });
        }
    } catch (e) {
        await socket.sendMessage(from, { text: '❌ sᴛɪᴄᴋᴇʀ ғᴀɪʟᴇᴅ' });
    }
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
        const res = await axios.post('https://catbox.moe/user/api.php', form, { headers: form.getHeaders() });
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        await socket.sendMessage(sender, {
            text: `✅ *ᴜᴘʟᴏᴀᴅᴇᴅ*\n🔗 ${res.data}\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴜᴘʟᴏᴀᴅ ғᴀɪʟᴇᴅ: ${e.message}` });
    }
    break;
}

// ==================== SAVE STATUS ====================
case 'savestatus': {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });
    try {
        if (!m.quoted) return await socket.sendMessage(sender, { text: '📌 ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs' });
        const buf = await downloadMediaMessage(m.quoted, 'buffer');
        const ext = m.quoted.mimetype?.includes('image') ? 'jpg' : 'mp4';
        const tmp = path.join(os.tmpdir(), `status_${Date.now()}.${ext}`);
        fs.writeFileSync(tmp, buf);
        await socket.sendMessage(sender, {
            document: fs.readFileSync(tmp),
            mimetype: m.quoted.mimetype?.includes('image') ? 'image/jpeg' : 'video/mp4',
            fileName: `status.${ext}`,
            caption: `✅ sᴛᴀᴛᴜs sᴀᴠᴇᴅ!\n${config.BOT_FOOTER}`
        }, { quoted: msg });
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (e) {
        await socket.sendMessage(sender, { text: '❌ sᴀᴠᴇsᴛᴀᴛᴜs ғᴀɪʟᴇᴅ' });
    }
    break;
}

// ==================== REPO ====================
case 'repo': {
    await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
    await socket.sendMessage(sender, {
        image: { url: config.BOT_LOGO },
        caption: `
╭━━━━━━━━━━━━━━━⭓
│ ⚡ *Nexa Bot ʀᴇᴘᴏ*
│
│ 🌐 ɢɪᴛʜᴜʙ ʟɪɴᴋ:
│ https://github.com/NexaBot
│
│ 📡 ᴄʜᴀɴɴᴇʟ:
│ ${config.CHANNEL_LINK}
╰━━━━━━━━━━━━━━━⭓
${config.BOT_FOOTER}`,
        contextInfo: channelContext
    }, { quoted: fakevCard });
    break;
}

// ==================== GROUP COMMANDS ====================
case 'add': {
    await socket.sendMessage(sender, { react: { text: '➕', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    if (!args[0]) return await socket.sendMessage(sender, { text: `📌 ${prefix}add <ɴᴜᴍʙᴇʀ>` });
    try {
        await socket.groupParticipantsUpdate(from, [args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net'], 'add');
        await socket.sendMessage(sender, { text: `✅ ᴀᴅᴅᴇᴅ ${args[0]}` }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴀᴅᴅ ғᴀɪʟᴇᴅ: ${e.message}` });
    }
    break;
}

case 'kick': {
    await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        let target = m.quoted ? m.quoted.sender : (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
        if (!target) return await socket.sendMessage(sender, { text: `📌 ${prefix}kick <ɴᴜᴍ> ᴏʀ ʀᴇᴘʟʏ` });
        await socket.groupParticipantsUpdate(from, [target], 'remove');
        await socket.sendMessage(sender, { text: `✅ ᴋɪᴄᴋᴇᴅ @${target.split('@')[0]}`, mentions: [target] }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴋɪᴄᴋ ғᴀɪʟᴇᴅ: ${e.message}` });
    }
    break;
}

case 'promote': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        let target = m.quoted ? m.quoted.sender : (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
        if (!target) return await socket.sendMessage(sender, { text: `📌 ${prefix}promote` });
        await socket.groupParticipantsUpdate(from, [target], 'promote');
        await socket.sendMessage(sender, { text: `✅ ᴘʀᴏᴍᴏᴛᴇᴅ @${target.split('@')[0]}`, mentions: [target] }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴘʀᴏᴍᴏᴛᴇ ғᴀɪʟᴇᴅ` });
    }
    break;
}

case 'demote': {
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        let target = m.quoted ? m.quoted.sender : (args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
        if (!target) return await socket.sendMessage(sender, { text: `📌 ${prefix}demote` });
        await socket.groupParticipantsUpdate(from, [target], 'demote');
        await socket.sendMessage(sender, { text: `✅ ᴅᴇᴍᴏᴛᴇᴅ @${target.split('@')[0]}`, mentions: [target] }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴅᴇᴍᴏᴛᴇ ғᴀɪʟᴇᴅ` });
    }
    break;
}

case 'open':
case 'unmute': {
    await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        await socket.groupSettingUpdate(from, 'not_announcement');
        await socket.sendMessage(sender, { text: '🔓 *ɢʀᴏᴜᴘ ᴏᴘᴇɴᴇᴅ*' }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴇʀʀᴏʀ: ${e.message}` });
    }
    break;
}

case 'close':
case 'mute': {
    await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        await socket.groupSettingUpdate(from, 'announcement');
        await socket.sendMessage(sender, { text: '🔒 *ɢʀᴏᴜᴘ ᴄʟᴏsᴇᴅ*' }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴇʀʀᴏʀ: ${e.message}` });
    }
    break;
}

case 'tagall': {
    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const meta = await socket.groupMetadata(from);
        const members = meta.participants;
        let mentions = members.map(p => p.id);
        let text = members.map(p => `@${p.id.split('@')[0]}`).join('\n');
        await socket.sendMessage(from, {
            image: { url: config.BOT_LOGO },
            caption: `📢 *ᴛᴀɢᴀʟʟ* - ${meta.subject}\n👥 ${members.length} ᴍᴇᴍʙᴇʀs\n${q || ''}\n\n${text}\n\n${config.BOT_FOOTER}`,
            mentions
        }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴛᴀɢᴀʟʟ ғᴀɪʟᴇᴅ` });
    }
    break;
}

case 'kickall':
case 'removeall': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const meta = await socket.groupMetadata(from);
        const botJid = socket.user?.id;
        const toRemove = meta.participants.filter(p => !p.admin && p.id !== botJid).map(p => p.id);
        if (!toRemove.length) return await socket.sendMessage(sender, { text: '❌ ɴᴏ ᴍᴇᴍʙᴇʀs ᴛᴏ ʀᴇᴍᴏᴠᴇ' });
        for (let i = 0; i < toRemove.length; i += 50) {
            await socket.groupParticipantsUpdate(from, toRemove.slice(i, i + 50), 'remove');
            await delay(2000);
        }
        await socket.sendMessage(sender, { text: `✅ ʀᴇᴍᴏᴠᴇᴅ ${toRemove.length} ᴍᴇᴍʙᴇʀs` }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴋɪᴄᴋᴀʟʟ ғᴀɪʟᴇᴅ` });
    }
    break;
}

case 'invite':
case 'grouplink': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    try {
        const code = await socket.groupInviteCode(from);
        await socket.sendMessage(sender, {
            text: `🔗 *ɢʀᴏᴜᴘ ʟɪɴᴋ*\nhttps://chat.whatsapp.com/${code}\n\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ʟɪɴᴋ ғᴀɪʟᴇᴅ` });
    }
    break;
}

case 'join': {
    if (!isOwner) return await socket.sendMessage(sender, { text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ' });
    if (!args[0]) return await socket.sendMessage(sender, { text: `📌 ${prefix}join <ɪɴᴠɪᴛᴇ ʟɪɴᴋ>` });
    try {
        const match = args[0].match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
        if (!match) return await socket.sendMessage(sender, { text: '❌ ɪɴᴠᴀʟɪᴅ ʟɪɴᴋ' });
        await socket.groupAcceptInvite(match[1]);
        await socket.sendMessage(sender, { text: `✅ ᴊᴏɪɴᴇᴅ!` }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ᴊᴏɪɴ ғᴀɪʟᴇᴅ: ${e.message}` });
    }
    break;
}

case 'setname': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}setname <ɴᴀᴍᴇ>` });
    try {
        await socket.groupUpdateSubject(from, q);
        await socket.sendMessage(sender, { text: `✅ ɴᴀᴍᴇ ᴜᴘᴅᴀᴛᴇᴅ: ${q}` }, { quoted: fakevCard });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ sᴇᴛɴᴀᴍᴇ ғᴀɪʟᴇᴅ` });
    }
    break;
}

case 'warn': {
    if (!isGroup) return await socket.sendMessage(sender, { text: '❌ ɢʀᴏᴜᴘs ᴏɴʟʏ' });
    if (!isSenderGroupAdmin && !isOwner) return await socket.sendMessage(sender, { text: '❌ ᴀᴅᴍɪɴs ᴏɴʟʏ' });
    const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
                      || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!mentionedJid) return await socket.sendMessage(sender, { text: `📌 ${prefix}warn @ᴜsᴇʀ` });
    const warnReason = args.slice(1).join(' ') || 'No reason';
    await socket.sendMessage(from, {
        text: `⚠️ *WARNING*\n\n👤 @${mentionedJid.split('@')[0]}\n📝 ʀᴇᴀsᴏɴ: ${warnReason}\n\n${config.BOT_FOOTER}`,
        mentions: [mentionedJid]
    }, { quoted: msg });
    break;
}

// ==================== APK ====================
case 'apk': {
    if (!q) return await socket.sendMessage(sender, { text: `📌 ${prefix}apk <ᴀᴘᴘ ɴᴀᴍᴇ>` });
    await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    try {
        const res = await nodeFetch(`https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(q)}&apikey=free_key@maher_apis`);
        const data = await res.json();
        if (data?.status !== 200 || !data.result) throw new Error('not found');
        const { name, size, dllink, icon } = data.result;
        await socket.sendMessage(sender, {
            image: { url: icon || config.BOT_LOGO },
            caption: `📦 *${name}*\n📏 ${size}\n\n${config.BOT_FOOTER}`
        }, { quoted: fakevCard });
        const apkRes = await nodeFetch(dllink);
        const buf = Buffer.from(await apkRes.arrayBuffer());
        await socket.sendMessage(sender, {
            document: buf,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name}.apk`,
            caption: config.BOT_FOOTER
        }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ APK ɴᴏᴛ ғᴏᴜɴᴅ` });
    }
    break;
}

// ==================== BOMB ====================
case 'bomb': {
    if (!isOwner) return await socket.sendMessage(sender, { text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ' });
    const times = parseInt(args[0]) || 5;
    const txt = args.slice(1).join(' ') || '⚡ Nexa Bot ⚡';
    for (let i = 0; i < Math.min(times, 20); i++) {
        await socket.sendMessage(sender, { text: txt });
        await delay(500);
    }
    break;
}

            } // end switch
        } catch (error) {
            console.error('Command error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.BOT_LOGO },
                caption: `❌ *ᴄᴏᴍᴍᴀɴᴅ ᴇʀʀᴏʀ*\n${error.message || 'Unknown error'}\n\n${config.BOT_FOOTER}`
            });
        }
    });
}

// ==================== CONNECT HANDLER ====================
async function NexaPair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // ✅ FIX: Clear stale/incomplete session before pairing
    // Old session = phone number mismatch = "Couldn't link device"
    try {
        if (fs.existsSync(sessionPath)) {
            const credsFile = path.join(sessionPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
                const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                if (!creds.registered) {
                    fs.removeSync(sessionPath);
                    console.log(`🗑️ Cleared stale session for ${sanitizedNumber}`);
                }
            } else {
                fs.removeSync(sessionPath);
            }
        }
    } catch (e) {
        try { fs.removeSync(sessionPath); } catch {}
    }

    fs.ensureDirSync(sessionPath);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            // ✅ FIX: macOS Safari browser - most compatible with pairing codes
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

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);

        socket.ev.on('creds.update', saveCreds);

        if (!socket.authState.creds.registered) {
            // ✅ FIX: Must wait for QR event (server ready) BEFORE requestPairingCode
            // Calling too early = WA server rejects = "Couldn't link device"
            await new Promise((resolve) => {
                const timeout = setTimeout(resolve, 10000); // 10s max
                socket.ev.on('connection.update', function handler(update) {
                    if (update.qr) { // QR = server confirmed socket ready for pairing
                        clearTimeout(timeout);
                        socket.ev.off('connection.update', handler);
                        resolve();
                    }
                });
            });

            let code;
            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    if (code && !code.includes('-')) {
                        code = code.match(/.{1,4}/g)?.join('-') || code;
                    }
                    console.log(`✅ Pair code for ${sanitizedNumber}: ${code}`);
                    break;
                } catch (error) {
                    console.warn(`Pair retry ${config.MAX_RETRIES - retries + 1}: ${error.message}`);
                    retries--;
                    await delay(3000);
                }
            }
            if (!res.headersSent) {
                if (code) {
                    res.send({ code });
                } else {
                    res.status(503).send({ error: 'Failed to generate code. Try again.' });
                    return;
                }
            }
        } else {
            if (!res.headersSent) {
                res.send({ status: 'already_registered' });
            }
        }

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr);
                    qrDataMap.set(sanitizedNumber, qrDataUrl);
                    console.log(`📱 QR Generated for ${sanitizedNumber}`);
                } catch (e) {
                    console.error('QR generation error:', e);
                }
            }

            if (connection === 'open') {
                activeSockets.set(sanitizedNumber, socket);
                qrDataMap.delete(sanitizedNumber);

                // Auto join channel
                if (config.AUTO_JOIN_CHANNEL) {
                    try {
                        const metadata = await socket.newsletterMetadata('jid', config.CHANNEL_JID);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(config.CHANNEL_JID);
                            console.log(`✅ Auto followed channel: ${config.CHANNEL_JID}`);
                        }
                    } catch (e) {
                        console.warn('Auto channel join error:', e.message);
                    }
                }

                try {
                    const userJid = jidNormalizedUser(socket.user.id);
                    await socket.sendMessage(userJid, {
                        image: { url: config.BOT_LOGO },
                        caption: `
╭━━━━━━━━━━━━━━━⭓
│ ⚡ *𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑪𝒐𝒏𝒏𝒆𝒄𝒕𝒆𝒅!*
│
│ 📱 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}
│ 🕒 ᴛɪᴍᴇ: ${new Date().toLocaleString()}
│ 🔖 ᴠᴇʀsɪᴏɴ: ${config.version}
│ 📦 ᴄᴍᴅs: .menu
│
╰━━━━━━━━━━━━━━━⭓
${config.BOT_FOOTER}`
                    });
                } catch (e) {
                    console.error('Welcome msg error:', e);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);

                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log(`🔁 Reconnecting ${sanitizedNumber}...`);
                    await delay(5000);
                    const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
                    await NexaPair(sanitizedNumber, mockRes);
                } else {
                    console.log(`🚪 ${sanitizedNumber} logged out`);
                    try { fs.removeSync(sessionPath); } catch (e) {}
                }
            }
        });

    } catch (error) {
        console.error('NexaPair error:', error);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// ==================== QR CONNECT ====================
async function NexaQR(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_qr_${sanitizedNumber}`);
    fs.ensureDirSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    const socket = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        logger,
        browser: ['Nexa Bot', 'Chrome', '120.0.0'],
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
            const qrDataUrl = await QRCode.toDataURL(qr);
            qrDataMap.set(sanitizedNumber, qrDataUrl);
            if (!res.headersSent) {
                res.send({ qr: qrDataUrl });
            }
        }

        if (connection === 'open') {
            activeSockets.set(sanitizedNumber, socket);
            socketCreationTime.set(sanitizedNumber, Date.now());
            qrDataMap.delete(sanitizedNumber);

            setupStatusHandlers(socket);
            setupCommandHandlers(socket, sanitizedNumber);
            setupNewsletterHandlers(socket);

            if (config.AUTO_JOIN_CHANNEL) {
                try {
                    await socket.newsletterFollow(config.CHANNEL_JID);
                } catch (e) {}
            }

            try {
                const userJid = jidNormalizedUser(socket.user.id);
                await socket.sendMessage(userJid, {
                    image: { url: config.BOT_LOGO },
                    caption: `⚡ *Nexa Bot ᴄᴏɴɴᴇᴄᴛᴇᴅ ᴠɪᴀ QR!*\n\n📱 ${sanitizedNumber}\n🕒 ${new Date().toLocaleString()}\n\n${config.BOT_FOOTER}`
                });
            } catch (e) {}
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            if (statusCode !== DisconnectReason.loggedOut) {
                await delay(5000);
                const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
                await NexaQR(sanitizedNumber, mockRes);
            } else {
                try { fs.removeSync(sessionPath); } catch (e) {}
            }
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
            if (!activeSockets.has(num) && num) {
                const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
                if (isQR) {
                    await NexaQR(num, mockRes);
                } else {
                    await NexaPair(num, mockRes);
                }
                await delay(2000);
            }
        }
    } catch (e) {
        console.error('Auto reconnect error:', e.message);
    }
}

autoReconnect();

// ==================== ROUTES ====================
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) {
        return res.status(200).send({ status: 'already_connected', message: `${sanitized} already connected` });
    }
    await NexaPair(sanitized, res);
});

router.get('/qr', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) {
        return res.status(200).send({ status: 'already_connected' });
    }
    await NexaQR(sanitized, res);
});

router.get('/active', (req, res) => {
    res.send({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

router.get('/ping', (req, res) => {
    res.send({ status: 'active', bot: config.BOT_NAME, version: config.version, active: activeSockets.size });
});

module.exports = router;
