import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import bank from '../api/bank.mjs';
import { closePool } from '../lib/db.mjs';

const port = Number(process.env.PORT || 8000);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/bank') return bank(req, res);
  if (/^\/assets\/(stocks|stock-companies|demo-accounts)\.mjs$/.test(path) && ['GET', 'HEAD'].includes(req.method)) {
    const script = await readFile(new URL('..' + path, import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : script);
  }
  if (/^\/assets\/backgrounds\/(sakura|forest|sea)\.jpg$/.test(path) && ['GET', 'HEAD'].includes(req.method)) {
    try {
      const photo = await readFile(new URL('..' + path, import.meta.url));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : photo);
    } catch { res.writeHead(404); return res.end('Image not found'); }
  }
  if (['/', '/index.html'].includes(path) && ['GET', 'HEAD'].includes(req.method)) {
    try {
      const html = await readFile(new URL('../index.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    } catch { res.writeHead(500); return res.end('Could not load the application.'); }
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(port, '127.0.0.1', () => console.log(`Bank: http://localhost:${port}`));
async function shutdown() {
  server.close(); await closePool(); process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
