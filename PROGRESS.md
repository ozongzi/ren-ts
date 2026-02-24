# RRS Refactoring Progress

## Overview
Refactoring the Camp Buddy-specific VN player into a **generic Ren'Py story reader**.
Key tasks: rename `cbscript` → `rrs`, add `define` language feature, remove CB-specific hardcoding.

---

## Task Checklist

### Phase 1 — Rename cbscript → rrs ✅ DONE
- [x] Create `tools/rrs/` with all files from `tools/cbscript/`
- [x] Create `src/rrs/` with all files from `src/cbscript/`
- [x] Update file extension references `.cbscript` → `.rrs` throughout source
- [x] `src/loader.ts` — imports updated to `./rrs/index`, `.rrs` extension checks
- [x] `src/types.ts` — Manifest type updated with `start?` and `game?` fields
- [x] Internal comments renamed (lexer, codegen, parser, index)
- [x] `rpy2cbscript.ts` renamed to `rpy2rrs.ts`

### Phase 2 — Add `define` AST node ✅ DONE
- [x] `tools/rrs/types.ts` — `DefineDecl` type added, `Program.defines` field added
- [x] `src/rrs/ast.ts` — same
- [x] `tools/rrs/parser.ts` — top-level loop recognises `define`, `parseDefine()` added
- [x] `src/rrs/parser.ts` — same
- [x] `tools/rrs/codegen.ts` — `buildDefineMaps()`, `CodegenContext` takes charMap/audioMap, `genSpeak()` resolves abbr→name, `resolveAudioAlias()` added
- [x] `src/rrs/codegen.ts` — same

### Phase 3 — Update converter (rpy2rrs.ts) ✅ DONE
- [x] Remove `CHAR_MAP` hardcoded table
- [x] Remove `DEFAULT_SCRIPT_RPY` hardcoded path
- [x] Remove `MINIGAME_STUB_EXIT` table → replaced with `STUB_EXIT_MAP` populated by `--stub-exit label=var`
- [x] Auto-detect `Character("Name")` from `.rpy` → `charMap` in `AssetMaps`
- [x] `script.rpy` no longer in skip list — its labels (incl. `label start`) are now converted
- [x] `DEFAULT_SKIP_FILES` trimmed to generic UI/system files only
- [x] `--skip <pattern>` CLI option added
- [x] `--stub-exit label=varName` CLI option added
- [x] `--game <name>` CLI option added (written into manifest.json)
- [x] `--script <path>` now optional with auto-detection from game dir; warns if missing
- [x] Converter emits speaker abbreviation (not full name) in `speak` stmts — define header resolves it
- [x] Manifest now includes `start: "start"` and optional `game` field
- [x] Output extension `.rrs` everywhere

### Phase 4 — Remove Camp Buddy hardcoding from runtime ✅ DONE
- [x] `src/engine.ts` — `startNewGame()` reads `getManifestStart()` instead of hardcoded `"day1"`
- [x] `src/evaluate.ts` — `defaultVars()` returns `{}`
- [x] `src/components/DialogueBox.tsx` — `CHARACTER_COLORS` cleared to `{}`
- [x] `src/types.ts` — `Manifest` interface has `start?` and `game?`
- [x] `src/loader.ts` — `getManifestStart()` and `getManifestGame()` exported; `manifestStart`/`manifestGame` state added

### Phase 5 — Update tooling files ✅ DONE
- [x] `tools/rrs/cli.ts` — all `.cbscript` references replaced with `.rrs`; help text, file filter, output path derivation, task names updated
- [x] `tools/rrs/batch_roundtrip.ts` — all `.cbscript` references replaced; tool paths updated to `tools/rrs/`; step headers updated
- [x] `tools/rrs/validate_assets.ts` — `.cbscript` references replaced with `.rrs`; `extractRefs()` updated; header text updated
- [x] `tools/rrs/decompile.ts` — help text and output extension updated to `.rrs`

### Phase 6 — deno.json task names ✅ DONE
- [x] Renamed tasks: `compile` → `rrs:compile`, `decompile` → `rrs:decompile`, `roundtrip` → `rrs:roundtrip`
- [x] Added `rpy2rrs` task pointing to `tools/rrs/rpy2rrs.ts`
- [x] All task paths updated from `tools/cbscript/` → `tools/rrs/`
- [x] Removed obsolete `rpy2cb` task

### Phase 7 — Emit `define char.*` header in rpy2rrs.ts ✅ DONE
- [x] `Converter.convert()` now iterates `this.charMap` and emits `define char.<abbr> = "Name";` before the first label block
- [x] Blank line inserted after the define block if `charMap` is non-empty
- [x] Residual `MINIGAME_STUB_EXIT` reference in `convert()` fixed → now correctly references `STUB_EXIT_MAP`
- [x] Early-return path in `loadAssetMaps()` (when script file is unreadable) now includes `charMap` in returned object

### Phase 8 — Migration CLI tool ✅ DONE
- [x] `src/converter.ts` — browser-compatible conversion module (pure TypeScript, no Deno APIs)
  - `parseAssetMaps(text)` — parses script.rpy content to extract audio/bg/cg/sx/char maps
  - `convertRpyText(text, name, maps)` — converts a single .rpy file's text to .rrs
  - `convertBatch(inputs, scriptText?, opts?)` — batch conversion returning files + manifest
  - `buildManifest(files, opts?)` — generates manifest.json object
  - `emptyAssetMaps()` — returns zero-populated maps for quick conversions
- [x] `src/components/ConvertScreen.tsx` — React UI component for in-browser conversion
  - Drag-and-drop or click to select .rpy files
  - Optional script.rpy upload for full asset/character map extraction
  - Game name + start label options
  - Progress bar during conversion
  - Per-file download buttons + "Download All" button
  - CLI instructions panel for power users who prefer the command-line tool
- [x] `src/components/TitleScreen.tsx` — "🔄 转换 .rpy 文件" button added to open ConvertScreen overlay

### Phase 9 — Documentation ✅ DONE
- [x] `tools/rrs/README.md` — fully rewritten: all `.cbscript` / `cbscript` references replaced with `.rrs` / `rrs`; `validate_assets.ts` added to file index; `define` syntax section added; task names updated; manifest format documented; converter workflow updated
- [x] `README.md` (root) — fully rewritten: project renamed to "Ren'Py Reader", all `.cbscript` references replaced, CB-specific game-variables table removed, `.rrs` syntax example added, task reference table updated

---

## Remaining Work

### 1. Delete obsolete `src/cbscript/` and `tools/cbscript/` directories ✅ DONE
- Both directories have been deleted.

### 2. `ConvertScreen` — Tauri integration (optional enhancement)
- Currently uses browser File API for input and browser download for output.
- Could be enhanced to use Tauri FS API for folder-level batch conversion without the per-file select/download flow.

---

## Completed (Session 3 cleanup)
- [x] `src/rrs/codegen.ts` + `tools/rrs/codegen.ts` — all `[cbscript]` warning prefixes → `[rrs]`
- [x] `tools/rrs/rpy2rrs.ts` line ~1809 — stray `.cbscript` in output path fallback → `.rrs`
- [x] `src/tauri_bridge.ts` — `pickDirectory()` title "选择 Camp Buddy assets 文件夹" → "选择游戏 assets 文件夹"
- [x] `tools/rrs/validate_assets.ts` — section comment + inline comment updated from `cbscript` → `.rrs`
- [x] Root `README.md` — fully rewritten, all CB-specific content removed

### Phase 10 — Remove remaining Camp Buddy references from UI / config ✅ DONE
- [x] `src/cbscript/` and `tools/cbscript/` — deleted (old directories no longer needed)
- [x] `src/components/AssetsDirScreen.tsx` — updated JSDoc ("Camp Buddy assets" → "the game's assets"), body text (removed "Camp Buddy 的图片…约 5.3 GB"), `.cbscript` → `.rrs` in folder layout description
- [x] `src/components/TitleScreen.tsx` — logo alt text and fallback `<h1>` now use `gameTitle ?? "Ren'Py Reader"` from store
- [x] `src/components/SaveLoadedScreen.tsx` — same dynamic game title pattern
- [x] `src/components/Settings.tsx` — "Camp Buddy Web 引擎" → "Ren'Py Reader — 基于 Deno + React 构建"
- [x] `src/save.ts` — "Camp Buddy 存档" → "游戏存档" in FSA/Tauri file pickers; filename prefix `cb_save_` → `rr_save_`; `exportSave()` filename updated to `rr_save_`
- [x] `src/store.ts` — added `gameTitle: string | undefined` to `StoreState`; populated from `getManifestGame()` after `loadAll()` succeeds (in both `init` and `setAssetsDir` paths); preserved across `goToTitle()` resets
- [x] `src/evaluate.ts` — replaced CB-specific `score_hiro` variable reference example in JSDoc with generic `my_var`
- [x] `src/textParser.tsx` — updated header comment from "used in Camp Buddy" → "commonly used in Ren'Py games"; reformatted file to use double-quotes (consistent style)
- [x] `tools/rrs/rpy2rrs.ts` — replaced three remaining "cbscript" references in comments with ".rrs"
- [x] `package.json` — `"name": "camp-buddy-vn"` → `"name": "renpy-reader"`
- [x] `src-tauri/tauri.conf.json` — `productName` "Camp Buddy" → "Ren'Py Reader"; window `title` updated; `identifier` "com.campbuddy.app" → "com.renpyreader.app"
- [x] `src-tauri/capabilities/default.json` — description updated from "Camp Buddy default capabilities" → "Ren'Py Reader default capabilities"
- [x] `src-tauri/Cargo.toml` — package `name` "camp-buddy" → "renpy-reader"; lib `name` "camp_buddy_lib" → "renpy_reader_lib"
- [x] `src-tauri/src/lib.rs` — header comment and `.expect()` message updated from "Camp Buddy" → "Ren'Py Reader"
- [x] `src-tauri/src/main.rs` — header comment updated; `camp_buddy_lib::run()` → `renpy_reader_lib::run()`

---

## Progress Log

### Session 4 — Final cleanup
- Deleted `src/cbscript/` and `tools/cbscript/` (the last two legacy directories).
- Updated `AssetsDirScreen.tsx`: removed CB-specific description text and updated `.cbscript` → `.rrs` in the folder layout hint.
- Added `gameTitle: string | undefined` to Zustand store; populated from `getManifestGame()` after manifest load; preserved across `goToTitle()` resets.
- Updated `TitleScreen.tsx` and `SaveLoadedScreen.tsx` to display the dynamic `gameTitle` (falling back to `"Ren'Py Reader"`) in the logo alt text and fallback heading.
- Updated `Settings.tsx` about text: "Camp Buddy Web 引擎" → "Ren'Py Reader".
- Updated `save.ts`: file picker descriptions → "游戏存档"; all filename prefixes `cb_save_` → `rr_save_`.
- Fixed `evaluate.ts` JSDoc example: `score_hiro` → generic `my_var`.
- Updated `textParser.tsx` comment (removed CB reference) and reformatted to double-quote style.
- Fixed remaining `cbscript` comment references in `tools/rrs/rpy2rrs.ts`.
- Renamed all Tauri/Cargo project identifiers: `package.json` name, `tauri.conf.json` productName/title/identifier, `capabilities/default.json` description, `Cargo.toml` package+lib names, `lib.rs` and `main.rs` comments and lib call.

### 2026-02-25 (Session 3 — wrap-up)
- Updated root `README.md`: full rewrite removing all CB-specific content, updated directory tree, task table, architecture diagram, and save-system table.
- Marked Phase 9 fully complete.
- Identified four small residual issues for next session (items 3–6 in Remaining Work above).

### 2026-02-25 (Session 2)
- Fixed `Converter.convert()` in `tools/rrs/rpy2rrs.ts`:
  - Now emits `define char.<abbr> = "Name";` header lines from `this.charMap` before the first label block.
  - Fixed residual `MINIGAME_STUB_EXIT` reference → `STUB_EXIT_MAP`.
  - Fixed early-return in `loadAssetMaps()` to include `charMap` in the returned object.
- Updated `tools/rrs/cli.ts`: renamed all `.cbscript` → `.rrs` (file filter, output path, help text, task names).
- Updated `tools/rrs/batch_roundtrip.ts`: renamed all `.cbscript` → `.rrs`; updated subprocess CLI paths to `tools/rrs/`.
- Updated `tools/rrs/validate_assets.ts`: renamed `.cbscript` → `.rrs` in file filter and output messages.
- Updated `tools/rrs/decompile.ts`: renamed `.cbscript` → `.rrs` in help text and output path derivation.
- Updated `deno.json`: renamed tasks (`compile`→`rrs:compile`, `decompile`→`rrs:decompile`, `roundtrip`→`rrs:roundtrip`, `rpy2cb`→`rpy2rrs`); updated all paths to `tools/rrs/`.
- Rewrote `tools/rrs/README.md`: full rewrite with updated language name, task names, `define` syntax docs, manifest format, and file index.
- Created `src/converter.ts`: browser-compatible Ren'Py→.rrs conversion module (no Deno dependencies).
- Created `src/components/ConvertScreen.tsx`: React UI overlay for in-browser `.rpy` → `.rrs` conversion with drag-and-drop, options, progress, and per-file downloads.
- Updated `src/components/TitleScreen.tsx`: added "🔄 转换 .rpy 文件" button that opens `ConvertScreen`.

### 2026-02-24 (Session 1)
- Created `src/rrs/` and `tools/rrs/` by copying from `src/cbscript/` and `tools/cbscript/`.
- Added `DefineDecl` to `tools/rrs/types.ts` and `src/rrs/ast.ts`.
- Updated both parsers to recognise top-level `define` and call `parseDefine()`.
- Updated both codegens: `buildDefineMaps()`, `CodegenContext` constructor takes charMap/audioMap, `genSpeak()` resolves abbreviations, `resolveAudioAlias()` added.
- Overhauled `rpy2rrs.ts`: removed `CHAR_MAP`, `DEFAULT_SCRIPT_RPY`, `MINIGAME_STUB_EXIT`; auto-detect `Character()` definitions; `script.rpy` no longer skipped; new CLI options.
- Updated `src/engine.ts`: `startNewGame()` reads `getManifestStart()`.
- Updated `src/evaluate.ts`: `defaultVars()` returns `{}`.
- Updated `src/components/DialogueBox.tsx`: `CHARACTER_COLORS` cleared to `{}`.
- Updated `src/loader.ts`: uses `./rrs/index`, exports `getManifestStart()` / `getManifestGame()`.
- Updated `src/types.ts`: `Manifest` has `start?` and `game?`.

---

## Notes

- The original `src/cbscript/` and `tools/cbscript/` directories have been **deleted**.
- The runtime parser (`src/rrs/`) and the tools parser (`tools/rrs/`) are kept **in sync** but are separate files (different import paths: `./lexer` vs `./lexer.ts`).
- `define` declarations are **top-level only**. The parser enforces this.
- `define char.<abbr>` values feed into `genSpeak()` at codegen time — the `who` field in JSON always contains the **full character name**.
- `define audio.<alias>` values are expanded at codegen time in music/sound/voice path resolution.
- The manifest `start` field defaults to `"start"` (Ren'Py convention). Engine falls back to `"start"` if field is absent.
- The old `src/cbscript/` is still imported by nothing (loader.ts now points to `src/rrs/`), so it is safe to delete.