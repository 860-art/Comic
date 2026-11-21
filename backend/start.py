"""Railway / 本地通用启动入口。

Railway 通过环境变量 PORT 注入监听端口；Procfile 里的 $PORT 在部分构建器下
不会被 shell 展开（会把字面量 '$PORT' 传给 uvicorn 报错），因此在 Python 里
直接读取环境变量，彻底避开 shell 变量展开问题。
"""
import os

import uvicorn

if __name__ == "__main__":
    port = int(os.getenv("PORT") or "8080")
    print(f"[start] 启动 uvicorn: 0.0.0.0:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port)
