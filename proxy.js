/**
 * proxy.js — Proxy local para Gemini API con autenticación OAuth (AQ.)
 * Uso: node proxy.js
 * Puerto: 3001
 */

const http = require('http');
const https = require('https');

const PORT = 3002;
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_PATH = '/v1beta/models/gemini-2.0-flash-lite:generateContent';

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  // Leer API key del header x-api-key
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    res.writeHead(400); res.end('Falta x-api-key header'); return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      hostname: GEMINI_HOST,
      path: `${GEMINI_PATH}?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const proxyReq = https.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', e => {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`✓ Proxy Gemini corriendo en http://localhost:${PORT}`);
  console.log(`  Pega tu key AQ. en la app y recarga`);
});
