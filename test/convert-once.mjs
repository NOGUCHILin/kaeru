// サーバーを立てて convert を1回だけ呼ぶ小さな道具（試験から使う）。
//   node test/convert-once.mjs <入力> <出力形式> <出力先>
// 変換に失敗したら終了コードを 1 にする。

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [input, to, output] = process.argv.slice(2);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const server = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '';
const waiting = new Map();
server.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const myId = ++id;
    waiting.set(myId, res);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'once', version: '0' } });
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const r = await rpc('tools/call', { name: 'convert', arguments: { input, to, output } });
server.kill();
const text = r.result?.content?.map((c) => c.text).join('\n') ?? '';
if (r.result?.isError) {
  process.stderr.write(`${text}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${text}\n`);
}
