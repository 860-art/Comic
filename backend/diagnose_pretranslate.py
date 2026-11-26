# -*- coding: utf-8 -*-
"""预热诊断脚本（排查「上传后没有自动翻译」用，跑完可删）：

    python diagnose_pretranslate.py

输出最近 5 本漫画的 need_translation、章节页数、翻译任务状态分布、
预热积压数量与失败原因摘要 —— 一眼定位预热是「没入队」「在积压」还是「失败了」。
"""
import json
import sys
from collections import Counter

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from main import Comic, TranslationTask, SessionLocal

db = SessionLocal()
try:
    comics = db.query(Comic).order_by(Comic.id.desc()).limit(5).all()
    if not comics:
        print("没有漫画记录")
    for c in comics:
        pages = sum(len(json.loads(ch.images or "[]")) for ch in c.chapters)
        tasks = (
            db.query(TranslationTask)
            .filter(TranslationTask.comic_id == c.id)
            .all()
        )
        dist = Counter(t.status for t in tasks)
        backlog = sum(
            1 for t in tasks if t.status == "queued" and t.user_id == 0
        )
        print(f"\n=== 漫画 #{c.id}《{c.title}》need_translation={c.need_translation} ===")
        print(f"  章节数 {len(c.chapters)}，总页数 {pages}")
        print(
            f"  翻译任务 {len(tasks)} 个：{dict(dist) or '无任务记录（预热没入队！）'}"
        )
        print(f"  其中预热积压（user_id=0 且 queued）: {backlog}")
        for t in tasks:
            if t.status == "failed":
                err = str(getattr(t, "error", "") or "")[:110]
                print(f"  failed 示例 task#{t.id} page={t.page_id}: {err}")
                break
finally:
    db.close()
