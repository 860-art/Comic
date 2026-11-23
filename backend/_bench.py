# -*- coding: utf-8 -*-
"""翻译速度基准：『串行逐页』vs『组内并发 OCR + 合并一次翻译』对比。

用法：
  本地模拟（不需要 Key，验证调度策略收益与拆分正确性）：
    python _bench.py
  服务器实测（用服务器 Key + 3 张真实 R2 图片 URL）：
    python _bench.py --real <url1> <url2> <url3>
    （在 /root/Comic/backend 下，用 .venv/bin/python 跑）
"""
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor

# Windows GBK 控制台兼容：stdout 切 UTF-8，避免中文/符号打印崩溃
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ocr_translate as ot  # noqa: E402

REAL = "--real" in sys.argv
URLS = [a for a in sys.argv[1:] if a.startswith("http")]

# ===== 模拟参数（基于此前服务器日志的典型观测值，real 模式下不生效） =====
MOCK_OCR_SEC = 2.5     # PaddleOCR 单页 CPU 推理耗时（典型 2~4s）
MOCK_LLM_BASE = 3.5    # 单次 LLM 调用基础耗时（5 条文本一批典型 3~6s）
MOCK_LLM_PER = 0.05    # 每多一条文本的额外耗时

MOCK_ITEMS = [
    {"box": [[0, 0], [1, 0], [1, 1], [0, 1]], "text": f"第{i}句台词内容。"}
    for i in range(10)
]


def _install_mocks() -> None:
    """注入模拟 OCR / LLM：只保留真实的调度与拆分逻辑。"""
    import json

    ot._cache_get = lambda k: None  # 模拟环境无缓存
    ot._cache_put = lambda *a, **k: None

    def fake_ocr_page(task_url, task_lang):
        time.sleep(MOCK_OCR_SEC)
        return {
            "cache_key": task_url,
            "img": None,
            "items": [dict(it) for it in MOCK_ITEMS],
            "img_w": 800,
            "img_h": 1200,
            "cached_json": None,
        }

    def fake_llm_translate(texts, user_api_key=""):
        time.sleep(MOCK_LLM_BASE + MOCK_LLM_PER * len(texts))
        return [f"译:{t}" for t in texts]

    ot._ocr_page = fake_ocr_page
    ot._llm_translate = fake_llm_translate


def plan_serial(urls):
    """方案 A（现状）：一张一张串行，每页 OCR 后小批量串行翻译。返回 (耗时, 译文)。"""
    t0 = time.perf_counter()
    out = []
    for u in urls:
        page = ot._ocr_page(u, "en")
        texts = [it["text"] for it in page["items"]]
        out.append(ot._llm_translate_serial(texts, user_api_key=""))
    return time.perf_counter() - t0, out


def plan_batch(urls):
    """方案 B（重构）：组内并发 OCR(2) → 全部文本合并一次 LLM → 按页拆分。"""
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as pool:
        pages = list(pool.map(lambda u: ot._ocr_page(u, "en"), urls))
    ocr_done = time.perf_counter() - t0

    merged, offsets = [], {}
    for p in pages:
        offsets[id(p)] = (len(merged), len(merged) + len(p["items"]))
        merged.extend(it["text"] for it in p["items"])

    translated = ot._llm_translate(merged, user_api_key="")
    if translated is None or len(translated) != len(merged):
        raise RuntimeError("合并翻译失败（真实链路会降级逐页）")

    # 拆分正确性：每页条数、边界、中文校验
    per_page = []
    for p in pages:
        lo, hi = offsets[id(p)]
        chunk = translated[lo:hi]
        assert len(chunk) == len(p["items"]), "拆分长度不符"
        assert ot._result_all_chinese([{"translated": t} for t in chunk]), "校验未过"
        per_page.append(chunk)
    total = time.perf_counter() - t0
    return total, ocr_done, merged, per_page


def main():
    print(f"===== 模式：{'真实 API' if REAL else '本地模拟'} =====")
    if REAL:
        if len(URLS) < 2:
            print("用法：python _bench.py --real <url1> <url2> [url3]")
            return 1
        # 基准专用：放宽 OCR 并发到 2、禁用缓存（否则缓存命中测不到翻译）
        ot._ocr_semaphore = threading.BoundedSemaphore(2)
        ot._cache_get = lambda k: None
    else:
        _install_mocks()
        URLS[:] = ["mock-page-1", "mock-page-2", "mock-page-3"]

    print(f"图片数：{len(URLS)}，每页气泡数：{10 if not REAL else '（真实识别）'}\n")

    tA, outA = plan_serial(URLS)
    print(f"[方案A 串行逐页（现状）] 总耗时 {tA:.1f}s")

    tB, ocrB, merged, perB = plan_batch(URLS)
    print(
        f"[方案B 并发OCR+合并翻译] OCR 阶段 {ocrB:.1f}s，总耗时 {tB:.1f}s"
        f"（合并 {len(merged)} 条文本，1 次 LLM 调用）"
    )
    print(f"\n提速：{tA / tB:.1f}x（{tA:.1f}s → {tB:.1f}s）")
    print("拆分正确性：每页条数/边界/中文校验 全部断言通过 [OK]")

    if REAL:
        print("\n----- 译文质量比对（请人工检查两方案结果是否一致） -----")
        for i, u in enumerate(URLS):
            print(f"\n== 第 {i + 1} 页 {u[:60]}…")
            print("  A 串行:", " | ".join((outA[i] or ["<失败>"])[:5]))
            print("  B 合并:", " | ".join(perB[i][:5]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
