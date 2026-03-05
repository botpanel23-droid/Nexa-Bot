const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  jidDecode,
  proto,
  getAggregateVotesInPollMessage,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  areJidsSameUser,
  getContentType,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
const qrcode = require("qrcode");
const { Boom } = require("@hapi/boom");

// Load settings
let config = JSON.parse(fs.readFileSync("./settings.json"));

// Express server for web panel
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global vars
let qrCodeData = null;
let pairCode = null;
let botConnected = false;
let connectionStatus = "disconnected";
let sock = null;
let spamMap = new Map();
let warnMap = new Map();
let store = makeInMemoryStore({ logger: pino({ level: "silent" }) });

// ============================================================
//  WEB PANEL HTML
// ============================================================
const webPanel = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexa Bot Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --cyan: #00D4FF;
    --cyan2: #00FFD4;
    --dark: #050d1a;
    --card: #0a1628;
    --border: rgba(0,212,255,0.25);
    --glow: 0 0 20px rgba(0,212,255,0.4);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: var(--dark);
    color: #e0f7ff;
    font-family: 'Rajdhani', sans-serif;
    min-height: 100vh;
    background-image:
      radial-gradient(ellipse at 20% 50%, rgba(0,212,255,0.05) 0%, transparent 60%),
      radial-gradient(ellipse at 80% 20%, rgba(0,255,212,0.04) 0%, transparent 60%);
  }

  /* Animated grid background */
  body::before {
    content: '';
    position: fixed; inset: 0;
    background-image:
      linear-gradient(rgba(0,212,255,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,212,255,0.03) 1px, transparent 1px);
    background-size: 50px 50px;
    animation: gridMove 20s linear infinite;
    pointer-events: none;
    z-index: 0;
  }
  @keyframes gridMove {
    0% { background-position: 0 0; }
    100% { background-position: 50px 50px; }
  }

  .container { max-width: 900px; margin: 0 auto; padding: 20px; position: relative; z-index: 1; }

  /* Header */
  .header {
    text-align: center;
    padding: 40px 20px 30px;
    position: relative;
  }
  .logo-wrapper {
    display: inline-block;
    position: relative;
    margin-bottom: 16px;
  }
  .logo-wrapper::before, .logo-wrapper::after {
    content: '';
    position: absolute;
    inset: -8px;
    border-radius: 50%;
    border: 1px solid rgba(0,212,255,0.3);
    animation: pulse 2s ease-in-out infinite;
  }
  .logo-wrapper::after { inset: -16px; animation-delay: 1s; opacity: 0.5; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 0.6; }
    50% { transform: scale(1.05); opacity: 1; }
  }
  .logo {
    width: 90px; height: 90px;
    border-radius: 50%;
    border: 2px solid var(--cyan);
    box-shadow: var(--glow);
    display: block;
  }
  .bot-name {
    font-family: 'Orbitron', monospace;
    font-size: 2.8rem;
    font-weight: 900;
    background: linear-gradient(135deg, var(--cyan), var(--cyan2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: 4px;
    text-shadow: none;
  }
  .bot-sub {
    font-size: 0.9rem;
    color: rgba(0,212,255,0.5);
    letter-spacing: 6px;
    text-transform: uppercase;
    margin-top: 4px;
  }

  /* Status bar */
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin: 20px 0;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 50px;
    padding: 10px 24px;
    width: fit-content;
    margin: 16px auto;
  }
  .status-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: #ff4444;
    box-shadow: 0 0 8px #ff4444;
    transition: all 0.5s;
  }
  .status-dot.connected { background: #00ff88; box-shadow: 0 0 8px #00ff88; animation: blink 1.5s infinite; }
  @keyframes blink { 0%,100%{opacity:1;} 50%{opacity:0.5;} }
  .status-text { font-family: 'Orbitron', monospace; font-size: 0.75rem; letter-spacing: 2px; color: var(--cyan); }

  /* Cards */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px;
    margin-bottom: 20px;
    position: relative;
    overflow: hidden;
    transition: border-color 0.3s, box-shadow 0.3s;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--cyan), transparent);
    opacity: 0.6;
  }
  .card:hover { border-color: rgba(0,212,255,0.5); box-shadow: var(--glow); }
  .card-title {
    font-family: 'Orbitron', monospace;
    font-size: 0.85rem;
    letter-spacing: 3px;
    color: var(--cyan);
    margin-bottom: 20px;
    text-transform: uppercase;
  }

  /* QR Box */
  .qr-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }
  .qr-box {
    width: 220px; height: 220px;
    background: #fff;
    border-radius: 12px;
    border: 3px solid var(--cyan);
    box-shadow: var(--glow);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    position: relative;
  }
  .qr-box img { width: 200px; height: 200px; }
  .qr-box .qr-placeholder {
    color: #666;
    font-size: 0.8rem;
    text-align: center;
    padding: 20px;
    font-family: 'Orbitron', monospace;
    letter-spacing: 2px;
  }
  .scan-line {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, transparent, var(--cyan), transparent);
    animation: scan 2s linear infinite;
  }
  @keyframes scan {
    0% { top: 0; }
    100% { top: 100%; }
  }

  /* Pair code */
  .pair-code-display {
    font-family: 'Orbitron', monospace;
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: 8px;
    color: var(--cyan);
    background: rgba(0,212,255,0.05);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 32px;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s;
    position: relative;
    user-select: all;
  }
  .pair-code-display:hover {
    background: rgba(0,212,255,0.1);
    box-shadow: var(--glow);
  }
  .pair-code-display::after {
    content: 'CLICK TO COPY';
    position: absolute;
    bottom: -22px; left: 50%; transform: translateX(-50%);
    font-size: 0.6rem;
    letter-spacing: 3px;
    color: rgba(0,212,255,0.4);
  }
  .copied-toast {
    position: fixed;
    top: 20px; right: 20px;
    background: #00ff88;
    color: #000;
    padding: 10px 20px;
    border-radius: 8px;
    font-family: 'Orbitron', monospace;
    font-size: 0.75rem;
    letter-spacing: 2px;
    opacity: 0;
    transform: translateY(-10px);
    transition: all 0.3s;
    z-index: 999;
  }
  .copied-toast.show { opacity: 1; transform: translateY(0); }

  /* Input + Button */
  .input-group { display: flex; gap: 10px; margin-top: 8px; }
  .input-field {
    flex: 1;
    background: rgba(0,212,255,0.05);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    color: #e0f7ff;
    font-family: 'Rajdhani', sans-serif;
    font-size: 1rem;
    outline: none;
    transition: border-color 0.3s;
  }
  .input-field:focus { border-color: var(--cyan); box-shadow: 0 0 0 2px rgba(0,212,255,0.1); }
  .btn {
    background: linear-gradient(135deg, var(--cyan), var(--cyan2));
    color: #000;
    border: none;
    border-radius: 10px;
    padding: 12px 24px;
    font-family: 'Orbitron', monospace;
    font-weight: 700;
    font-size: 0.75rem;
    letter-spacing: 2px;
    cursor: pointer;
    transition: all 0.3s;
    text-transform: uppercase;
  }
  .btn:hover { transform: translateY(-2px); box-shadow: var(--glow); }
  .btn:active { transform: translateY(0); }
  .btn-outline {
    background: transparent;
    color: var(--cyan);
    border: 1px solid var(--cyan);
  }
  .btn-outline:hover { background: rgba(0,212,255,0.1); }

  /* Tabs */
  .tabs { display: flex; gap: 2px; margin-bottom: 20px; background: rgba(0,0,0,0.3); border-radius: 12px; padding: 4px; }
  .tab {
    flex: 1;
    padding: 10px;
    text-align: center;
    font-family: 'Orbitron', monospace;
    font-size: 0.7rem;
    letter-spacing: 2px;
    color: rgba(0,212,255,0.5);
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.3s;
  }
  .tab.active { background: var(--card); color: var(--cyan); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Stats grid */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 8px; }
  .stat-item {
    background: rgba(0,212,255,0.04);
    border: 1px solid rgba(0,212,255,0.1);
    border-radius: 10px;
    padding: 14px;
    text-align: center;
  }
  .stat-val { font-family: 'Orbitron', monospace; font-size: 1.5rem; color: var(--cyan); }
  .stat-label { font-size: 0.7rem; color: rgba(255,255,255,0.4); letter-spacing: 2px; margin-top: 4px; }

  /* Info text */
  .info-text { font-size: 0.85rem; color: rgba(255,255,255,0.5); line-height: 1.7; }
  .info-text span { color: var(--cyan); font-weight: 600; }

  /* Footer */
  .footer {
    text-align: center;
    padding: 30px 0 20px;
    font-family: 'Orbitron', monospace;
    font-size: 0.65rem;
    letter-spacing: 3px;
    color: rgba(0,212,255,0.25);
  }

  /* Loading spinner */
  .spinner {
    width: 40px; height: 40px;
    border: 3px solid rgba(0,212,255,0.1);
    border-top: 3px solid var(--cyan);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 20px auto;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Connected overlay */
  .connected-state {
    display: none;
    text-align: center;
    padding: 20px;
  }
  .connected-state.show { display: block; }
  .checkmark { font-size: 4rem; animation: pop 0.5s ease; }
  @keyframes pop { 0%{transform:scale(0);} 70%{transform:scale(1.2);} 100%{transform:scale(1);} }

  @media(max-width:600px) {
    .bot-name { font-size: 2rem; }
    .pair-code-display { font-size: 1.5rem; letter-spacing: 4px; }
    .input-group { flex-direction: column; }
  }
</style>
</head>
<body>
<div id="toast" class="copied-toast">âœ“ COPIED!</div>

<div class="container">
  <div class="header">
    <div class="logo-wrapper">
      <img src="https://files.catbox.moe/1zj41k.png" class="logo" alt="Nexa Bot Logo" onerror="this.style.display='none'">
    </div>
    <div class="bot-name">NEXA BOT</div>
    <div class="bot-sub">WhatsApp Automation System</div>
    <div class="status-bar">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-text" id="statusText">DISCONNECTED</div>
    </div>
  </div>

  <!-- Stats -->
  <div class="card">
    <div class="card-title">âš¡ System Status</div>
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-val" id="uptimeStat">0m</div>
        <div class="stat-label">UPTIME</div>
      </div>
      <div class="stat-item">
        <div class="stat-val" id="msgStat">0</div>
        <div class="stat-label">MESSAGES</div>
      </div>
      <div class="stat-item">
        <div class="stat-val" id="cmdStat">0</div>
        <div class="stat-label">COMMANDS</div>
      </div>
      <div class="stat-item">
        <div class="stat-val" id="connStat">â€”</div>
        <div class="stat-label">STATUS</div>
      </div>
    </div>
  </div>

  <!-- Connect Card -->
  <div class="card">
    <div class="card-title">ðŸ”— Connect WhatsApp</div>

    <div class="tabs">
      <div class="tab active" onclick="switchTab('qr')">QR CODE</div>
      <div class="tab" onclick="switchTab('pair')">PAIR CODE</div>
    </div>

    <!-- QR Tab -->
    <div id="tab-qr" class="tab-content active">
      <div class="qr-container">
        <div class="qr-box" id="qrBox">
          <div class="scan-line" id="scanLine" style="display:none"></div>
          <div class="qr-placeholder" id="qrPlaceholder">
            <div class="spinner"></div>
            <div style="margin-top:8px;">LOADING QR...</div>
          </div>
          <img id="qrImg" style="display:none" alt="QR Code">
        </div>
        <p class="info-text" style="text-align:center;">
          Open WhatsApp â†’ <span>Linked Devices</span> â†’ <span>Link a Device</span> â†’ Scan QR
        </p>
        <button class="btn btn-outline" onclick="loadQR()">â†» REFRESH QR</button>
      </div>
    </div>

    <!-- Pair Tab -->
    <div id="tab-pair" class="tab-content">
      <p class="info-text" style="margin-bottom:16px;">
        Enter your WhatsApp number with country code to get a <span>Pair Code</span>
      </p>
      <div class="input-group">
        <input type="text" id="phoneInput" class="input-field" placeholder="e.g. 94771234567" maxlength="15">
        <button class="btn" onclick="getPairCode()">GET CODE</button>
      </div>
      <div id="pairCodeArea" style="margin-top:24px; display:none;">
        <div class="pair-code-display" id="pairCodeDisplay" onclick="copyPairCode()">
          --------
        </div>
        <p class="info-text" style="text-align:center; margin-top:32px;">
          Open WhatsApp â†’ <span>Linked Devices</span> â†’ <span>Link with phone number</span> â†’ Enter code
        </p>
      </div>
      <div id="pairLoading" style="display:none; text-align:center;">
        <div class="spinner"></div>
        <p class="info-text" style="text-align:center;">Generating pair code...</p>
      </div>
    </div>
  </div>

  <!-- Connected state -->
  <div id="connectedCard" class="card" style="display:none; text-align:center;">
    <div class="checkmark">âœ…</div>
    <div style="font-family:'Orbitron',monospace; font-size:1.2rem; color:#00ff88; margin:12px 0; letter-spacing:3px;">BOT CONNECTED!</div>
    <p class="info-text" style="text-align:center;">Nexa Bot is now active and ready to receive commands.</p>
  </div>

  <div class="footer">NEXA BOT v2.0 â€¢ POWERED BY BAILEYS â€¢ RENDER READY</div>
</div>

<script>
let startTime = Date.now();
let msgCount = 0, cmdCount = 0;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[onclick="switchTab(\\''+tab+'\\')"]').classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
}

async function loadQR() {
  document.getElementById('qrPlaceholder').innerHTML = '<div class="spinner"></div><div style="margin-top:8px;">LOADING QR...</div>';
  document.getElementById('qrPlaceholder').style.display = 'flex';
  document.getElementById('qrPlaceholder').style.flexDirection = 'column';
  document.getElementById('qrPlaceholder').style.alignItems = 'center';
  document.getElementById('qrImg').style.display = 'none';

  try {
    const res = await fetch('/api/qr');
    const data = await res.json();
    if (data.qr) {
      document.getElementById('qrImg').src = data.qr;
      document.getElementById('qrImg').style.display = 'block';
      document.getElementById('qrPlaceholder').style.display = 'none';
      document.getElementById('scanLine').style.display = 'block';
    } else if (data.connected) {
      showConnected();
    } else {
      document.getElementById('qrPlaceholder').innerHTML = '<span style="font-size:2rem">â³</span><div style="margin-top:8px;font-size:0.7rem;letter-spacing:2px;">WAITING FOR QR...</div>';
    }
  } catch(e) {
    document.getElementById('qrPlaceholder').innerHTML = '<span style="font-size:2rem">âš ï¸</span><div style="margin-top:8px;font-size:0.7rem;letter-spacing:2px;">ERROR LOADING</div>';
  }
}

async function getPairCode() {
  const phone = document.getElementById('phoneInput').value.trim().replace(/[^0-9]/g,'');
  if (!phone || phone.length < 7) {
    alert('Please enter a valid phone number with country code!
Example: 94771234567');
    return;
  }
  document.getElementById('pairCodeArea').style.display = 'none';
  document.getElementById('pairLoading').style.display = 'block';
  document.getElementById('pairLoading').innerHTML = '<div class="spinner"></div><p class="info-text" style="text-align:center;margin-top:8px;">â³ Preparing bot socket... (up to 15s)</p>';

  try {
    const res = await fetch('/api/pair?phone=' + phone, {
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json();
    document.getElementById('pairLoading').style.display = 'none';
    if (data.code) {
      document.getElementById('pairCodeDisplay').textContent = data.code;
      document.getElementById('pairCodeArea').style.display = 'block';
    } else {
      alert('âŒ ' + (data.error || 'Failed to get pair code. Please try again.'));
    }
  } catch(e) {
    document.getElementById('pairLoading').style.display = 'none';
    if (e.name === 'TimeoutError') {
      alert('â±ï¸ Timeout. Please refresh page and try again.');
    } else {
      alert('Error: ' + e.message);
    }
  }
}

function copyPairCode() {
  const code = document.getElementById('pairCodeDisplay').textContent;
  if (code && code !== '--------') {
    navigator.clipboard.writeText(code).then(() => {
      const t = document.getElementById('toast');
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2000);
    });
  }
}

function showConnected() {
  document.querySelector('.card:nth-child(3)').style.display = 'none';
  document.getElementById('connectedCard').style.display = 'block';
  document.getElementById('statusDot').classList.add('connected');
  document.getElementById('statusText').textContent = 'CONNECTED';
  document.getElementById('connStat').textContent = 'ON';
}

async function updateStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.connected) {
      showConnected();
    }
    msgCount = data.messages || 0;
    cmdCount = data.commands || 0;
    document.getElementById('msgStat').textContent = msgCount;
    document.getElementById('cmdStat').textContent = cmdCount;
  } catch(e) {}

  const elapsed = Math.floor((Date.now() - startTime) / 60000);
  if (elapsed < 60) {
    document.getElementById('uptimeStat').textContent = elapsed + 'm';
  } else {
    document.getElementById('uptimeStat').textContent = Math.floor(elapsed/60) + 'h';
  }
}

// Init
loadQR();
setInterval(loadQR, 30000);
setInterval(updateStatus, 5000);
updateStatus();
</script>
</body>
</html>`;

// ============================================================
//  STATS
// ============================================================
let stats = { messages: 0, commands: 0 };

// ============================================================
//  WEB ROUTES
// ============================================================
app.get("/", (req, res) => res.send(webPanel));

app.get("/api/status", (req, res) => {
  res.json({ connected: botConnected, status: connectionStatus, ...stats });
});

app.get("/api/qr", (req, res) => {
  if (botConnected) return res.json({ connected: true });
  if (qrCodeData) return res.json({ qr: qrCodeData });
  res.json({ waiting: true });
});


// ============================================================
//  PAIR CODE API - FIXED
//  Root cause: requestPairingCode() MUST be called before
//  WhatsApp sends QR. We use a dedicated socket init for pair mode.
// ============================================================
app.get("/api/pair", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.json({ error: "Phone number required" });
  if (botConnected) return res.json({ error: "Bot already connected!" });

  try {
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    if (cleanPhone.length < 7) return res.json({ error: "Invalid phone number" });

    // Step 1: Destroy current socket cleanly
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        await sock.logout().catch(() => {});
      } catch(e) {}
      sock = null;
    }

    // Step 2: Delete old auth so we get a fresh registration session
    try { require("fs-extra").removeSync("./auth_info"); } catch(e) {}
    qrCodeData = null;
    pairCode = null;
    connectionStatus = "pairing";

    // Step 3: Start a fresh socket in "pair code mode"
    // The trick: requestPairingCode must be called IMMEDIATELY after
    // socket.connect() - before WhatsApp has a chance to send QR data.
    await startPairMode(cleanPhone);

    // Step 4: Wait up to 30s for pairCode to be set
    let waited = 0;
    while (waited < 30000 && !pairCode) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    if (!pairCode) {
      return res.json({ error: "Could not generate pair code. Please refresh and try again." });
    }

    res.json({ code: pairCode });
  } catch (e) {
    console.error("Pair code error:", e.message);
    res.json({ error: e.message || "Failed to get pair code. Try again." });
  }
});


// ============================================================
//  HELPERS
// ============================================================
function getConfig() {
  try { return JSON.parse(fs.readFileSync("./settings.json")); }
  catch(e) { return config; }
}

function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  fs.writeFileSync("./settings.json", JSON.stringify(config, null, 2));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

function isOwner(jid) {
  const cfg = getConfig();
  const num = jid.split("@")[0];
  return cfg.ownerNumber.includes(num);
}

async function react(sock, msg, emoji) {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: emoji, key: msg.key }
    });
  } catch(e) {}
}

async function reply(sock, msg, text) {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function sendWithMention(sock, jid, text, mentions = []) {
  await sock.sendMessage(jid, { text, mentions });
}

// ============================================================
//  COMMAND HANDLERS
// ============================================================
async function handleCommand(sock, msg, prefix) {
  const cfg = getConfig();
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith("@g.us");
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderNum = sender.split("@")[0];
  const body = msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || "";

  if (!body.startsWith(prefix)) return false;

  const args = body.slice(prefix.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  const text = args.join(" ");
  const owner = isOwner(sender);

  stats.commands++;

  // Typing indicator
  if (cfg.autoTyping) {
    await sock.sendPresenceUpdate("composing", jid);
    await sleep(800);
    await sock.sendPresenceUpdate("paused", jid);
  }

  switch (cmd) {

    // â”€â”€â”€ INFO COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case "menu":
    case "help": {
      const menuText = `â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘  ðŸ¤–  *NEXA BOT MENU*  ðŸ¤–   â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

ðŸ“‹ *INFO COMMANDS*
â”œ ${prefix}menu â€” Show this menu
â”œ ${prefix}ping â€” Check bot speed
â”œ ${prefix}info â€” Bot information
â”œ ${prefix}uptime â€” Bot uptime
â”” ${prefix}owner â€” Owner info

âš™ï¸ *SETTINGS* _(Owner only)_
â”œ ${prefix}settings â€” View all settings
â”œ ${prefix}setprefix <x> â€” Change prefix
â”œ ${prefix}setmode <pub/priv> â€” Set bot mode
â”œ ${prefix}autoread <on/off> â€” Auto read msgs
â”œ ${prefix}autotyping <on/off> â€” Typing indicator
â”œ ${prefix}antilink <on/off> â€” Anti link in groups
â”œ ${prefix}antispam <on/off> â€” Anti spam
â”œ ${prefix}autorecord <on/off> â€” Auto recording
â”” ${prefix}pmnotify <on/off> â€” PM notifications

ðŸ‘¥ *GROUP COMMANDS* _(Admin)_
â”œ ${prefix}kick @user â€” Kick member
â”œ ${prefix}add 94xxx â€” Add member
â”œ ${prefix}promote @user â€” Make admin
â”œ ${prefix}demote @user â€” Remove admin
â”œ ${prefix}mute â€” Mute group
â”œ ${prefix}unmute â€” Unmute group
â”œ ${prefix}tagall â€” Tag all members
â”œ ${prefix}hidetag <msg> â€” Hidden tag all
â”œ ${prefix}groupinfo â€” Group info
â”” ${prefix}link â€” Get group invite link

ðŸ›¡ï¸ *MOD COMMANDS* _(Owner)_
â”œ ${prefix}ban @user â€” Ban user
â”œ ${prefix}unban @user â€” Unban user
â”œ ${prefix}warn @user â€” Warn user
â”œ ${prefix}resetwarn @user â€” Reset warnings
â”” ${prefix}warnlist â€” View warnings

ðŸŽ­ *FUN COMMANDS*
â”œ ${prefix}sticker â€” Image to sticker
â”œ ${prefix}toimg â€” Sticker to image
â”œ ${prefix}tts <text> â€” Text to speech
â”œ ${prefix}translate <text> â€” Translate text
â”œ ${prefix}wiki <query> â€” Wikipedia search
â”œ ${prefix}weather <city> â€” Weather info
â”œ ${prefix}joke â€” Random joke
â”œ ${prefix}quote â€” Random quote
â”” ${prefix}fact â€” Random fact

ðŸ“Š *STATS*
â”œ ${prefix}stats â€” Bot stats
â”” ${prefix}broadcast <msg> â€” Broadcast _(Owner)_

_Prefix: *${cfg.botPrefix}* | ${cfg.botName}_`;

      await reply(sock, msg, menuText);
      break;
    }

    case "ping": {
      const t1 = Date.now();
      await reply(sock, msg, "ðŸ“ Pinging...");
      const latency = Date.now() - t1;
      await reply(sock, msg, `ðŸ“ *Pong!*\nâš¡ Speed: *${latency}ms*\nðŸŸ¢ Bot is Online!`);
      break;
    }

    case "info": {
      const infoText = `â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘    ðŸ¤– *NEXA BOT INFO*    â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

ðŸ”· *Name:* ${cfg.botName}
ðŸ”· *Version:* 2.0.0
ðŸ”· *Prefix:* ${cfg.botPrefix}
ðŸ”· *Platform:* WhatsApp
ðŸ”· *Library:* Baileys v6
ðŸ”· *Runtime:* Node.js
ðŸ”· *Mode:* ${cfg.publicMode ? "Public" : "Private"}
ðŸ”· *Uptime:* ${formatUptime(process.uptime() * 1000)}
ðŸ”· *Messages:* ${stats.messages}
ðŸ”· *Commands:* ${stats.commands}

ðŸ’¡ Use *${prefix}menu* for all commands`;
      await reply(sock, msg, infoText);
      break;
    }

    case "uptime": {
      await reply(sock, msg, `â±ï¸ *Bot Uptime*\n\nðŸŸ¢ Online for: *${formatUptime(process.uptime() * 1000)}*`);
      break;
    }

    case "owner": {
      const ownerText = `ðŸ‘‘ *Bot Owner*\n\nNumber: wa.me/${cfg.ownerNumber[0]}\n\nContact the owner for support.`;
      await reply(sock, msg, ownerText);
      break;
    }

    case "stats": {
      await reply(sock, msg, `ðŸ“Š *Nexa Bot Stats*\n\nðŸ“¨ Messages: ${stats.messages}\nâš¡ Commands: ${stats.commands}\nâ±ï¸ Uptime: ${formatUptime(process.uptime() * 1000)}\nðŸ’¾ Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      break;
    }

    // â”€â”€â”€ SETTINGS COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case "settings": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const c = getConfig();
      const settingsText = `âš™ï¸ *NEXA BOT SETTINGS*

ðŸ¤– *Bot*
â”œ Name: ${c.botName}
â”œ Prefix: ${c.botPrefix}
â”œ Mode: ${c.publicMode ? "Public ðŸŒ" : "Private ðŸ”’"}
â”” Language: ${c.language}

ðŸ”„ *Auto Features*
â”œ Auto Read: ${c.autoRead ? "âœ… ON" : "âŒ OFF"}
â”œ Auto Typing: ${c.autoTyping ? "âœ… ON" : "âŒ OFF"}
â”œ Auto Recording: ${c.autoRecording ? "âœ… ON" : "âŒ OFF"}
â”” Auto Status: ${c.autoStatus ? "âœ… ON" : "âŒ OFF"}

ðŸ‘¥ *Group Features*
â”œ Welcome Msg: ${c.welcomeMsg ? "âœ… ON" : "âŒ OFF"}
â”œ Goodbye Msg: ${c.goodbyeMsg ? "âœ… ON" : "âŒ OFF"}
â”œ Anti Link: ${c.antiLink ? "âœ… ON" : "âŒ OFF"}
â”” Anti Spam: ${c.antiSpam ? "âœ… ON" : "âŒ OFF"}

ðŸ“± *Modes*
â”œ Group Mode: ${c.groupMode ? "âœ… ON" : "âŒ OFF"}
â”œ Private Mode: ${c.privateMode ? "âœ… ON" : "âŒ OFF"}
â”” PM Notify: ${c.pmNotify ? "âœ… ON" : "âŒ OFF"}

_Use ${c.botPrefix}setprefix, ${c.botPrefix}setmode etc. to change_`;
      await reply(sock, msg, settingsText);
      break;
    }

    case "setprefix": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      if (!text) { await reply(sock, msg, "Usage: .setprefix <new_prefix>"); break; }
      saveConfig({ botPrefix: text[0] });
      await react(sock, msg, "âœ…");
      await reply(sock, msg, `âœ… Prefix changed to: *${text[0]}*`);
      break;
    }

    case "setmode": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const mode = text.toLowerCase();
      if (mode === "public") {
        saveConfig({ publicMode: true });
        await reply(sock, msg, "âœ… Bot mode set to *Public* ðŸŒ\nAnyone can use the bot now.");
      } else if (mode === "private") {
        saveConfig({ publicMode: false });
        await reply(sock, msg, "âœ… Bot mode set to *Private* ðŸ”’\nOnly owner can use the bot now.");
      } else {
        await reply(sock, msg, "Usage: .setmode <public/private>");
      }
      break;
    }

    case "autoread": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ autoRead: val });
      await reply(sock, msg, `âœ… Auto Read: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "autotyping": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ autoTyping: val });
      await reply(sock, msg, `âœ… Auto Typing: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "antilink": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ antiLink: val });
      await reply(sock, msg, `âœ… Anti Link: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "antispam": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ antiSpam: val });
      await reply(sock, msg, `âœ… Anti Spam: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "autorecord": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ autoRecording: val });
      await reply(sock, msg, `âœ… Auto Recording: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "welcome": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ welcomeMsg: val });
      await reply(sock, msg, `âœ… Welcome Message: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "pmnotify": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ pmNotify: val });
      await reply(sock, msg, `âœ… PM Notify: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "groupmode": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ groupMode: val });
      await reply(sock, msg, `âœ… Group Mode: *${val ? "ON" : "OFF"}*`);
      break;
    }

    case "privatemode": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const val = text.toLowerCase() === "on";
      saveConfig({ privateMode: val });
      await reply(sock, msg, `âœ… Private Mode: *${val ? "ON" : "OFF"}*`);
      break;
    }

    // â”€â”€â”€ GROUP COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case "kick": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || mentioned.length === 0) { await reply(sock, msg, "Usage: .kick @user"); break; }
      try {
        await sock.groupParticipantsUpdate(jid, mentioned, "remove");
        await react(sock, msg, "âœ…");
        await reply(sock, msg, `âœ… Kicked ${mentioned.length} user(s) successfully!`);
      } catch(e) { await reply(sock, msg, "âŒ Failed to kick. Are you an admin?"); }
      break;
    }

    case "add": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      if (!text) { await reply(sock, msg, "Usage: .add 94XXXXXXXXX"); break; }
      const addNum = text.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
      try {
        await sock.groupParticipantsUpdate(jid, [addNum], "add");
        await react(sock, msg, "âœ…");
        await reply(sock, msg, `âœ… Added *${text}* to the group!`);
      } catch(e) { await reply(sock, msg, "âŒ Failed to add. Check the number."); }
      break;
    }

    case "promote": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || mentioned.length === 0) { await reply(sock, msg, "Usage: .promote @user"); break; }
      try {
        await sock.groupParticipantsUpdate(jid, mentioned, "promote");
        await react(sock, msg, "âœ…");
        await reply(sock, msg, `â­ Promoted to admin successfully!`);
      } catch(e) { await reply(sock, msg, "âŒ Failed to promote."); }
      break;
    }

    case "demote": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || mentioned.length === 0) { await reply(sock, msg, "Usage: .demote @user"); break; }
      try {
        await sock.groupParticipantsUpdate(jid, mentioned, "demote");
        await react(sock, msg, "âœ…");
        await reply(sock, msg, `âœ… Demoted from admin successfully!`);
      } catch(e) { await reply(sock, msg, "âŒ Failed to demote."); }
      break;
    }

    case "mute": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        await sock.groupSettingUpdate(jid, "announcement");
        await react(sock, msg, "ðŸ”‡");
        await reply(sock, msg, "ðŸ”‡ Group muted! Only admins can send messages.");
      } catch(e) { await reply(sock, msg, "âŒ Failed to mute. Are you an admin?"); }
      break;
    }

    case "unmute": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        await sock.groupSettingUpdate(jid, "not_announcement");
        await react(sock, msg, "ðŸ”Š");
        await reply(sock, msg, "ðŸ”Š Group unmuted! Everyone can send messages now.");
      } catch(e) { await reply(sock, msg, "âŒ Failed to unmute."); }
      break;
    }

    case "tagall": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        const metadata = await sock.groupMetadata(jid);
        const members = metadata.participants;
        const mentions = members.map(m => m.id);
        const tagText = text || "ðŸ“¢ *Everyone tagged!*";
        let mentionStr = tagText + "\n\n";
        members.forEach(m => { mentionStr += `@${m.id.split("@")[0]} `; });
        await sock.sendMessage(jid, { text: mentionStr, mentions }, { quoted: msg });
      } catch(e) { await reply(sock, msg, "âŒ Failed to tag all."); }
      break;
    }

    case "hidetag": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        const metadata = await sock.groupMetadata(jid);
        const mentions = metadata.participants.map(m => m.id);
        await sock.sendMessage(jid, { text: text || "ðŸ“¢", mentions }, { quoted: msg });
      } catch(e) { await reply(sock, msg, "âŒ Failed."); }
      break;
    }

    case "groupinfo": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        const meta = await sock.groupMetadata(jid);
        const adminList = meta.participants.filter(p => p.admin).map(p => `@${p.id.split("@")[0]}`).join(", ") || "None";
        const groupInfoText = `ðŸ‘¥ *Group Info*

ðŸ“Œ *Name:* ${meta.subject}
ðŸ†” *ID:* ${jid}
ðŸ‘¤ *Members:* ${meta.participants.length}
ðŸ‘‘ *Admins:* ${meta.participants.filter(p => p.admin).length}
ðŸ“… *Created:* ${new Date(meta.creation * 1000).toLocaleDateString()}
ðŸ“ *Description:*\n${meta.desc || "No description"}`;
        await reply(sock, msg, groupInfoText);
      } catch(e) { await reply(sock, msg, "âŒ Failed to get group info."); }
      break;
    }

    case "link": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        const inviteCode = await sock.groupInviteCode(jid);
        await reply(sock, msg, `ðŸ”— *Group Invite Link*\n\nhttps://chat.whatsapp.com/${inviteCode}`);
      } catch(e) { await reply(sock, msg, "âŒ Failed to get link. Bot must be admin."); }
      break;
    }

    case "revoke": {
      if (!isGroup) { await reply(sock, msg, "âš ï¸ Group only command!"); break; }
      try {
        await sock.groupRevokeInvite(jid);
        await react(sock, msg, "âœ…");
        await reply(sock, msg, "âœ… Group invite link revoked!");
      } catch(e) { await reply(sock, msg, "âŒ Failed to revoke link."); }
      break;
    }

    // â”€â”€â”€ MOD COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case "warn": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || mentioned.length === 0) { await reply(sock, msg, "Usage: .warn @user <reason>"); break; }
      const target = mentioned[0];
      const warns = warnMap.get(target) || 0;
      const newWarns = warns + 1;
      warnMap.set(target, newWarns);
      const cfg2 = getConfig();
      if (newWarns >= cfg2.maxWarns && isGroup) {
        try {
          await sock.groupParticipantsUpdate(jid, [target], "remove");
          await reply(sock, msg, `ðŸš« @${target.split("@")[0]} has been *kicked* for reaching max warnings (${cfg2.maxWarns})!`, [target]);
          warnMap.delete(target);
        } catch(e) {}
      } else {
        await reply(sock, msg, `âš ï¸ *Warning ${newWarns}/${cfg2.maxWarns}*\n@${target.split("@")[0]} has been warned!\nReason: ${text || "No reason"}`, [target]);
      }
      break;
    }

    case "resetwarn": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      if (!mentioned || mentioned.length === 0) { await reply(sock, msg, "Usage: .resetwarn @user"); break; }
      warnMap.delete(mentioned[0]);
      await react(sock, msg, "âœ…");
      await reply(sock, msg, `âœ… Warnings reset for @${mentioned[0].split("@")[0]}!`);
      break;
    }

    case "warnlist": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      if (warnMap.size === 0) { await reply(sock, msg, "ðŸ“‹ No warnings recorded."); break; }
      let list = "ðŸ“‹ *Warning List*\n\n";
      warnMap.forEach((count, user) => {
        list += `ðŸ‘¤ @${user.split("@")[0]}: ${count} warn(s)\n`;
      });
      await reply(sock, msg, list);
      break;
    }

    // â”€â”€â”€ FUN COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case "sticker":
    case "s": {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg = msg.message?.imageMessage || quotedMsg?.imageMessage;
      if (!imgMsg) { await reply(sock, msg, "ðŸ“¸ Reply to an image with .sticker to convert!"); break; }
      try {
        await react(sock, msg, "â³");
        const buffer = await downloadContentFromMessage(imgMsg, "image");
        let data = Buffer.from([]);
        for await (const chunk of buffer) data = Buffer.concat([data, chunk]);
        await sock.sendMessage(jid, { sticker: data }, { quoted: msg });
        await react(sock, msg, "âœ…");
      } catch(e) { await reply(sock, msg, "âŒ Failed to create sticker."); }
      break;
    }

    case "joke": {
      const jokes = [
        "Why don't scientists trust atoms? Because they make up everything! ðŸ˜‚",
        "I told my wife she was drawing her eyebrows too high. She looked surprised. ðŸ˜®",
        "Why do cows wear bells? Because their horns don't work! ðŸ„",
        "What do you call a fish without eyes? A fsh! ðŸŸ",
        "Why did the scarecrow win an award? Because he was outstanding in his field! ðŸŒ¾",
        "I used to hate facial hair, but then it grew on me! ðŸ§”",
        "Why can't you hear a pterodactyl go to the bathroom? Because the P is silent! ðŸ¦•",
        "What do you call cheese that isn't yours? Nacho cheese! ðŸ§€"
      ];
      await reply(sock, msg, `ðŸ˜‚ *Random Joke*\n\n${jokes[Math.floor(Math.random() * jokes.length)]}`);
      break;
    }

    case "quote": {
      const quotes = [
        '"The only way to do great work is to love what you do." â€” Steve Jobs',
        '"Innovation distinguishes between a leader and a follower." â€” Steve Jobs',
        '"Life is what happens when you\'re busy making other plans." â€” John Lennon',
        '"The future belongs to those who believe in the beauty of their dreams." â€” Eleanor Roosevelt',
        '"It is during our darkest moments that we must focus to see the light." â€” Aristotle',
        '"The best time to plant a tree was 20 years ago. The second best time is now." â€” Chinese Proverb',
        '"Spread love everywhere you go. Let no one ever come to you without leaving happier." â€” Mother Teresa',
        '"In the middle of difficulty lies opportunity." â€” Albert Einstein'
      ];
      await reply(sock, msg, `ðŸ’¬ *Quote of the Moment*\n\n${quotes[Math.floor(Math.random() * quotes.length)]}`);
      break;
    }

    case "fact": {
      const facts = [
        "ðŸŒ Honey never spoils. Archaeologists found 3000-year-old honey in Egyptian tombs!",
        "ðŸ™ Octopuses have three hearts and blue blood!",
        "ðŸŒ™ The Moon is slowly drifting away from Earth at 3.8 cm per year.",
        "ðŸ§  Your brain uses 20% of your body's total energy!",
        "ðŸ¦ˆ Sharks are older than trees. They've been around for 400 million years.",
        "ðŸŒŠ More than 80% of the ocean has never been explored.",
        "ðŸŒ Bananas are berries, but strawberries are not!",
        "âš¡ A bolt of lightning is 5 times hotter than the surface of the Sun."
      ];
      await reply(sock, msg, `ðŸŽ“ *Random Fact*\n\n${facts[Math.floor(Math.random() * facts.length)]}`);
      break;
    }

    case "weather": {
      if (!text) { await reply(sock, msg, "Usage: .weather <city>"); break; }
      try {
        const axios = require("axios");
        const res = await axios.get(`https://wttr.in/${encodeURIComponent(text)}?format=j1`, { timeout: 8000 });
        const w = res.data.current_condition[0];
        const area = res.data.nearest_area[0];
        const weatherText = `ðŸŒ¤ï¸ *Weather: ${area.areaName[0].value}, ${area.country[0].value}*

ðŸŒ¡ï¸ Temperature: ${w.temp_C}Â°C (${w.temp_F}Â°F)
ðŸ’§ Humidity: ${w.humidity}%
ðŸŒ¬ï¸ Wind: ${w.windspeedKmph} km/h ${w.winddir16Point}
ðŸ‘ï¸ Visibility: ${w.visibility} km
ðŸŒ¥ï¸ Condition: ${w.weatherDesc[0].value}
ðŸ’¨ Feels Like: ${w.FeelsLikeC}Â°C`;
        await reply(sock, msg, weatherText);
      } catch(e) { await reply(sock, msg, "âŒ Could not get weather. Try again."); }
      break;
    }

    case "wiki": {
      if (!text) { await reply(sock, msg, "Usage: .wiki <topic>"); break; }
      try {
        const axios = require("axios");
        const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`, { timeout: 8000 });
        const d = res.data;
        await reply(sock, msg, `ðŸ“– *${d.title}*\n\n${d.extract}\n\nðŸ”— ${d.content_urls?.desktop?.page || ""}`);
      } catch(e) { await reply(sock, msg, `âŒ Could not find info about "${text}".`); }
      break;
    }

    case "translate": {
      if (!text) { await reply(sock, msg, "Usage: .translate <text>"); break; }
      try {
        const axios = require("axios");
        const res = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|en`, { timeout: 8000 });
        const translated = res.data.responseData.translatedText;
        await reply(sock, msg, `ðŸŒ *Translation*\n\n*Original:* ${text}\n*English:* ${translated}`);
      } catch(e) { await reply(sock, msg, "âŒ Translation failed."); }
      break;
    }

    case "tts": {
      if (!text) { await reply(sock, msg, "Usage: .tts <text>"); break; }
      try {
        const axios = require("axios");
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=si&client=tw-ob`;
        const res = await axios.get(url, { responseType: "arraybuffer", timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
        await sock.sendMessage(jid, { audio: Buffer.from(res.data), mimetype: "audio/mp4", ptt: true }, { quoted: msg });
      } catch(e) { await reply(sock, msg, "âŒ TTS failed. Try with .tts <text>"); }
      break;
    }

    // â”€â”€â”€ OWNER COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case "broadcast":
    case "bc": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      if (!text) { await reply(sock, msg, "Usage: .broadcast <message>"); break; }
      const chats = store.chats.all ? store.chats.all() : [];
      let sent = 0;
      await reply(sock, msg, `ðŸ“¢ Broadcasting to ${chats.length} chats...`);
      for (const chat of chats) {
        try {
          await sock.sendMessage(chat.id, { text: `ðŸ“¢ *Broadcast*\n\n${text}` });
          sent++;
          await sleep(500);
        } catch(e) {}
      }
      await reply(sock, msg, `âœ… Broadcast sent to ${sent} chats!`);
      break;
    }

    case "restart": {
      if (!owner) { await react(sock, msg, "âŒ"); break; }
      await reply(sock, msg, "â™»ï¸ Restarting Nexa Bot...");
      await sleep(1000);
      process.exit(0); // Render will auto-restart
      break;
    }

    case "getid": {
      await reply(sock, msg, `ðŸ†” *Chat ID:* \`${jid}\`\nðŸ‘¤ *Your ID:* \`${sender}\``);
      break;
    }

    default:
      return false;
  }
  return true;
}

// ============================================================
//  ANTI SPAM
// ============================================================
function checkSpam(sender) {
  const cfg = getConfig();
  if (!cfg.antiSpam) return false;
  const now = Date.now();
  const data = spamMap.get(sender) || { count: 0, time: now };
  if (now - data.time > cfg.spamTime * 1000) {
    spamMap.set(sender, { count: 1, time: now });
    return false;
  }
  data.count++;
  spamMap.set(sender, data);
  return data.count > cfg.spamThreshold;
}


// ============================================================
//  START BOT IN PAIR CODE MODE
//  This creates a fresh socket and immediately calls
//  requestPairingCode() BEFORE WhatsApp can send a QR code.
// ============================================================
async function startPairMode(phoneNumber) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  store.bind(sock.ev);

  // CRITICAL: Request pair code IMMEDIATELY - don't wait for any events.
  // This must happen before WhatsApp sends QR in the connection.update event.
  // We use a small delay only to let the WebSocket TCP handshake complete.
  setTimeout(async () => {
    try {
      console.log("ðŸ”‘ Requesting pair code for:", phoneNumber);
      const code = await sock.requestPairingCode(phoneNumber);
      const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
      pairCode = formatted;
      console.log("âœ… Pair code generated:", formatted);
    } catch(e) {
      console.error("âŒ Pair code request failed:", e.message);
      pairCode = null;
    }
  }, 3000); // 3s lets WebSocket connect but is before QR generation (~5-8s)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // In pair mode, ignore QR - we don't want it
    if (qr) {
      console.log("âš ï¸ QR received in pair mode - ignoring (pair code already requested)");
    }

    if (connection === "close") {
      botConnected = false;
      connectionStatus = "disconnected";
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("âŒ Connection closed in pair mode. Code:", code);
      if (shouldReconnect && pairCode) {
        // Reconnect normally after successful pairing
        setTimeout(startBot, 3000);
      } else if (shouldReconnect) {
        setTimeout(startBot, 3000);
      }
    }

    if (connection === "open") {
      botConnected = true;
      connectionStatus = "connected";
      qrCodeData = null;
      const cfg = getConfig();
      const botJid = sock.user?.id;
      cfg.botNumber = botJid?.split(":")[0] || "";
      saveConfig(cfg);
      console.log("âœ… Nexa Bot connected via Pair Code! Number:", cfg.botNumber);

      // Attach full message handlers now that we're connected
      attachMessageHandlers(sock, saveCreds);

      try {
        const ownerJid = cfg.ownerNumber[0] + "@s.whatsapp.net";
        await sock.sendMessage(ownerJid, {
          text: `ðŸ¤– *Nexa Bot Connected!*\n\nâœ… Bot is now online via Pair Code!\nâ° Time: ${new Date().toLocaleString()}\n\nUse *${cfg.botPrefix}menu* to see all commands.`
        });
      } catch(e) {}
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ============================================================
//  BOT CONNECTION
// ============================================================
async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  // IMPORTANT: For pair code to work correctly:
  // - printQRInTerminal must be false
  // - browser must use Baileys.ubuntu() style (not mobile)
  // - socket must be created BEFORE requestPairingCode is called
  // - requestPairingCode must be called within ~20s of socket init
  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    // Use standard desktop browser - required for pair code to work
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 250,
    // Do NOT set mobile: true - breaks pair code
  });

  store.bind(sock.ev);

  // â”€â”€ Connection Updates â”€â”€
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      connectionStatus = "qr_ready";
      console.log("ðŸ“± QR Code ready! Open web panel to scan.");
    }

    if (connection === "close") {
      botConnected = false;
      connectionStatus = "disconnected";
      qrCodeData = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("âŒ Connection closed. Code:", code, "Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("âš ï¸ Logged out! Delete auth_info folder and restart.");
      }
    }

    if (connection === "open") {
      botConnected = true;
      connectionStatus = "connected";
      qrCodeData = null;
      config = getConfig();
      const botJid = sock.user?.id;
      config.botNumber = botJid?.split(":")[0] || "";
      saveConfig(config);
      console.log("âœ… Nexa Bot connected! Number:", config.botNumber);

      // Notify owner
      try {
        const ownerJid = config.ownerNumber[0] + "@s.whatsapp.net";
        await sock.sendMessage(ownerJid, {
          text: `ðŸ¤– *Nexa Bot Connected!*\n\nâœ… Bot is now online and ready!\nâ° Time: ${new Date().toLocaleString()}\n\nUse *${config.botPrefix}menu* to see all commands.`
        });
      } catch(e) {}
    }
  });

  // â”€â”€ Credentials Update â”€â”€
  sock.ev.on("creds.update", saveCreds);

  // Attach message/group/status handlers
  attachMessageHandlers(sock, saveCreds);

  return sock;
}

// ============================================================
//  SHARED MESSAGE HANDLERS (used by both startBot & startPairMode)
// ============================================================
function attachMessageHandlers(s, saveCreds) {
  

  // â”€â”€ Messages â”€â”€
  s.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const cfg = getConfig();
      const jid = msg.key.remoteJid;
      const isGroup = jid?.endsWith("@g.us");
      const sender = msg.key.participant || msg.key.remoteJid;

      stats.messages++;

      // Auto read
      if (cfg.autoRead) {
        try { await s.readMessages([msg.key]); } catch(e) {}
      }

      // Check spam
      if (checkSpam(sender)) {
        console.log("ðŸš« Spam detected from:", sender);
        continue;
      }

      // PM Notify
      if (!isGroup && cfg.pmNotify && !isOwner(sender)) {
        try {
          const ownerJid = cfg.ownerNumber[0] + "@s.whatsapp.net";
          const pmBody = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media]";
          await s.sendMessage(ownerJid, {
            text: `ðŸ“© *New PM Notification*\n\nFrom: @${sender.split("@")[0]}\nMessage: ${pmBody.substring(0, 100)}`
          });
        } catch(e) {}
      }

      // Auto recording for voice notes
      if (cfg.autoRecording && msg.message?.audioMessage) {
        try { await s.sendPresenceUpdate("recording", jid); } catch(e) {}
      }

      // Mode checks
      if (!cfg.publicMode && !isOwner(sender)) {
        // Only owner can use in private mode
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
        if (body.startsWith(cfg.botPrefix)) {
          await reply(sock, msg, "ðŸ”’ Bot is in *Private Mode*. Only owner can use commands.");
          continue;
        }
      }

      if (isGroup && !cfg.groupMode) continue;
      if (!isGroup && !cfg.privateMode && !isOwner(sender)) continue;

      // Anti-link
      const body2 = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      if (cfg.antiLink && isGroup && /https?:\/\//.test(body2) && !isOwner(sender)) {
        try {
          await s.groupParticipantsUpdate(jid, [sender], "remove");
          await s.sendMessage(jid, { text: `ðŸš« @${sender.split("@")[0]} was kicked for sending links!`, mentions: [sender] });
        } catch(e) {}
        continue;
      }

      // Handle commands
      await handleCommand(s, msg, cfg.botPrefix);
    }
  });

  // â”€â”€ Group Events â”€â”€
  s.ev.on("group-participants.update", async ({ id, participants, action }) => {
    const cfg = getConfig();

    if (action === "add" && cfg.welcomeMsg) {
      for (const p of participants) {
        try {
          await s.sendMessage(id, {
            text: `ðŸ‘‹ Welcome to the group, @${p.split("@")[0]}!\n\nðŸ¤– I'm ${cfg.botName}. Use *${cfg.botPrefix}menu* to see commands.`,
            mentions: [p]
          });
        } catch(e) {}
      }
    }

    if (action === "remove" && cfg.goodbyeMsg) {
      for (const p of participants) {
        try {
          await s.sendMessage(id, {
            text: `ðŸ‘‹ Goodbye @${p.split("@")[0]}! We'll miss you!`,
            mentions: [p]
          });
        } catch(e) {}
      }
    }
  });

  // â”€â”€ Status Updates â”€â”€
  s.ev.on("messages.upsert", async ({ messages }) => {
    const cfg = getConfig();
    if (!cfg.autoStatus) return;
    for (const msg of messages) {
      if (msg.key.remoteJid === "status@broadcast") {
        try { await s.readMessages([msg.key]); } catch(e) {}
      }
    }
  });

}
// ============================================================
//  KEEP ALIVE FOR RENDER
// ============================================================
app.get("/health", (req, res) => res.json({ status: "ok", connected: botConnected, uptime: process.uptime() }));

// Self-ping to keep Render alive
if (process.env.RENDER_EXTERNAL_URL) {
  const url = process.env.RENDER_EXTERNAL_URL + "/health";
  setInterval(async () => {
    try {
      const http = require("https");
      http.get(url, () => {}).on("error", () => {});
    } catch(e) {}
  }, 14 * 60 * 1000); // Every 14 minutes
}

// ============================================================
//  START
// ============================================================
app.listen(PORT, () => {
  console.log(`\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—`);
  console.log(`â•‘     ðŸ¤–  NEXA BOT v2.0           â•‘`);
  console.log(`â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£`);
  console.log(`â•‘  Web Panel: http://localhost:${PORT}  â•‘`);
  console.log(`â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n`);
});

startBot().catch(console.error);

// Crash protection - auto restart
process.on("uncaughtException", (e) => console.error("Uncaught:", e.message));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e?.message || e));
