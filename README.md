# Netglimmer Publish (`siyuan-plugin-netglimmer-Publish`)

One click publishes a SiYuan document as a **byte-identical "HTML (SiYuan)" folder** to a WebDAV / FTP / SFTP server or a local folder. Backlinks, block references, block embeds and image assets all survive — the published page renders exactly like the official "share document" output.

Chinese documentation: [`README_zh_CN.md`](README_zh_CN.md) (more detailed, includes the full per-version changelog).

## What it automates

The manual loop "export HTML → copy into the web root" has two problems: you redo it after every edit, and the target folder accumulates stale files. This plugin does the whole chain for you:

right-click → export "HTML (SiYuan)" to SiYuan's temp folder → concurrent PUT upload → read-back byte verification of every file → temp cleanup.

Re-publishing the same document is incremental by default: the SiYuan *runtime* (the ~570 byte-identical `stage/` + `appearance/` files that every export carries along) is skipped when the server already has it, so a second publish of the same document uploads ~20 KB instead of 34 MB. Since v0.9.12 a stale directory left behind by a document rename/move is cleaned up automatically, and two documents with the same title can no longer overwrite each other.

> SiYuan 3.8.6+: the kernel export API no longer writes `index.html` (the front end assembles it and saves it through a separate API). Since v0.6.0 the plugin ships a verbatim port of that assembly code, so the published `index.html` is byte-for-byte identical to a manual "HTML (SiYuan)" export.

## Protocols

| Protocol | Transport | Notes |
|---|---|---|
| WebDAV | kernel `/api/network/forwardProxy`, with a browser-channel fallback | Works through the kernel; ~32 MiB per file on the proxy fallback path |
| FTP | built-in pure-JS client over the desktop Node `net` socket | PASV; auto-detects UTF8 support and falls back to GBK paths for legacy Chinese Windows servers |
| SFTP | built-in pure-JS SSH-2 / SFTP v3 client (password auth) | TOFU host key pinning; no external binaries required |
| Local folder | desktop Node `fs` | Any absolute path, e.g. `/var/www/html` or `D:\www\publish` |

Each protocol keeps **its own** server / username / password / sub-directory profile; switching protocols swaps the whole profile, so a WebDAV setup never leaks into the FTP form. Publishing always uses the currently selected protocol only.

## Install

Unzip into `{workspace}/data/plugins/siyuan-plugin-netglimmer-Publish/` and restart SiYuan. Desktop only.

> The plugin id was renamed from `siyuan-plugin-webdav-publish` to `siyuan-plugin-netglimmer-Publish`. On first start it migrates settings and publish history from the old id; the old folder can then be deleted.

## Settings

Open SiYuan "Settings → Plugin market / Loaded plugins → Netglimmer Publish". Publishing without a saved configuration opens the panel for you.

| Field | Meaning |
|---|---|
| Transport protocol | WebDAV (default) / FTP / SFTP / Local folder |
| Server address | WebDAV: root URL, e.g. `https://example.com/dav`; FTP/SFTP: `host[:port]`; Local: absolute folder path |
| Username / password | Per protocol; leave empty for a local folder; SFTP supports password auth only |
| Remote sub-directory | Optional, e.g. `publish`. `.` / `..` segments are rejected outright (they would let a recursive delete escape the base folder on the local protocol); over-long Chinese titles are clamped to 120 UTF-8 bytes with a trailing `-` so `mkdir` cannot fail on 255-byte per-segment limits |
| Clear remote folder first | On by default. With incremental publishing the whole tree is *not* deleted (that would also delete the runtime); only orphaned assets inside this document's folder and renamed/moved leftovers are removed |
| Inject side outline | On by default; equivalent to running `add_toc.py` by hand |
| Include sub-documents | Decides whether the single right-click entry publishes the document alone or merged with its children |
| Incremental publish | Skip re-uploading the runtime that is already on the server |
| Per-file retries | 1–6, default 3. Only transient failures are retried (connection resets, timeouts, 408/425/429/5xx) with exponential backoff; 401/403/550 fail immediately with the real reason |
| Concurrency | 0 = per-protocol default (WebDAV 6, SFTP/Local 4, FTP 1); override with 1–16 |
| Max file size (MB) | Default 64, 0 = unlimited; larger files are skipped with an explicit error instead of being slurped into memory |
| Debug log | Off by default; prints every request/upload to the browser console |
| Known host keys (SFTP) | Shows how many fingerprints are stored and offers "Clear all" — needed after a server rebuild so TOFU pinning does not lock you out |

**Credential storage (please read):** server, username and password are stored in **plaintext** in `data/storage/petal/siyuan-plugin-netglimmer-Publish/settings.json` inside your workspace. That is standard for SiYuan plugins: SiYuan offers no keychain-grade storage API, and any "encryption" whose key also lives on the same machine only deceives the reader, not an attacker — so we do not ship fake encryption. Mitigations: ① never sync or share the workspace (or `data/storage/petal/`) as-is; ② keep the workspace on a disk-encrypted volume (BitLocker / FileVault / LUKS); ③ give the publishing account write access to the target sub-directory only; ④ delete the `password` field before sharing a config. `history.json` holds no passwords but does contain URLs and document names — treat it as sensitive too.

Test the connection before saving: WebDAV runs a PROPFIND reachability/auth probe then a write probe (MKCOL → PUT → DELETE); FTP/SFTP log in and then create a folder, upload a file of known size, verify its size and delete it. SFTP reports and records the host key fingerprint on first contact (TOFU) and refuses to connect if it changes later — clear it under "Known host keys (SFTP)".

## Usage

Right-click any document in the file tree (or the title icon in the editor): there is exactly **one** entry, "Netglimmer One-Click Publish". Whether sub-documents are merged is a setting, not a second menu row. If the document changed after its last publish, the entry reads "Changes detected — republish".

While publishing you get a single progress panel in the bottom-right (phase text, byte-based progress bar, current file name, throttled). Transient network faults retry automatically. The final message states the outcome, e.g.:

`Published: http://your.site/publish/article-title/ | uploaded 1 file / 20.9 KB, reused 548 runtime files already on the server, 1 s`

**File-tree badge**: a 🌐 globe sits right after the title of any published document; after you edit it, the badge becomes an amber ⬆ (both click through to the live page).

**Publish dashboard**: the "Publish dashboard" tab in the settings dialog, or the status-bar entry. Records are newest first (time, document, protocol, result, file/byte counts, URL, error; one row per document+protocol, re-publishing just refreshes it). Each row offers:

- **Open / Copy** — Open works for `http(s)://` and for `file://` (local folder); Copy puts the address on the clipboard for `ftp://` / `sftp://` (falls back to `execCommand` when the Clipboard API is unavailable in the webview).
- **Change status** — filled in automatically by one batch query when the dashboard opens: unchanged / changed / unknown.
- **Republish / Retry** — always uses the protocol that record was published with, not the current default.
- **Dry run** — computes which files *would* be uploaded, their total size and how much could be reused, and writes nothing at all (no mkdir, no delete, no upload, no history row). The cheapest way to sanity-check a first full publish.
- **Unpublish** — deletes this document's remote folder; the local document and the history row stay (marked "Unpublished", tree badge disappears). Refused when the folder carries another document's ownership marker, and refused (with an explanation instead of a guess) for legacy rows that have no remote path segments recorded.

Only one publish runs at a time; a second click is queued and starts automatically, so two tasks can never delete each other's files. If a publish fails after the remote folder was created or partially uploaded, the message says the folder may be incomplete and points at "dry run then republish" or "unpublish to clear it".

## Server notes

- **IIS**: after enabling WebDAV publishing, `webDAV` → `fileExtensions` in `web.config` must not block `.html/.css/.js`/images, and request filtering needs the relevant extensions allowed for `PUT`.
- **Nginx**: `dav_methods PUT DELETE MKCOL;` plus `create_resources put;`, and `dav_access` permissions of `0644/0755` so the worker can read what was written.
- The WebDAV folder must also be the static site root (or reverse-mapped to it); no service restart is needed.
- **FTP / SFTP** write into the login user's writable path (FTP: current directory after login; SFTP: home). Point the remote sub-directory at a symlink/mount reachable from the web root, or aim the site at that folder.
- **Bookkeeping file in each published folder**: `netglimmer-owner-<document-id-suffix>.json` (a few dozen bytes containing only the document id) tells the plugin who owns a folder, which is what stops two same-titled documents from wiping each other. The name deliberately has **no leading dot**: vsftpd defaults to `hide_dotfiles=yes` and such a file would never appear in an FTP LIST/MLSD, silently disabling collision detection. Blocking the name with a server rule leaves browsing intact but loses that protection.
- **FTP delete permission** is required by "clear remote folder first" and by probe cleanup. If the server refuses deletes, the plugin switches to a fixed-name overwrite probe and keeps working — but renamed/deleted leftovers then need manual cleanup, so granting delete is preferable.

## Source layout and build (for maintainers)

SiYuan front ends execute a single `index.js`, so the shipped artifact must be one file. The repository splits review-friendly code from fixed/vendored data and splices it back with a dependency-free script:

```
siyuan-plugin-netglimmer-Publish/
├── src/
│   ├── core.js                  ← everything you normally edit: i18n dicts, helpers, FTP/SSH
│   │                              clients, uploaders, resilience (retry/pool), settings UI,
│   │                              dashboard, publish() main flow
│   └── vendored/
│       ├── index-html.js        ← verbatim port of SiYuan 3.8.6's index.html assembly
│       ├── toc.js               ← side-outline payload + injectToc
│       └── gbk-table.js         ← GBK/Unicode code page table (one ~67 KB base64 line)
├── build.js                     ← splicer (Node fs only, no npm deps)
├── index.js                     ← artifact: core.js + the three vendored segments
├── plugin.json
├── icon.png                     ← marketplace card icon (512×512 RGBA, made by tools/make-icon.py)
├── tools/make-icon.py           ← dependency-free icon renderer (pure Python, no PIL/cairosvg)
└── i18n/{zh_CN,en_US}.json      ← generated from the dict embedded in src/core.js
```

```bash
node build.js           # regenerate index.js after editing src/
node build.js --verify  # prove index.js on disk equals the splice, byte for byte (no writes)
node build.js --check   # only internal consistency: markers ↔ files, no orphan segments
```

Rules and traps:

- **Never edit `index.js`** — it is generated and will be overwritten.
- `/* @@VENDOR:name@@ … */` in `src/core.js` are splice markers (comments, no-ops at runtime); everything after `/* @@SEGMENT-BEGIN@@ */` in `src/vendored/*.js` is pasted verbatim, so do not add or remove blank lines at its edges or `--verify` fails.
- When porting new front-end code after a SiYuan upgrade, first export "HTML (SiYuan)" by hand as a baseline, then change `src/vendored/index-html.js`, and the full byte verification inside `publish()` (or the local regressions) must pass. This plugin's whole value proposition is "byte-identical to a manual export", not "close enough".
- The two i18n JSON files are generated from the dictionary embedded in `src/core.js`; add every new string to both locales (the regression asserts identical key sets).
- Packaging: `node build.js && node build.js --verify`, then zip `index.js`, `plugin.json`, `icon.png`, `README.md`, `README_zh_CN.md`, `i18n/`. Do not ship `src/` or `build.js` inside the plugin zip. `backends` must be empty (there is no kernel-side code) and `frontends` may only use values SiYuan actually has (`desktop`, `desktop-window`, `browser-desktop`, `browser-mobile`, `mobile`, `all`) — `desktop-store` / `desktop-linux` are invalid.
- Marketplace icon: SiYuan 3.8.6 only looks for **`icon.png` in the plugin's root folder**. `getInstalledPlugin` fills `iconURL` with `/plugins/<dir>/icon.png?v=<timestamp>` when that file exists, and the card uses it as `<img src>`; otherwise (or on load error) it falls back to the generic store placeholder. There is no icon field in `plugin.json`. Regenerate with `python3 tools/make-icon.py` (512×512 RGBA, ~12 KB, zero dependencies, and it also renders light/dark and 64 px previews so the document-plus-upload glyph stays legible at card size).

Regressions live in `/root/harness/` and need the local kernel (16806) plus vsftpd 2121 / sshd 2222:

| Script | Covers |
|---|---|
| `run-all.js` | Everything below; rebuilds first and syncs the artifact into `pkg/` (`--skip-webdav` to skip the real IIS leg) |
| `run-build.js` | Split structure: byte-level restore, marker↔file parity, syntax of each part, no giant lines in the main file |
| `run-resilience.js` | Error classification, backoff, concurrency cap, fast abort |
| `run-owner.js` | v0.9.12 safety set: path hardening, dry run writes nothing, two same-titled docs get separate folders, rename leftover cleanup (with ownership guard), unpublish (including refusal cases) |
| `run-inject.js` | Fault injection through the real `publish()` path (transient retry succeeds / 403 fails fast / retry entry) |
| `run-badge.js` | Tree badge two-state machine, batch change fingerprints, throttling, single right-click entry |
| `run-multi.js` | FTP / SFTP / local end-to-end: full + incremental publish, history dedup, dashboard render |
| `run.js` | WebDAV end-to-end against real IIS: full + incremental, probes, full byte verification |

## Recent changes

**v0.9.12** — safety round:

- Same-titled documents no longer overwrite each other: each published folder carries a `netglimmer-owner-<id>.json` marker, and a collision automatically relocates to `title-<id>`.
- Remote path hardening: `.` / `..` segments are rejected everywhere, long Chinese titles are clamped to 120 UTF-8 bytes per segment.
- Folders left behind by a document rename/move are cleaned up after a successful re-publish (skipped when the old folder belongs to someone else).
- Dashboard gained Dry run, Unpublish and Copy address; `file://` records got an Open button again; publishes are queued instead of racing.
- Partial-failure state is now reported explicitly ("remote folder may be incomplete") with a clear way out.
- New settings: per-file retries, concurrency, max file size, debug logging, and a real "clear known host keys" control.
- Fixes found by the new regressions: the four new knobs were not persisted on save; SFTP/WebDAV `deleteTree` left an empty top folder behind; a failed ownership-marker write used to fail an otherwise complete publish (now a warning).
- Metadata corrected: empty `backends`, valid `frontends`, and the shipped English `README.md` that `readme.default` points at.

Earlier history (incremental publishing, multi-protocol clients, dashboard, tree badges, byte-exact export parity) is documented per version in [`README_zh_CN.md`](README_zh_CN.md).

## Known limitations

- Export format is fixed to "HTML (SiYuan)" for now; PDF / Word / Markdown bundles are future work.
- Encrypted notebooks cannot be published (the kernel refuses plaintext export).
- SFTP supports password authentication only (no private key / passphrase).
- FTP/SFTP use direct sockets from the desktop Node, so they bypass the 32 MiB proxy limit but require the desktop to reach the server port directly (corporate proxies: run "Test connection" first).
- Change detection compares SiYuan's own block index (block count + last updated); editing the remote files afterwards is invisible to it.
- Ownership detection depends on the `netglimmer-owner-*.json` marker; remove or block it and same-titled documents will overwrite each other again.
- "Unpublish" only deletes the remote path recorded in that history row; rows created before v0.9.12 have no recorded segments and are deliberately not guessed at.
