#!/usr/bin/env node
// kaeru — エージェント向けの入口（MCP）。変換そのものは convert.js が持っている。
// ここがするのは「頼まれたことを渡して、何をしたかを言葉にして返す」だけ。
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { convert, pairs, missing } from './convert.js';
import { inventory } from './tools.js';

const all = pairs();
const inputCount = new Set(all.map((k) => k.split('>')[0])).size;

const server = new McpServer({ name: 'kaeru', version: '0.6.0' });

server.registerTool(
  'convert',
  {
    // 形式を全部並べると、この説明だけで毎回かなりの分量を全エージェントに読ませることに
    // なる。族と数だけ言い、細かい行き先は「駄目だった時に候補を返す」形で渡す。
    description:
      `ファイルを別の形式に変換する（${all.length}通り・入力${inputCount}形式）。` +
      '変換はすべてこの端末の中で完結し、クラウドへは送らない。' +
      '扱うもの: 画像・動画・音声・文書（md/html/tex/docx/odt/epub ほか）・' +
      'Office と表計算（CSV の文字コードは自動判別）・PDF・3Dモデル・Parquet。' +
      'PDF は結合（input に複数）・切り出し（pages）・圧縮・画像化ができる。' +
      '同じ形式を to に指定すると、形は変えずに小さくする（画像・音声・PDF）。' +
      '動画サイト（YouTube・X 等）は input に URL を渡す。' +
      '対応していない組み合わせを頼むと、その入力から作れる形式の一覧が返る。' +
      '出力先に既にファイルがある時は止まる（消してよいなら overwrite: true）。',
    inputSchema: z.object({
      input: z
        .union([z.string(), z.array(z.string())])
        .describe('入力ファイルの絶対パス。動画サイトの URL でもよい。PDF の結合だけ複数渡せる'),
      to: z.string().describe('出力形式（拡張子。例: pdf）'),
      output: z.string().optional().describe('出力先の絶対パス。省略時は入力と同じ場所に置く'),
      pages: z.string().optional().describe('PDF から切り出すページ（例: 1-3,5）。指定しなければ全ページ'),
      overwrite: z.boolean().optional()
        .describe('出力先に既にファイルがある時、上書きしてよいか。既定は false（黙って消さない）'),
    }),
  },
  async (args) => {
    try {
      const { key, outs, cmd, args: cmdArgs, ms, note } = await convert(args);
      return {
        content: [{
          type: 'text',
          text: [
            `変換しました: ${key}`,
            `出力: ${outs.join('\n      ')}`,
            `使った道具: ${cmd}`,
            `実行したコマンド: ${cmd} ${cmdArgs.join(' ')}`,
            `所要時間: ${ms}ms`,
            ...(note ? [`注意: ${note}`] : []),
          ].join('\n'),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  },
);

// `node server.js --list` で対応表をそのまま出す。数を主張する時はここを数える
// （別に数え直すと必ずずれる）。試験（test/matrix.mjs）もこれを読んで回す。
// process.exit を使うと書き終わる前に落ちて**途中で切れる**（8KB で切れた・実測）。
// 書くだけ書いて、あとは何もしないで終わらせる。
if (process.argv.includes('--list')) {
  if (all.length) process.stdout.write(`${all.join('\n')}\n`);
} else if (process.argv.includes('--doctor')) {
  // この機械で何が使えるかを見る。**入れる前と後で数がどう変わるか**が分かる形にする。
  const lines = ['この機械で使える変換: ' + all.length + '通り', '', '道具:'];
  for (const { tool, path } of inventory()) {
    lines.push(`  ${path ? '○' : '×'} ${tool.padEnd(11)} ${path ?? '見つからない'}`);
  }
  const lost = missing();
  if (lost.length) {
    lines.push('', '足りない道具を入れると増える分:');
    for (const m of lost) lines.push(`  ${m.tool.padEnd(11)} +${m.lost}通り   入れ方: ${m.install}`);
  } else {
    lines.push('', '道具はすべて揃っています。');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  await server.connect(new StdioServerTransport());
}
