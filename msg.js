const {
    proto,
    downloadContentFromMessage,
    getContentType
} = require('@whiskeysockets/baileys');
const fs = require('fs');

const downloadMediaMessage = async (m, type = 'buffer') => {
    try {
        if (!m) return null;
        let msgContent = m.message || null;
        if (!msgContent) return null;

        let msgType = getContentType(msgContent);

        // Unwrap viewOnce (v1 and v2)
        if (msgType === 'viewOnceMessage' || msgType === 'viewOnceMessageV2') {
            const inner = msgContent[msgType]?.message;
            if (inner) { msgContent = inner; msgType = getContentType(inner); }
        }
        // Unwrap ephemeral
        if (msgType === 'ephemeralMessage') {
            const inner = msgContent.ephemeralMessage?.message;
            if (inner) { msgContent = inner; msgType = getContentType(inner); }
        }

        const msg = msgContent[msgType];
        if (!msg) return null;

        const mediaType = msgType.replace('Message', '').toLowerCase();
        const stream = await downloadContentFromMessage(msg, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (e) {
        console.error('downloadMediaMessage error:', e.message);
        return null;
    }
};

function sms(client, m) {
    if (!m.message) return m;
    let M = proto.WebMessageInfo;
    const type = getContentType(m.message);
    if (type === 'ephemeralMessage') {
        m.message = m.message.ephemeralMessage.message;
    }
    m.type = getContentType(m.message) || '';
    m.msg = (
        (m.type === 'viewOnceMessage' && m.message[m.type]?.message?.[getContentType(m.message[m.type].message)]) ||
        (m.type === 'viewOnceMessageV2' && m.message[m.type]?.message?.[getContentType(m.message[m.type].message)]) ||
        m.message[m.type]
    );
    m.body = (m.type === 'conversation') ? m.message.conversation
        : (m.type === 'imageMessage') ? m.message.imageMessage.caption
        : (m.type === 'videoMessage') ? m.message.videoMessage.caption
        : (m.type === 'extendedTextMessage') ? m.message.extendedTextMessage.text
        : (m.type === 'buttonsResponseMessage') ? m.message.buttonsResponseMessage.selectedButtonId
        : (m.type === 'listResponseMessage') ? m.message.listResponseMessage.singleSelectReply.selectedRowId
        : (m.type === 'templateButtonReplyMessage') ? m.message.templateButtonReplyMessage.selectedId
        : (m.type === 'interactiveResponseMessage') ? (() => { try { return m.message?.interactiveResponseMessage?.nativeFlowResponseMessage && JSON.parse(m.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson || '{}')?.id; } catch { return ''; } })()
        : '';

    m.chat = m.key.remoteJid;
    m.fromMe = m.key.fromMe;
    m.sender = m.fromMe ? (client.user.id.split(':')[0] + '@s.whatsapp.net') : (m.key.participant || m.key.remoteJid);

    // Extract contextInfo from any message type that can have quoted messages
    const msgObj = m.message[m.type] || {};
    const contextInfo = msgObj?.contextInfo || m.message.extendedTextMessage?.contextInfo || null;

    if (contextInfo?.quotedMessage) {
        const quoted = contextInfo;
        m.quoted = {
            key: {
                remoteJid: m.chat,
                participant: quoted.participant,
                id: quoted.stanzaId,
                fromMe: quoted.participant === (client.user.id.split(':')[0] + '@s.whatsapp.net')
            },
            message: quoted.quotedMessage,
            sender: quoted.participant
        };
        const qt = getContentType(quoted.quotedMessage);
        m.quoted.type = qt;
        m.quoted.msg = quoted.quotedMessage[qt];
        m.quoted.mimetype = (quoted.quotedMessage[qt])?.mimetype || '';
        m.quoted.statusMessage = m.quoted.key?.remoteJid === 'status@broadcast';
        m.quoted.download = async () => { const s = await downloadContentFromMessage(m.quoted.msg, m.quoted.type.replace('Message', '').toLowerCase()); let b=Buffer.from([]); for await(const c of s) b=Buffer.concat([b,c]); return b; };
    } else {
        m.quoted = null;
    }

    return m;
}

module.exports = { sms, downloadMediaMessage };
