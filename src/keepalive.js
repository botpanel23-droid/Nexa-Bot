// Keep-alive ping for Render free tier
// This prevents the service from sleeping

import https from 'https';

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

const keepAlive = () => {
  const url = new URL(RENDER_URL + '/api/status');
  
  if (url.protocol === 'https:') {
    https.get(url.href, (res) => {
      console.log(`[KeepAlive] Pinged - Status: ${res.statusCode}`);
    }).on('error', (e) => {
      console.log('[KeepAlive] Error:', e.message);
    });
  }
};

// Ping every 14 minutes to prevent Render from sleeping
setInterval(keepAlive, 14 * 60 * 1000);

export default keepAlive;
