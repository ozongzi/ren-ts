#!/usr/bin/env python3
"""
rpyc-decompile.py — 封装 unrpyc，将 .rpyc 反编译为 .rpy 文本输出到 stdout

用法：
    python3 rpy-rrs-bridge/rpyc-decompile.py <file.rpyc>

成功时：将 .rpy 内容输出到 stdout，退出码 0
失败时：错误信息输出到 stderr，退出码 1
"""

import sys
import os
import tempfile
import shutil
from pathlib import Path

# 把 unrpyc 目录加入 path
SCRIPT_DIR = Path(__file__).parent
UNRPYC_DIR = SCRIPT_DIR / "unrpyc"
sys.path.insert(0, str(UNRPYC_DIR))

try:
    import unrpyc
    from unrpyc import decompile_rpyc, Context
except ImportError as e:
    print(f"Error: cannot import unrpyc: {e}", file=sys.stderr)
    print(f"Make sure unrpyc is in {UNRPYC_DIR}", file=sys.stderr)
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 rpyc-decompile.py <file.rpyc>", file=sys.stderr)
        sys.exit(1)

    input_path = Path(sys.argv[1]).resolve()
    if not input_path.exists():
        print(f"Error: file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # 在临时目录里操作，避免污染原目录
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_rpyc = Path(tmpdir) / input_path.name
        shutil.copy2(input_path, tmp_rpyc)

        ctx = Context()
        decompile_rpyc(
            tmp_rpyc,
            ctx,
            overwrite=True,
            try_harder=False,
        )

        if ctx.state != 'ok':
            print(f"Error: decompilation failed: {ctx.log_contents}", file=sys.stderr)
            sys.exit(1)

        # 输出结果
        out_path = tmp_rpyc.with_suffix('.rpy')
        if not out_path.exists():
            print(f"Error: output file not found: {out_path}", file=sys.stderr)
            sys.exit(1)

        sys.stdout.write(out_path.read_text(encoding='utf-8'))

if __name__ == '__main__':
    main()
