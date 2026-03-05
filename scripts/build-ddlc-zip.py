#!/usr/bin/env python3
"""build-ddlc-zip.py — DDLC game/ → assets.zip (rrs + 全部资源)"""
import sys, os, subprocess, tempfile, shutil, zipfile, json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
UNRPYC = PROJECT_DIR / "rpy-rrs-bridge" / "unrpyc" / "unrpyc.py"
BUN = Path(os.environ.get("BUN", shutil.which("bun") or str(Path.home() / ".bun/bin/bun")))
SKIP_EXTS = {".rpyc", ".rpa", ".rpy"}
SKIP_NAMES = {"firstrun"}

def log(msg): print(f"  {msg}", flush=True)

def decompile_all(game_dir, out_dir):
    rpyc_files = list(game_dir.glob("**/*.rpyc"))
    if not rpyc_files:
        return []
    log(f"找到 {len(rpyc_files)} 个 .rpyc，开始反编译...")
    copied = []
    for rpyc in rpyc_files:
        dst = out_dir / rpyc.relative_to(game_dir)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(rpyc, dst)
        copied.append(dst)
    subprocess.run(
        [sys.executable, str(UNRPYC), "--try-harder", *[str(f) for f in copied]],
        capture_output=True, text=True
    )
    result = []
    for f in copied:
        rpy = f.with_suffix(".rpy")
        if rpy.exists():
            result.append(rpy)
    for orig in game_dir.glob("**/*.rpy"):
        result.append(orig)
    log(f"反编译完成，{len(result)} 个 .rpy 可用")
    return result

def convert_rpy(rpy_path):
    script = PROJECT_DIR / "scripts" / "rpy2rrs.ts"
    r = subprocess.run([str(BUN), str(script), str(rpy_path)],
                       capture_output=True, text=True, timeout=30)
    return r.stdout if r.returncode == 0 and r.stdout.strip() else None

def main():
    if len(sys.argv) < 3:
        print(f"Usage: python3 {sys.argv[0]} <game_dir> <output.zip>"); sys.exit(1)

    game_dir = Path(sys.argv[1]).resolve()
    output_zip = Path(sys.argv[2]).resolve()
    print(f"Game dir : {game_dir}\nOutput   : {output_zip}\n")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # Step 1: 反编译
        print("Step 1: 反编译 .rpyc → .rpy")
        rpy_files = decompile_all(game_dir, tmp / "dec")
        rpy_by_stem = {}
        for p in rpy_files:
            key = p.stem.lower()
            if key not in rpy_by_stem or str(p).startswith(str(game_dir)):
                rpy_by_stem[key] = p

        # Step 2: rpy → rrs
        print(f"\nStep 2: 转换 {len(rpy_by_stem)} 个 .rpy → .rrs")
        rrs_entries = {}
        ok = fail = 0
        for stem, rpy_path in sorted(rpy_by_stem.items()):
            rrs = convert_rpy(rpy_path)
            name = stem + ".rrs"
            if rrs and rrs.strip():
                rrs_entries[name] = rrs; ok += 1
                log(f"✓ {name}")
            else:
                fail += 1; log(f"✗ {name}")
        print(f"转换: {ok} 成功, {fail} 失败")

        # Step 3: 收集资源文件
        print("\nStep 3: 收集资源文件")
        asset_files = []
        for f in sorted(game_dir.rglob("*")):
            if not f.is_file(): continue
            if f.suffix.lower() in SKIP_EXTS: continue
            if f.name in SKIP_NAMES: continue
            asset_files.append((f, str(f.relative_to(game_dir))))
        total_mb = sum(f.stat().st_size for f, _ in asset_files) / 1024 / 1024
        log(f"{len(asset_files)} 个文件，{total_mb:.1f} MB")

        # Step 4: manifest
        print("\nStep 4: 生成 manifest.json")
        manifest = {"files": sorted(rrs_entries.keys()), "start": "start",
                    "game": "Doki Doki Literature Club"}

        # Step 5: 打包
        print(f"\nStep 5: 打包 zip ({len(rrs_entries)} rrs + {len(asset_files)} 资源)...")
        output_zip.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr("data/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for name, content in rrs_entries.items():
                zf.writestr(f"data/{name}", content)
            for i, (src, zip_path) in enumerate(asset_files):
                print(f"  [{i+1}/{len(asset_files)}] {zip_path}", flush=True)
                zf.write(src, zip_path)

        size_mb = output_zip.stat().st_size / 1024 / 1024
        print(f"\n✅ {output_zip}")
        print(f"   {size_mb:.1f} MB，{len(rrs_entries)} rrs + {len(asset_files)} 资源")

if __name__ == "__main__":
    main()
