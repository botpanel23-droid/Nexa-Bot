const express = require('express');
const app = express();
const path = require('path');
const bodyParser = require('body-parser');
const PORT = process.env.PORT || 8000;

require('events').EventEmitter.defaultMaxListeners = 500;

const pairRouter = require('./pair');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// ===================== API ROUTES =====================
// Pair code route: /code?number=xxx
app.use('/code', pairRouter);

// Main web page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
╭━━━━━━━━━━━━━━━━━━━━━━━⭓
│  ⚡ 𝑵𝒆𝒙𝒂 𝑩𝒐𝒕 𝑺𝒆𝒓𝒗𝒆𝒓
│  🌐 Port: ${PORT}
│  🔗 http://localhost:${PORT}
│  🚀 Status: ONLINE
╰━━━━━━━━━━━━━━━━━━━━━━━⭓
  `);
});

module.exports = app;
