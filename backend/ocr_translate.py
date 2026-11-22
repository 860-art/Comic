"""OCR 漫画翻译服务（真实接口）。

流程：图片 → PaddleOCR Mobile 识别文字与坐标框 → OpenCV 取气泡边缘平均背景色 →
调用智谱 GLM / DeepSeek 翻译成中文（未配置 API Key 时返回伪翻译 "[译] 原文"）。
主引擎识别结果为空或置信度偏低时，自动降级到百度 OCR 备用引擎。

环境变量：
- ZHIPU_API_KEY           智谱开放平台 Key（免费模型 glm-4-flash）
- DEEPSEEK_API_KEY        DeepSeek Key（deepseek-chat）
- BAIDU_OCR_API_KEY       百度智能云 OCR 应用 API Key（备用引擎；不配 = 备用禁用）
- BAIDU_OCR_SECRET_KEY    百度智能云 OCR Secret Key（日志永不输出完整值）
- OCR_MAX_CONCURRENCY     OCR 推理并发上限（默认 1；2核4G 建议 1，防内存溢出）
- BAIDU_TRIGGER_CONFIDENCE 主引擎平均置信度低于该值触发备用引擎（默认 0.65）
- OCR_WARMUP              启动时预热 OCR 模型（默认 1；设 0 关闭）
两者都没配置 → 伪翻译，方便先联调前端。
"""

import base64
import hashlib
import json
import os
import threading
import time
from typing import Optional

import cv2
import numpy as np
import re
import requests
from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

# 支持的 OCR 语言（PaddleOCR 的 lang 参数值）
SUPPORTED_LANGS = {"ch": "ch", "en": "en", "korean": "korean", "ko": "korean", "japan": "japan"}

# ===== 服务器资源保护：OCR 推理并发限制 =====
# PaddleOCR 并发推理时每个请求内存峰值叠加，2核4G 上容易 OOM。
# 信号量把推理串行化：超出的请求排队等待（最多等 90 秒后返回 503）。
OCR_MAX_CONCURRENCY = max(1, int(os.getenv("OCR_MAX_CONCURRENCY", "1") or "1"))
_ocr_semaphore = threading.BoundedSemaphore(OCR_MAX_CONCURRENCY)
_OCR_QUEUE_TIMEOUT = 90  # 排队等待上限（秒）

# ===== 大尺寸文本框过滤阈值（可按需微调） =====
# 韩漫/日漫里巨大的拟声词（如 악、ドン）会被 OCR 识别成一个超大框，
# 覆盖大半个画面，翻译框会严重遮挡画面 → 按占图比例直接跳过。
# 阈值放宽到 60%/40%：只有真正铺满画面的巨型拟声词才被过滤，长句旁白/对话全部放行。
MAX_BOX_WIDTH_RATIO = 0.60   # 文字框宽度超过图片总宽度的 60% → 跳过
MAX_BOX_HEIGHT_RATIO = 0.40  # 文字框高度超过图片总高度的 40% → 跳过
MIN_MEANINGFUL_CHARS = 2     # 有效字符（去掉标点/空白后的字母数字）少于 2 个 → 跳过（单字符拟声词/标点）

# ===== OCR 懒加载单例（按语言缓存；启动预热 + 首次调用兜底） =====
# PaddleOCR 3.x 默认加载 PP-OCRv5 **Server** 模型（det ~85MB / rec ~90MB），
# 2核4G 服务器内存吃紧且推理慢 → 中/英/日显式切换 Mobile 轻量模型（det ~5MB / rec ~16MB）。
# 返回结构与 Server 版完全一致（rec_texts 等 dict），下游解析零改动。
_MOBILE_DET = "PP-OCRv5_mobile_det"
_MOBILE_REC = "PP-OCRv5_mobile_rec"          # 通用字典：中/英/日文假名
_KOREAN_MOBILE_REC = "korean_PP-OCRv5_mobile_rec"  # 韩文专用轻量模型（通用字典不含韩文）

_ocr_instances: dict[str, object] = {}
_ocr_lock = threading.Lock()


def _get_ocr(lang: str):
    """获取（或初始化）PaddleOCR 实例（Mobile 轻量模型）。模型下载失败会抛异常，由接口转成 503。

    模型选择策略（paddleocr 3.7.0 实测）：
    - 检测模型与语言无关（只找文字位置）→ 全语言统一用 PP-OCRv5_mobile_det
    - 中/英/日 → 识别用 PP-OCRv5_mobile_rec（字典含中文、英文、日文假名）
    - 韩文 → 必须用 korean_PP-OCRv5_mobile_rec（通用 v5 字典不含韩文字符）
    - 关键坑：只要显式指定了任意模型名，PaddleOCR 3.x 就会忽略 lang 参数
      （警告 "'lang' and 'ocr_version' will be ignored when model names are specified"）。
      因此韩文不能"只指定 det 让 lang 生效"——实测那样会回退到 PP-OCRv6_medium_rec
      中英文大模型，韩文识别直接失效且更占内存。两个模型名都要显式指定。
    - 显式指定失败时回退默认配置（绝不因模型选择问题破坏原有识别功能）
    """
    with _ocr_lock:
        if lang not in _ocr_instances:
            from paddleocr import PaddleOCR  # 延迟导入：未安装 paddle 时其它接口不受影响

            # enable_mkldnn=False：paddle 3.3.1 的 onednn 执行器存在
            # ConvertPirAttribute2RuntimeAttribute 兼容 bug，CPU 推理必须走纯 CPU 算子
            base_kwargs = dict(
                lang=lang,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,
            )
            try:
                if lang == "korean":
                    # 韩文：两个模型名都显式指定（lang 此时会被忽略，不能依赖它选 rec）
                    _ocr_instances[lang] = PaddleOCR(
                        text_detection_model_name=_MOBILE_DET,
                        text_recognition_model_name=_KOREAN_MOBILE_REC,
                        **base_kwargs,
                    )
                else:
                    _ocr_instances[lang] = PaddleOCR(
                        text_detection_model_name=_MOBILE_DET,
                        text_recognition_model_name=_MOBILE_REC,
                        **base_kwargs,
                    )
            except Exception as exc:
                # 兜底：显式 Mobile 模型在当前环境不可用时回退默认（保证功能不中断）
                print(f"[ocr] Mobile 模型初始化失败，回退默认模型: {type(exc).__name__}: {exc}")
                _ocr_instances[lang] = PaddleOCR(**base_kwargs)
        return _ocr_instances[lang]


def warmup_ocr(lang: str = "en") -> None:
    """启动时预热 OCR 模型（后台线程调用，失败不影响服务启动）。

    加载一次模型常驻内存，避免首个用户请求承担 5~30 秒的模型加载/下载等待。
    """
    try:
        started = time.time()
        _get_ocr(lang)
        print(f"[warmup] PaddleOCR({lang}) Mobile 模型预热完成（{time.time() - started:.1f}s）")
    except Exception as exc:
        print(f"[warmup] OCR 预热失败（不影响启动，首次请求时会重试）: {type(exc).__name__}: {exc}")


# ===== 图片加载：支持 multipart 文件 / data:base64 / http(s) URL / 本地路径 =====


def _fetch_image_bytes(image_url: str) -> bytes:
    if image_url.startswith("data:"):
        # data:image/webp;base64,xxxx
        payload = image_url.split(",", 1)[1] if "," in image_url else ""
        return base64.b64decode(payload)
    if image_url.startswith(("http://", "https://")):
        resp = requests.get(image_url, timeout=30)
        if resp.status_code != 200:
            raise HTTPException(status_code=400, detail=f"图片下载失败：HTTP {resp.status_code}")
        return resp.content
    # 本地相对路径（后端静态图片等场景）
    if os.path.exists(image_url):
        with open(image_url, "rb") as f:
            return f.read()
    raise HTTPException(status_code=400, detail="image_url 不是有效的 data:URL / http(s) 链接 / 本地路径")


def _decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="无法解码图片，请确认是 png/jpg/webp 等常见格式")
    return img


# ===== OCR 结果解析：兼容 PaddleOCR 3.x（dict）与 2.x（嵌套 list） =====


def _poly_to_xywh(poly) -> Optional[list[int]]:
    try:
        pts = [(float(p[0]), float(p[1])) for p in poly]
    except Exception:
        return None
    if len(pts) < 4:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x, y = int(min(xs)), int(min(ys))
    return [x, y, int(max(xs)) - x, int(max(ys)) - y]


def _result_field(result: dict, key: str) -> list:
    """从 OCRResult（dict 子类，值可能是 numpy 数组）安全取字段为 list。"""
    value = result.get(key, None)
    if value is None:
        return []
    if isinstance(value, np.ndarray):
        return value.tolist()
    return list(value)


def _parse_ocr_result(raw) -> list[dict]:
    """解析 OCR 原始结果 → [{box, text, conf}]。conf（置信度 0~1）用于主引擎质量判断。"""
    items: list[dict] = []
    if raw is None:
        return items
    if isinstance(raw, list) and len(raw) == 0:
        return items

    first = raw[0] if isinstance(raw, list) else raw
    if isinstance(first, dict):
        texts = _result_field(first, "rec_texts")
        polys = _result_field(first, "rec_polys")
        boxes = _result_field(first, "rec_boxes")
        scores = _result_field(first, "rec_scores")
        for i, text in enumerate(texts):
            xywh = None
            if i < len(polys) and polys[i] is not None:
                xywh = _poly_to_xywh(polys[i])
            if xywh is None and i < len(boxes) and len(boxes[i]) >= 4:
                b = [int(v) for v in boxes[i]]
                xywh = [b[0], b[1], b[2] - b[0], b[3] - b[1]]
            if xywh is None:
                continue
            conf = None
            if i < len(scores):
                try:
                    conf = float(scores[i])
                except (TypeError, ValueError):
                    conf = None
            items.append({"box": xywh, "text": str(text), "conf": conf})
        return items

    # 2.x：[[poly, (text, conf)], ...]
    for entry in raw:
        try:
            poly, pair = entry[0], entry[1]
            text = pair[0]
            conf = None
            try:
                conf = float(pair[1])
            except (TypeError, ValueError, IndexError):
                conf = None
            xywh = _poly_to_xywh(poly)
            if xywh is not None:
                items.append({"box": xywh, "text": str(text), "conf": conf})
        except Exception:
            continue
    return items


# ===== 大尺寸/无效文本框过滤 =====

# 非字母数字（含标点、空白、符号）→ 用于计算“有效字符数”；Unicode 模式下韩文/日文假名算字母
_PUNCT_RE = re.compile(r"[\W_]+", re.UNICODE)


def _filter_items(items: list[dict], img: np.ndarray) -> list[dict]:
    """过滤超大拟声词框与无效短文本框，返回保留的条目。

    - box 宽度 > 图片宽度 × MAX_BOX_WIDTH_RATIO，或高度 > 图片高度 × MAX_BOX_HEIGHT_RATIO → 跳过
    - 有效字符数（去标点/空白）< MIN_MEANINGFUL_CHARS → 跳过（不翻译、不取色、不返回）
    """
    img_h, img_w = img.shape[:2]
    kept: list[dict] = []
    skipped = 0
    for it in items:
        _, _, w, h = it["box"]
        if w > img_w * MAX_BOX_WIDTH_RATIO or h > img_h * MAX_BOX_HEIGHT_RATIO:
            skipped += 1
            print(
                f"[translate]   跳过大框: {it['text']!r} box={it['box']} "
                f"(占图宽 {w / img_w:.0%} / 占图高 {h / img_h:.0%})"
            )
            continue
        if len(_PUNCT_RE.sub("", it["text"])) < MIN_MEANINGFUL_CHARS:
            skipped += 1
            print(f"[translate]   跳过无效短文本: {it['text']!r} box={it['box']}")
            continue
        kept.append(it)
    if skipped:
        print(
            f"[translate] 大尺寸/无效文本框过滤：跳过 {skipped} 个，保留 {len(kept)} 个（图片 {img_w}x{img_h}）"
        )
    return kept


# ===== 气泡背景色：在文字框外扩一圈取边缘像素的中位数（比中心取样更稳） =====


def _bubble_bg_color(img: np.ndarray, box: list[int]) -> str:
    x, y, w, h = box
    img_h, img_w = img.shape[:2]
    pad = max(3, int(min(w, h) * 0.2))
    x1, y1 = max(0, x - pad), max(0, y - pad)
    x2, y2 = min(img_w, x + w + pad), min(img_h, y + h + pad)
    if x2 <= x1 or y2 <= y1:
        return "#ffffff"
    region = img[y1:y2, x1:x2]
    # 外扩矩形的最外 3px 边缘环（通常是气泡/背景本身，而不是文字）
    edge = np.concatenate(
        [
            region[:3].reshape(-1, 3),
            region[-3:].reshape(-1, 3),
            region[:, :3].reshape(-1, 3),
            region[:, -3:].reshape(-1, 3),
        ]
    )
    if edge.size == 0:
        edge = region.reshape(-1, 3)
    med = np.median(edge, axis=0).astype(int)  # BGR
    return "#{:02x}{:02x}{:02x}".format(int(med[2]), int(med[1]), int(med[0]))


# ===== 同气泡行合并：把同一气泡里上下贴近的多行小框合并成一个大气泡框 =====
# 判定条件（满足全部才算同一气泡）：
#   1. X 轴相近：两框中心点水平距离 < 较宽框宽度的 50%
#      （居中对齐的短行与左对齐的长行都能并上，即使 X 重叠很少）
MERGE_X_CENTER_TOLERANCE = 0.5
#   2. Y 轴很近：垂直间距 < 较矮框高度的 50%（气泡内相邻行距；气泡间空隙远大于此）
MERGE_Y_GAP_RATIO = 0.5


def _group_bbox(group: list[dict]) -> list[int]:
    """一组文本框的并集外接矩形 [x, y, w, h]。"""
    xs1 = [g["box"][0] for g in group]
    ys1 = [g["box"][1] for g in group]
    xs2 = [g["box"][0] + g["box"][2] for g in group]
    ys2 = [g["box"][1] + g["box"][3] for g in group]
    x, y = min(xs1), min(ys1)
    return [x, y, max(xs2) - x, max(ys2) - y]


def _can_merge(g1: list[dict], g2: list[dict]) -> bool:
    """两组框是否属于同一气泡：X 轴中心点相近 且 Y 轴距离很近。"""
    x1, y1, w1, h1 = _group_bbox(g1)
    x2, y2, w2, h2 = _group_bbox(g2)
    # 1) X 轴中心点相近（差值 < 较宽框宽度 × MERGE_X_CENTER_TOLERANCE）
    cx1, cx2 = x1 + w1 / 2, x2 + w2 / 2
    if abs(cx1 - cx2) >= MERGE_X_CENTER_TOLERANCE * max(w1, w2):
        return False
    # 2) Y 轴距离很近（间距 < 较矮框高度 × MERGE_Y_GAP_RATIO；负数 = 已相交，直接算近）
    gap_y = max(y1, y2) - min(y1 + h1, y2 + h2)
    return gap_y < MERGE_Y_GAP_RATIO * min(h1, h2)


def _merge_bubble_lines(items: list[dict]) -> list[dict]:
    """把同一气泡的多行小框合并成大气泡框；文本按行序（y 从上到下）用空格连接。

    算法：每个框先自成一组，反复扫描两两合并（可传递：A-B 相近、B-C 相近 → 一组），
    直到没有可合并的组为止。
    """
    groups: list[Optional[list[dict]]] = [
        [it] for it in sorted(items, key=lambda it: (it["box"][1], it["box"][0]))
    ]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            if groups[i] is None:
                continue
            for j in range(i + 1, len(groups)):
                if groups[j] is None:
                    continue
                if _can_merge(groups[i], groups[j]):
                    groups[i].extend(groups[j])
                    groups[j] = None
                    merged = True
        groups = [g for g in groups if g is not None]

    result: list[dict] = []
    for group in groups:
        ordered = sorted(group, key=lambda it: (it["box"][1], it["box"][0]))
        texts = [it["text"] for it in ordered]
        result.append({
            "box": _group_bbox(ordered),
            "text": " ".join(texts),
            "lines": len(ordered),  # 调试用：这个气泡由几行合并而来
        })
    merged_count = sum(g["lines"] for g in result)
    if len(result) != merged_count:
        print(f"[translate] 气泡行合并：{merged_count} 个小框 → {len(result)} 个气泡框")
    return result


# ===== 翻译：智谱 GLM（免费 glm-4-flash）优先，其次 DeepSeek，都没有 → 伪翻译 =====

GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"

_TRANSLATE_PROMPT = (
    "你是漫画对白翻译器。把 JSON 数组里的英文（或韩文）台词翻译成自然流畅的简体中文，"
    "保留语气词和口语感。只返回一个 JSON 数组，元素顺序与输入一一对应，不要输出任何解释。"
    "严禁保留原文、外文单词或拼音，每个数组元素都必须是纯中文译文。"
)

# ===== 译文中文校验 =====
# 大模型偶尔偷懒：数组里只有一部分翻成中文，其余原样返回英文/韩文/日文；
# 或者返回伪翻译 "[译] 原文"。这些结果一旦写入缓存会永久显示，必须在入缓存前拦住。
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
# 连续 3 个以上拉丁字母（放行 OK/AI 这类 2 字母缩写）/ 任意韩文音节 / 任意日文假名
# → 判定为原文残留
_FOREIGN_RE = re.compile(r"[A-Za-z]{3,}|[\uac00-\ud7af\u3130-\u318f]|[\u3040-\u30ff]")


def _is_chinese_translation(text: str) -> bool:
    """单条译文是否为合规中文：至少含一个汉字，且不含成串外文与伪翻译标记。"""
    t = (text or "").strip()
    if not t or not _CJK_RE.search(t):
        return False
    if "[译]" in t or _FOREIGN_RE.search(t):
        return False
    return True


def _translations_all_chinese(translated: list[str]) -> bool:
    """整张图的所有译文必须全部为中文（逐条检查，空数组视为合规：图片本身无文字）。"""
    return all(_is_chinese_translation(t) for t in translated)


def _result_all_chinese(result) -> bool:
    """缓存里的完整结果（JSON 字符串或已解析列表）是否全部为中文译文。"""
    try:
        rows = json.loads(result) if isinstance(result, str) else result
        if not isinstance(rows, list):
            return False
        return all(_is_chinese_translation(str(r.get("translated", ""))) for r in rows)
    except Exception:
        return False


def _mask_key(key: str) -> str:
    """日志脱敏：只显示前 4 位和后 4 位，防止 Key 泄露到终端日志。"""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}****{key[-4:]}"


def _llm_translate_once(
    texts: list[str], user_api_key: str = "", temperature: float = 0.3
) -> Optional[list[str]]:
    """单次调用 LLM 批量翻译；失败或无法解析为等长数组返回 None。

    BYOK 优先级：前端传来的用户 Key > 服务器环境变量 ZHIPU_API_KEY > DEEPSEEK_API_KEY。
    """
    url, model = GLM_URL, "glm-4-flash"
    # 1) 用户自带 Key（BYOK）优先
    api_key = (user_api_key or "").strip()
    source = "用户 BYOK Key"
    # 2) 用户没传 → 降级服务器环境变量
    if not api_key:
        api_key = os.getenv("ZHIPU_API_KEY", "").strip()
        source = "服务器 Key"
    # 3) 服务器也没有智谱 Key → 尝试 DeepSeek
    if not api_key:
        api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
        url, model = DEEPSEEK_URL, "deepseek-chat"
        source = "服务器 Key (DeepSeek)"
    # 安全：日志永远不打印完整 Key，只打印脱敏形式（前 4 位 + **** + 后 4 位）
    print(f"[translate] Key 来源: {source} | Key(脱敏): {_mask_key(api_key)}")
    print(f"[translate] 调用模型: {model}")
    if not api_key or not texts:
        return None

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _TRANSLATE_PROMPT},
            {"role": "user", "content": json.dumps(texts, ensure_ascii=False)},
        ],
        "temperature": temperature,
    }
    # 强制排查：打印实际发给大模型的 Prompt（system + user），核对长句与 JSON 格式
    print(f"[translate] 发送给 LLM 的 system prompt: {_TRANSLATE_PROMPT}")
    print(f"[translate] 发送给 LLM 的 user 内容({len(texts)} 条, 共 {len(json.dumps(texts, ensure_ascii=False))} 字符): {json.dumps(texts, ensure_ascii=False)}")
    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
        if resp.status_code != 200:
            print(f"[translate] LLM 调用失败：HTTP {resp.status_code} {resp.text[:200]}")
            return None
        # 强制排查：打印大模型返回的完整 response 结构与正文
        full_resp = resp.json()
        print(f"[translate] LLM 完整 response: {json.dumps(full_resp, ensure_ascii=False)[:800]}")
        content = full_resp["choices"][0]["message"]["content"].strip()
        print(f"[translate] LLM 返回正文: {content}")
        # 模型偶尔包 ```json ... ```，剥掉再解析
        if content.startswith("```"):
            content = content.strip("`").lstrip("json").strip()
        parsed = json.loads(content)
        if isinstance(parsed, list) and len(parsed) == len(texts):
            return [str(t) for t in parsed]
    except Exception as exc:
        # 强制排查：任何网络/解析异常都打在终端里
        print(f"[translate] LLM 调用异常: {type(exc).__name__}: {exc}")
        return None
    print("[translate] LLM 返回内容无法解析为等长 JSON 数组")
    return None


def _llm_translate(texts: list[str], user_api_key: str = "") -> Optional[list[str]]:
    """翻译并校验：整张图每条译文都必须是中文，否则重试一次；仍不合格返回 None。

    返回的 None 会让接口报 502 且【不写缓存】，彻底杜绝"有些是中文有些是原文"
    以及伪翻译被永久缓存污染的问题。
    """
    for attempt, temp in ((1, 0.3), (2, 0.7)):
        translated = _llm_translate_once(texts, user_api_key, temperature=temp)
        if translated is None:
            return None
        bad = [t for t in translated if not _is_chinese_translation(t)]
        if not bad:
            print(f"[translate] 中文校验通过：{len(translated)} 条译文全部为中文")
            return translated
        print(
            f"[translate] 第 {attempt} 次返回 {len(bad)}/{len(translated)} 条非中文，"
            f"示例: {bad[:2]!r}"
        )
    print("[translate] 重试后仍含非中文译文，放弃本次结果（不写缓存）")
    return None


# ===== 百度 OCR 备用引擎（主引擎质量不合格时自动降级） =====
# 密钥全部来自环境变量（BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY），绝不硬编码。
# 未配置 → 备用引擎静默禁用（返回 None），主引擎照常工作。
# access_token 内存缓存（有效期约 30 天），失效自动重取；任何异常都不影响主流程。

BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
BAIDU_OCR_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic"

# PaddleOCR lang → 百度 language_type 映射
_BAIDU_LANG_MAP = {"ch": "CHN_ENG", "en": "ENG", "korean": "KOR", "japan": "JAP"}

# 主引擎平均置信度低于该值 → 触发百度备用
BAIDU_TRIGGER_CONFIDENCE = float(os.getenv("BAIDU_TRIGGER_CONFIDENCE", "0.65") or "0.65")

_baidu_token: Optional[str] = None
_baidu_token_expire = 0.0
_baidu_lock = threading.Lock()


def _baidu_configured() -> bool:
    return bool(os.getenv("BAIDU_OCR_API_KEY", "").strip()) and bool(
        os.getenv("BAIDU_OCR_SECRET_KEY", "").strip()
    )


def _get_baidu_token() -> Optional[str]:
    """获取百度 access_token（内存缓存，过期前 1 小时提前刷新）。失败返回 None。"""
    global _baidu_token, _baidu_token_expire
    api_key = os.getenv("BAIDU_OCR_API_KEY", "").strip()
    secret_key = os.getenv("BAIDU_OCR_SECRET_KEY", "").strip()
    if not api_key or not secret_key:
        return None
    with _baidu_lock:
        if _baidu_token and time.time() < _baidu_token_expire:
            return _baidu_token
        try:
            resp = requests.post(
                BAIDU_TOKEN_URL,
                params={
                    "grant_type": "client_credentials",
                    "client_id": api_key,
                    "client_secret": secret_key,
                },
                timeout=10,
            )
            data = resp.json()
            token = data.get("access_token")
            if not token:
                # Key/Secret 错误等；日志只打印脱敏 Key，绝不输出完整密钥
                print(
                    f"[baidu] 获取 access_token 失败: {data.get('error', data)} "
                    f"(Key 脱敏: {_mask_key(api_key)})"
                )
                return None
            _baidu_token = token
            _baidu_token_expire = time.time() + max(60, int(data.get("expires_in", 2592000)) - 3600)
            print(f"[baidu] access_token 已获取并缓存（Key 脱敏: {_mask_key(api_key)}）")
            return _baidu_token
        except Exception as exc:
            print(f"[baidu] 获取 access_token 异常: {type(exc).__name__}: {exc}")
            return None


def _baidu_image_payload(img_bytes: bytes) -> str:
    """图片转 base64；超过百度 4MB 限制时压缩重编码为 JPEG。"""
    if len(img_bytes) <= 4 * 1024 * 1024:
        return base64.b64encode(img_bytes).decode("ascii")
    img = _decode_image(img_bytes)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise RuntimeError("图片压缩失败")
    print(f"[baidu] 图片超过 4MB，已压缩重编码（{len(img_bytes)} → {buf.nbytes} bytes）")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _baidu_ocr(img_bytes: bytes, lang: str) -> Optional[list[dict]]:
    """百度通用文字识别备用引擎。

    返回值与主引擎同构 [{box, text, conf}]（百度标准接口无置信度 → conf=None）。
    任何失败（未配置 / 网络异常 / 限流）都返回 None，由调用方沿用主引擎结果。
    """
    if not _baidu_configured():
        print("[baidu] 未配置 BAIDU_OCR_API_KEY/SECRET_KEY，备用引擎跳过")
        return None
    token = _get_baidu_token()
    if token is None:
        return None
    language_type = _BAIDU_LANG_MAP.get(lang, "ENG")
    try:
        resp = requests.post(
            BAIDU_OCR_URL,
            params={"access_token": token},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={"image": _baidu_image_payload(img_bytes), "language_type": language_type},
            timeout=15,
        )
        data = resp.json()
        if data.get("error_code"):
            print(
                f"[baidu] 识别失败 error_code={data.get('error_code')} "
                f"msg={data.get('error_msg')}"
            )
            if data.get("error_code") in (110, 111):  # token 失效 → 清缓存，下次重取
                global _baidu_token, _baidu_token_expire
                _baidu_token = None
                _baidu_token_expire = 0.0
            return None
        items: list[dict] = []
        for w in data.get("words_result", []):
            loc = w.get("location", {}) or {}
            items.append(
                {
                    "box": [
                        int(loc.get("left", 0)),
                        int(loc.get("top", 0)),
                        int(loc.get("width", 0)),
                        int(loc.get("height", 0)),
                    ],
                    "text": str(w.get("words", "")),
                    "conf": None,  # 百度标准接口不返回置信度
                }
            )
        print(f"[baidu] 备用引擎识别 {len(items)} 个文本框（lang={language_type}）")
        return items
    except Exception as exc:
        print(f"[baidu] 调用异常: {type(exc).__name__}: {exc}")
        return None


def _ocr_quality_ok(items: list[dict]) -> bool:
    """主引擎质量判断：非空且（有置信度的条目）平均置信度达标。

    - 空结果 → False（调用方可触发一次备用）
    - 全部条目无置信度（百度结果等）→ True（不触发）
    - 平均置信度 < BAIDU_TRIGGER_CONFIDENCE → False
    """
    if not items:
        return False
    confs = [it["conf"] for it in items if isinstance(it.get("conf"), (int, float))]
    if not confs:
        return True
    avg = sum(confs) / len(confs)
    return avg >= BAIDU_TRIGGER_CONFIDENCE


# ===== 翻译结果缓存（TranslationCache 表，模型定义在 main.py） =====
# 同一张图（按内容 SHA256 唯一）不重复跑 OCR + 大模型，节省时间与 API 额度。
# 注意：函数内延迟 import main，避免模块加载期的循环导入。


def _cache_get(image_hash: str) -> Optional[str]:
    """查缓存：命中返回 result_json 字符串，未命中返回 None。"""
    try:
        from main import SessionLocal, TranslationCache

        db = SessionLocal()
        try:
            row = db.query(TranslationCache).filter(TranslationCache.image_hash == image_hash).first()
            return row.result_json if row else None
        finally:
            db.close()
    except Exception as exc:
        # 缓存层任何异常都不影响翻译主流程（视为未命中）
        print(f"[translate] 缓存查询失败（按未命中处理）: {type(exc).__name__}: {exc}")
        return None


def _cache_put(image_hash: str, image_url: str, result: list[dict], overwrite: bool = False) -> None:
    """写入缓存（已存在同 hash 时默认跳过；overwrite=True 用于备用引擎结果覆盖空结果）。

    场景：主引擎空结果先写缓存 → 百度备用识别出文字 → 覆盖缓存，避免下次同图
    再跑一次 OCR 才发现"缓存里的空结果其实是误判"。
    """
    try:
        from main import SessionLocal, TranslationCache

        db = SessionLocal()
        try:
            exists = db.query(TranslationCache).filter(TranslationCache.image_hash == image_hash).first()
            if exists:
                if overwrite and exists.result_json != json.dumps(result, ensure_ascii=False):
                    exists.result_json = json.dumps(result, ensure_ascii=False)
                    db.commit()
                return
            db.add(
                TranslationCache(
                    image_hash=image_hash,
                    # data:URL 动辄几 MB，只截断存前 2000 字符供人工排查
                    image_url=(image_url or "")[:2000],
                    result_json=json.dumps(result, ensure_ascii=False),
                )
            )
            db.commit()
        finally:
            db.close()
    except Exception as exc:
        print(f"[translate] 缓存写入失败（不影响翻译结果）: {type(exc).__name__}: {exc}")


def _cache_delete(image_hash: str) -> None:
    """删除该图的翻译缓存（用户点『重新翻译』或发现脏缓存时调用）。"""
    try:
        from main import SessionLocal, TranslationCache

        db = SessionLocal()
        try:
            db.query(TranslationCache).filter(
                TranslationCache.image_hash == image_hash
            ).delete(synchronize_session=False)
            db.commit()
            print(f"[translate] 已清除旧缓存 hash={image_hash[:16]}…")
        finally:
            db.close()
    except Exception as exc:
        print(f"[translate] 清除缓存失败（不影响重译）: {type(exc).__name__}: {exc}")


# ===== 接口：POST /api/translate =====


@router.post("/api/translate")
async def translate_comic(request: Request):
    """漫画图片 OCR 翻译。

    支持两种请求：
    - application/json：{"image_url": "https://... 或 data:image/...;base64,...", "lang": "en"}
    - multipart/form-data：file=<图片文件>&lang=en（也接受 image_url 字段）
    - force=true：用户点『重新翻译』→ 先清除该图旧缓存，重新识别翻译后重新保存

    返回：[{"box": [x, y, w, h], "bg_color": "#f5f5dc", "original": "...", "translated": "..."}]
    译文必须整张全部为中文，否则返回 502 且不写缓存（避免脏结果被永久缓存）。
    """
    # 接口开头强制排查：Key 长度为 0 = 当前进程环境没有注入 Key（会走伪翻译）
    print("Key 长度:", len(os.getenv("ZHIPU_API_KEY", "")))
    content_type = request.headers.get("content-type", "")
    image_url: Optional[str] = None
    lang_raw: str = "en"
    user_api_key: str = ""
    file_bytes: Optional[bytes] = None
    force: bool = False

    if content_type.startswith("multipart/"):
        form = await request.form()
        image_url = form.get("image_url")  # type: ignore[assignment]
        lang_raw = str(form.get("lang") or "en")
        user_api_key = str(form.get("api_key") or "").strip()  # BYOK：用户自带 Key
        force = str(form.get("force") or "").lower() in ("1", "true", "yes")
        upload = form.get("file")
        if upload is not None and hasattr(upload, "read"):
            file_bytes = await upload.read()
    else:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请用 application/json 或 multipart/form-data 提交")
        image_url = body.get("image_url")  # type: ignore[assignment]
        lang_raw = str(body.get("lang") or "en")
        user_api_key = str(body.get("api_key") or "").strip()  # BYOK：用户自带 Key
        force = bool(body.get("force"))

    lang = SUPPORTED_LANGS.get(lang_raw.lower())
    if lang is None:
        raise HTTPException(status_code=400, detail=f"不支持的语言，可选：{sorted(set(SUPPORTED_LANGS.values()))}")

    if file_bytes:
        img_bytes = file_bytes
    elif image_url:
        img_bytes = _fetch_image_bytes(str(image_url))
    else:
        raise HTTPException(status_code=400, detail="缺少图片：请提供 image_url 或 file")
    img = _decode_image(img_bytes)

    # 翻译结果缓存：按图片内容 SHA256 唯一标识（同图不同 URL 形式/不同 Key 都命中同一条）
    cache_key = hashlib.sha256(img_bytes).hexdigest()
    # 用户点『重新翻译』：清掉旧缓存（含历史脏译文），本次重新 OCR + 翻译并重新保存
    if force:
        _cache_delete(cache_key)
        print(f"[重新翻译] hash={cache_key[:16]}… 已清除旧缓存，重新识别与翻译")
    else:
        cached_json = _cache_get(cache_key)
        if cached_json is not None:
            try:
                cached_result = json.loads(cached_json)
            except Exception:
                cached_result = None
            # 只有整张全部为中文的缓存才可用；历史伪翻译/混入原文的脏缓存直接废弃
            if cached_result is not None and _result_all_chinese(cached_result):
                print(f"[缓存命中] hash={cache_key[:16]}… 跳过 OCR 与大模型调用，直接返回缓存结果")
                return cached_result
            print("[缓存] 旧缓存含非中文译文，废弃并重新翻译")
            _cache_delete(cache_key)
    print(f"[新图翻译并写入缓存] hash={cache_key[:16]}… 未命中，开始 OCR + 翻译")

    # OCR（模型未就绪/下载失败 → 503，提示如何手动放置模型）
    try:
        ocr = _get_ocr(lang)
    except Exception as exc:  # 模型下载失败、paddle 未安装等
        raise HTTPException(
            status_code=503,
            detail=f"OCR 引擎初始化失败：{exc}。首次运行需联网下载模型，或手动把模型放到 ~/.paddlex/official_models/ 目录",
        )

    # ===== 主引擎：PaddleOCR Mobile（信号量限流，防止并发推理撑爆内存） =====
    items: list[dict] = []
    ocr_error: Optional[Exception] = None
    try:
        acquired = _ocr_semaphore.acquire(timeout=_OCR_QUEUE_TIMEOUT)
        if not acquired:
            raise HTTPException(status_code=503, detail="OCR 排队超时（服务繁忙），请稍后重试")
        try:
            raw_result = ocr.predict(img)
        finally:
            _ocr_semaphore.release()
        items = _parse_ocr_result(raw_result)
    except HTTPException:
        raise
    except Exception as exc:
        ocr_error = exc

    # 强制排查：打印主引擎原始识别结果（文本 + box + 置信度）
    if ocr_error is None:
        print(f"[translate] 主引擎(PaddleOCR) 原始识别 {len(items)} 个文本框:")
        for it in items:
            conf = it.get("conf")
            conf_str = f"{conf:.2f}" if isinstance(conf, (int, float)) else "N/A"
            print(f"[translate]   {it['text']!r} box={it['box']} conf={conf_str}")

    # ===== 质量判断 + 备用引擎降级 =====
    # 触发条件：主引擎异常，或有框但平均置信度偏低，或空结果（触发一次百度兜底）。
    # 防重复调用：任何结果（含空）最终都会写入缓存，同图第二次请求直接命中缓存，
    # 不会再触发百度 API。
    engine = "paddle"
    if ocr_error is not None or not _ocr_quality_ok(items):
        reason = (
            f"主引擎异常: {type(ocr_error).__name__}: {ocr_error}"
            if ocr_error is not None
            else (f"主引擎 0 个文本框" if not items else f"平均置信度偏低")
        )
        print(f"[translate] 质量判断未通过（{reason}），尝试百度备用引擎")
        baidu_items = _baidu_ocr(img_bytes, lang)
        if baidu_items is not None:
            engine = "baidu"
            print(f"[translate] 已切换备用引擎结果（百度 {len(baidu_items)} 个文本框）")
            items = baidu_items
        elif ocr_error is not None:
            # 主引擎失败且备用不可用 → 保持原有错误行为
            raise HTTPException(status_code=500, detail=f"OCR 识别失败：{ocr_error}")
        # 百度不可用但主引擎只是质量偏低 → 沿用主引擎结果继续翻译

    if not items:
        print("[translate] 两个引擎均未识别到文本（图片本身无文字，返回空数组）")
        _cache_put(cache_key, str(image_url or ""), [])
        print("[新图翻译并写入缓存] 空结果也写入缓存")
        return []

    # 过滤超大拟声词框与无效短文本（不翻译、不取色、不返回）
    items = _filter_items(items, img)
    if not items:
        print("[translate] 过滤后无剩余文本框（全部被尺寸/无效字符过滤）")
        _cache_put(cache_key, str(image_url or ""), [])
        print("[新图翻译并写入缓存] 空结果也写入缓存")
        return []

    # 同气泡多行小框合并成大气泡框：整段话一次性发给 LLM，翻译出连贯中文
    items = _merge_bubble_lines(items)

    texts = [it["text"] for it in items]
    print(f"[translate] 最终发给大模型的文本({len(texts)} 条): {texts}")
    translated = _llm_translate(texts, user_api_key=user_api_key)
    if translated is None:
        # 未配置 Key / 调用失败 / 译文不是中文 → 不写缓存、不返回脏译文，让前端明确报错重试
        raise HTTPException(
            status_code=502,
            detail="翻译未获得合规中文译文（密钥未配置、模型返回原文或超时），请稍后重试",
        )

    result = [
        {
            "box": it["box"],
            "bg_color": _bubble_bg_color(img, it["box"]),
            "original": it["text"],
            "translated": translated[i],
        }
        for i, it in enumerate(items)
    ]
    # 新图翻译完成：结果写入缓存，下次同图直接命中
    # 备用引擎结果覆盖写入（主引擎可能先写过空/低质量缓存）
    _cache_put(cache_key, str(image_url or ""), result, overwrite=(engine == "baidu"))
    print(f"[新图翻译并写入缓存] 引擎={engine} hash={cache_key[:16]}… 共 {len(result)} 条气泡")
    return result
