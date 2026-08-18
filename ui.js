#!/usr/bin/env node
// kaeru — 人が使う入口（1枚のページ）。変換そのものは convert.js が持っている。
//
//   npm run ui        → http://127.0.0.1:19921 を開く
//
// 守っていること:
//  - **127.0.0.1 にだけ耳を貸す**。外の機械からは触れない
//  - **常駐しない**。使い終わったら Ctrl-C で終わり（Docker は使わない）
//  - **手元から出ない**。ファイルは一時フォルダに置き、終了時に消す

import { createServer } from 'node:http';
import { mkdtempSync, rmSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { convert, pairs, targets, missing } from './convert.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KAERU_UI_PORT ?? 19921);
const WORK = mkdtempSync(join(tmpdir(), 'kaeru-ui-'));
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB。これ以上は受け取らない
const MAX_BUSY = 4;   // 同時に扱う変換の数
const KEEP = 50;      // 手元に置いておく変換の数（古い箱から捨てる）
let busy = 0;

// 出来たファイルは、鍵（推測できない id）を知っている人にだけ渡す。
// パスをそのまま URL に載せると、この端末の別のファイルまで読めてしまう。
const made = new Map();
const boxes = [];   // 作った順。捨てる時はこの順に箱ごと

const all = pairs();
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',      // 中身を勝手に別の型と解釈させない
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
};

// **受け取ったものをメモリに溜めない。** 溜めると 2GB のファイルで node が落ちる
// （公開前のレビューで「高」と指摘された）。ディスクへ流しながら大きさだけ見張る。
const saveBody = (req, path, limit) =>
  new Promise((ok, ng) => {
    const out = createWriteStream(path, { mode: 0o600, flags: 'wx' });
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        ng(new Error(`大きすぎます（上限 ${Math.floor(limit / 1024 / 1024)}MB）`));
        req.destroy();
        out.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => ok(size));
    out.on('error', ng);
    req.on('error', ng);
  });

// **DNS リバインディング対策。** 127.0.0.1 で待つだけでは足りない:
// 悪意のあるサイトが自分のドメインを 127.0.0.1 に向け直すと、ブラウザからは
// 「同じ出どころ」に見えてしまい、外のページからこのサーバーを叩けてしまう。
// 名前が localhost / 127.0.0.1 / [::1] の時だけ相手にする（これが標準的な防ぎ方）。
const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const server = createServer(async (req, res) => {
  if (!ALLOWED_HOST.test(req.headers.host ?? '')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('kaeru only answers to localhost.\n');
    return;
  }
  // `Host: localhost:99999` のような値でも new URL は例外を投げる。
  // ここで落ちるとサーバーごと止まるので、必ず受け止める（2026-08-18 の指摘）
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    return send(res, 400, JSON.stringify({ error: 'bad request' }));
  }

  if (url.pathname === '/' && req.method === 'GET') {
    const html = join(HERE, 'ui', 'index.html');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      // 外から何も読み込まない画面なので、自分自身以外は全部止めておく
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; "
        + "script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'",
    });
    createReadStream(html).pipe(res);
    return;
  }

  // ブラウザが黙って取りに来る。返さないと画面の記録に赤い印が残る
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/info') {
    // 足りない道具も返す。**他人の機械では道具が揃っていない**のが普通なので、
    // 「できない」ではなく「これを入れると増える」と言えるようにする。
    return send(res, 200, JSON.stringify({
      pairs: all.length,
      inputs: new Set(all.map((k) => k.split('>')[0])).size,
      missing: missing(),
    }));
  }

  // その入力から本当に作れる形式だけを返す（画面は選ばせる前にこれを聞く）
  if (url.pathname === '/targets') {
    const ext = (url.searchParams.get('ext') ?? '').toLowerCase();
    return send(res, 200, JSON.stringify({ targets: ext ? targets(ext) : [] }));
  }

  if (url.pathname === '/convert' && req.method === 'POST') {
    // 同時に受ける数を絞る。並べて投げられると各 2GB まで書かれてしまう
    if (busy >= MAX_BUSY) return send(res, 429, JSON.stringify({ error: 'busy, try again' }));
    busy += 1;
    let box;
    try {
      const name = basename(decodeURIComponent(req.headers['x-filename'] ?? 'input'));
      const to = String(req.headers['x-to'] ?? '').toLowerCase();
      if (!name || !to) throw new Error('ファイル名か変換先がありません。');
      // 変換先は「英数字だけ」。対応表に無い物は弾かれるので実害は出ていないが、
      // **出力先の組み立てに使う値**なので、ここで形を縛っておく（念のため）
      if (!/^[a-z0-9]{1,12}$/.test(to)) throw new Error('変換先の形式名が不正です。');
      // 変換ごとに専用のフォルダを作る。同じ名前どうしがぶつからないようにするため
      box = join(WORK, randomUUID());
      await mkdir(box, { recursive: true, mode: 0o700 });
      const src = join(box, name);
      const size = await saveBody(req, src, MAX_BYTES);
      if (size === 0) throw new Error('中身が空です。');

      // 出来上がりは**別のフォルダ**へ。同じ場所だと、同じ形式のまま小さくする時に
      // 「出力先が入力と同じ」になって失敗する（2026-08-18 に実際に壊れていた）
      const outDir = join(box, 'out');
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      const dst = join(outDir, `${basename(name, extname(name))}.${to}`);
      const r = await convert({ input: src, to, output: dst });

      const files = [];
      for (const p of r.outs) {
        const id = randomUUID();
        made.set(id, p);

        files.push({ id, name: basename(p), bytes: (await stat(p).catch(() => ({ size: 0 }))).size });
      }
      // **箱ごと**古い順に捨てる。ファイル単位で数えて箱ごと消すと、
      // 51ページの PDF が自分の兄弟を巻き添えにする（2026-08-18 の指摘）
      boxes.push(box);
      while (boxes.length > KEEP) {
        const old = boxes.shift();
        for (const [id, p] of made) if (p.startsWith(old)) made.delete(id);
        rmSync(old, { recursive: true, force: true });
      }

      return send(res, 200, JSON.stringify({
        files, cmd: r.cmd, command: `${r.cmd} ${r.args.join(' ')}`, ms: r.ms, note: r.note ?? null,
      }));
    } catch (e) {
      // 途中で失敗した分を残さない。残すとディスクを埋められる
      if (box) rmSync(box, { recursive: true, force: true });
      return send(res, 400, JSON.stringify({ error: e.message }));
    } finally {
      busy -= 1;
    }
  }

  if (url.pathname === '/file') {
    const path = made.get(url.searchParams.get('id') ?? '');
    // 鍵に覚えのないものは返さない（パスを直接受け取らないのはこのため）
    if (!path || !resolve(path).startsWith(WORK)) return send(res, 404, JSON.stringify({ error: 'ありません' }));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    });
    createReadStream(path).pipe(res);
    return;
  }

  send(res, 404, JSON.stringify({ error: 'ありません' }));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { rmSync(WORK, { recursive: true, force: true }); process.exit(0); });
}
process.once('exit', () => rmSync(WORK, { recursive: true, force: true }));

// 外に出さない。127.0.0.1 だけ
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`kaeru の画面: http://127.0.0.1:${PORT}\n終わる時は Ctrl-C\n`);
});
