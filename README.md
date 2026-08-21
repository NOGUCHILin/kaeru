# kaeru

**Convert anything. Your files are never uploaded to convert them.**
One tool your AI agents and you both use.

```bash
npx @linno-inc/kaeru --doctor     # what can this machine convert?
```

## Verified, not claimed

Every conversion listed below was **actually run, one by one, on real machines** — and the
output was re-opened with a second tool to prove it isn't empty. The test suite ships with
the code, so you can re-run the count yourself.

| OS | Conversions offered | Actually passed | Tools installed |
|---|---|---|---|
| **macOS 26** | 4,778 | **4,752 / 4,752** | all |
| **Windows 11** | 4,062 | **3,708 / 3,952** | ImageMagick, pandoc |
| **Debian (Linux)** | 3,426 | **3,218 / 3,329** | ImageMagick, pandoc |

```bash
npm test        # re-run every combination on your machine
npm run list    # print the conversion table (this is what the numbers count)
```

Numbers differ per machine **on purpose** — see below.

## The table adapts to your machine

kaeru doesn't bundle converters. It finds the ones you already have — and asks each one
what *its version* actually supports. **A conversion that can't work is never offered.**

```
$ npx @linno-inc/kaeru --doctor
This machine can do: 4,062 conversions

Tools:
  ✓ magick      C:\Program Files\ImageMagick-7.1.2-Q16-HDRI\magick.EXE
  ✗ ffmpeg      not found
  ...

Install these to unlock more:
  ffmpeg      +468 conversions   winget install Gyan.FFmpeg
```

Nothing installed? Nothing breaks — you get 0 conversions and a list of one-line installs.

## Two doors, one engine

| Door | For | Start it |
|---|---|---|
| **MCP server** | your AI agents | add one line to `.mcp.json` |
| **Local web page** | you | `npm run ui` → http://127.0.0.1:19921 |

Both call the same code, so an agent and a human can never disagree about what's possible.

### For agents (MCP)

```json
{ "mcpServers": { "kaeru": { "command": "npx", "args": ["-y", "@linno-inc/kaeru"] } } }
```

One tool, `convert`. Ask for something impossible and it replies with what *is* possible
from that input — or which tool to install.

### For humans

`npm run ui` opens a single page on `127.0.0.1` only. Drop a file, pick a target, save the
result. **It does not stay running** — Ctrl-C and it's gone. No Docker, no daemon, no account.

## What it converts

Images · video · audio · documents (md, html, tex, docx, odt, epub, and ~30 more) · Office
and spreadsheets · PDF · 3D models · Parquet.

PDFs can be **merged, split, compressed and rasterised**. Images, audio and PDFs can be
**shrunk without changing format**. Pass a URL to pull from video sites.

CJK encodings are detected automatically (a Shift_JIS CSV from Excel just works).

## Every result comes with its receipt

```
Converted: csv>xlsx
Output:    /path/to/data.xlsx
Tool:      soffice
Command:   soffice --headless --convert-to xlsx --outdir /tmp/... /path/to/data.csv
Took:      3,512 ms
```

You can always see which program touched your file, and repeat it by hand.

## Install the converters

kaeru calls these; install the ones you need (or none, and add them later).

<details>
<summary><b>macOS</b></summary>

```bash
brew install imagemagick ffmpeg pandoc weasyprint qpdf img2pdf yt-dlp assimp duckdb ghostscript
brew install --cask libreoffice
```
</details>

<details>
<summary><b>Windows</b></summary>

```powershell
winget install ImageMagick.ImageMagick Gyan.FFmpeg JohnMacFarlane.Pandoc QPDF.QPDF `
  yt-dlp.yt-dlp Assimp.Assimp DuckDB.cli ArtifexSoftware.GhostScript TheDocumentFoundation.LibreOffice
pip install weasyprint img2pdf
```
</details>

<details>
<summary><b>Linux (apt)</b></summary>

```bash
sudo apt install imagemagick ffmpeg pandoc qpdf img2pdf yt-dlp assimp-utils ghostscript libreoffice
pip install weasyprint
```
</details>

## Privacy and security

- Files are processed by local programs. **kaeru makes no network requests** (except when you
  explicitly pass a video-site URL — that path downloads, by definition).
- **What kaeru does not control: what you do with the result.** If your agent then *reads* the
  converted file, its contents go to whatever model provider that agent uses. kaeru governs the
  conversion, not the reading. For a file that must never reach a model, convert it and open it
  yourself in the local web page (`npm run ui`) instead of handing it to an agent.
- The web page binds to `127.0.0.1`, rejects non-localhost `Host` headers, and hands results
  back by an unguessable id.
- **Existing files are never overwritten** unless you ask for it.
- **No telemetry. Ever.** Not anonymous, not opt-out — none.

Three independent models reviewed the source on 2026-08-18; every exploitable finding was
fixed the same day. **One known risk is not fixed: converting untrusted HTML or SVG can embed
local files in the output.** Details, severities and mitigations: [SECURITY.md](SECURITY.md).

## Tests

| Command | What it checks |
|---|---|
| `npm test` | every listed conversion actually runs, output re-opens |
| `node test/quality.mjs` | images round-trip pixel-for-pixel; text survives |
| `node test/fidelity.mjs` | documents keep headings, tables, lists, emphasis |
| `node test/languages.mjs` | 12 writing systems keep their characters |
| `node test/platforms.mjs` | tool lookup is correct for macOS / Windows / Linux |

Known gaps are written down, not hidden — see `docs/`.

## Support

Issues are welcome. **This is a one-person project: no response time is promised.**
For a bundled installer or a support contract, see the bottom of this file.

## License

MIT. The converters it calls have their own licenses.

---

**Need this installed for a team, or with a support contract?** Open an issue titled
`commercial` and I'll get back to you.
