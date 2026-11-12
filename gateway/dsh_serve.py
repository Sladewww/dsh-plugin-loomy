"""DSH 插件专用启动入口。

上游 ``python -m loomy2api serve`` 会把 ``config.json`` / ``accounts.json``
解析到包的上级目录（PROJECT_ROOT），也就是插件包内部。插件包可能只读或
在升级时被整体替换，因此这里显式指定一份位于用户数据目录的 config.json，
把所有可变状态都挪到包外。

用法::

    python dsh_serve.py <config.json 绝对路径>

只依赖标准库，逻辑与上游 CLI 的 serve 分支一致。
"""

from __future__ import annotations

import sys
from pathlib import Path

# 让 ``import loomy2api`` 找到同目录的包，无论 cwd 是什么。
sys.path.insert(0, str(Path(__file__).resolve().parent))

from loomy2api.config import load_config  # noqa: E402
from loomy2api.server import serve  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: dsh_serve.py <absolute path to config.json>", file=sys.stderr)
        return 2
    config_path = Path(argv[1])
    if not config_path.is_absolute():
        print("config path must be absolute", file=sys.stderr)
        return 2
    cfg = load_config(config_path)
    # serve() 内部会调用 Gateway.start()（含账号池 bootstrap、后台续期、
    # 模型目录刷新），这里不要重复 start。
    serve(cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
