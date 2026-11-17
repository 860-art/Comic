"""OCR 漫画翻译服务（真实接口）。

流程：图片 → PaddleOCR 识别文字与坐标框 → OpenCV 取气泡边缘平均背景色 →
调用智谱 GLM / DeepSeek 翻译成中文（未配置 API Key 时返回伪翻译 "[译] 原文"）。

环境变量：
- ZHIPU_API_KEY    智谱开放平台 Key（免费模型 glm-4-flash）
- DEEPSEEK_API_KEY DeepSeek Key（deepseek-chat）
两者都没配置 → 伪翻译，方便先联调前端。
"""

import base64
import json
import os
import threading
from typing import Optional

import cv2
import numpy as np
import re
import requests
from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

# 支持的 OCR 语言（PaddleOCR 的 lang 参数值）
SUPPORTED_LANGS = {"ch": "ch", "en": "en", "korean": "korean", "ko": "korean", "japan": "japan"}

# ===== 大尺寸文本框过滤阈值（可按需微调） =====
# 韩漫/日漫里巨大的拟声词（如 악、ドン）会被 OCR 识别成一个超大框，
# 覆盖大半个画面，翻译框会严重遮挡画面 → 按占图比例直接跳过。
# 阈值放宽到 60%/40%：只有真正铺满画面的巨型拟声词才被过滤，长句旁白/对话全部放行。
MAX_BOX_WIDTH_RATIO = 0.60   # 文字框宽度超过图片总宽度的 60% → 跳过
MAX_BOX_HEIGHT_RATIO = 0.40  # 文字框高度超过图片总高度的 40% → 跳过
MIN_MEANINGFUL_CHARS = 2     # 有效字符（去掉标点/空白后的字母数字）少于 2 个 → 跳过（单字符拟声词/标点）

# ===== OCR 懒加载单例（按语言缓存；首次调用会自动下载模型到用户目录） =====
_ocr_instances: dict[str, object] = {}
_ocr_lock = threading.Lock()


def _get_ocr(lang: str):
    """获取（或初始化）PaddleOCR 实例。模型下载失败会抛异常，由接口转成 503。"""
    with _ocr_lock:
        if lang not in _ocr_instances:
            from paddleocr import PaddleOCR  # 延迟导入：未安装 paddle 时其它接口不受影响

            # enable_mkldnn=False：paddle 3.3.1 的 onednn 执行器存在
            # ConvertPirAttribute2RuntimeAttribute 兼容 bug，CPU 推理必须走纯 CPU 算子
            _ocr_instances[lang] = PaddleOCR(
                lang=lang,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,
            )
        return _ocr_instances[lang]


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
        for i, text in enumerate(texts):
            xywh = None
            if i < len(polys) and polys[i] is not None:
                xywh = _poly_to_xywh(polys[i])
            if xywh is None and i < len(boxes) and len(boxes[i]) >= 4:
                b = [int(v) for v in boxes[i]]
                xywh = [b[0], b[1], b[2] - b[0], b[3] - b[1]]
            if xywh is None:
                continue
            items.append({"box": xywh, "text": str(text)})
        return items

    # 2.x：[[poly, (text, conf)], ...]
    for entry in raw:
        try:
            poly, pair = entry[0], entry[1]
            text = pair[0]
            xywh = _poly_to_xywh(poly)
            if xywh is not None:
                items.append({"box": xywh, "text": str(text)})
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
)


def _mask_key(key: str) -> str:
    """日志脱敏：只显示前 4 位和后 4 位，防止 Key 泄露到终端日志。"""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}****{key[-4:]}"


def _llm_translate(texts: list[str], user_api_key: str = "") -> Optional[list[str]]:
    """调用 LLM 批量翻译；失败返回 None（调用方回退伪翻译）。

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
        "temperature": 0.3,
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
    print("[translate] LLM 返回内容无法解析为等长 JSON 数组，回退伪翻译")
    return None


# ===== 接口：POST /api/translate =====


@router.post("/api/translate")
async def translate_comic(request: Request):
    """漫画图片 OCR 翻译。

    支持两种请求：
    - application/json：{"image_url": "https://... 或 data:image/...;base64,...", "lang": "en"}
    - multipart/form-data：file=<图片文件>&lang=en（也接受 image_url 字段）

    返回：[{"box": [x, y, w, h], "bg_color": "#f5f5dc", "original": "...", "translated": "..."}]
    """
    # 接口开头强制排查：Key 长度为 0 = 当前进程环境没有注入 Key（会走伪翻译）
    print("Key 长度:", len(os.getenv("ZHIPU_API_KEY", "")))
    content_type = request.headers.get("content-type", "")
    image_url: Optional[str] = None
    lang_raw: str = "en"
    user_api_key: str = ""
    file_bytes: Optional[bytes] = None

    if content_type.startswith("multipart/"):
        form = await request.form()
        image_url = form.get("image_url")  # type: ignore[assignment]
        lang_raw = str(form.get("lang") or "en")
        user_api_key = str(form.get("api_key") or "").strip()  # BYOK：用户自带 Key
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

    lang = SUPPORTED_LANGS.get(lang_raw.lower())
    if lang is None:
        raise HTTPException(status_code=400, detail=f"不支持的语言，可选：{sorted(set(SUPPORTED_LANGS.values()))}")

    if file_bytes:
        img = _decode_image(file_bytes)
    elif image_url:
        img = _decode_image(_fetch_image_bytes(str(image_url)))
    else:
        raise HTTPException(status_code=400, detail="缺少图片：请提供 image_url 或 file")

    # OCR（模型未就绪/下载失败 → 503，提示如何手动放置模型）
    try:
        ocr = _get_ocr(lang)
    except Exception as exc:  # 模型下载失败、paddle 未安装等
        raise HTTPException(
            status_code=503,
            detail=f"OCR 引擎初始化失败：{exc}。首次运行需联网下载模型，或手动把模型放到 ~/.paddlex/official_models/ 目录",
        )

    try:
        raw_result = ocr.predict(img)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OCR 识别失败：{exc}")

    items = _parse_ocr_result(raw_result)
    # 强制排查：打印 OCR 原始识别结果（文本 + box），定位"第一页没翻译"断在哪一环
    print(f"[translate] OCR 原始识别 {len(items)} 个文本框:")
    for it in items:
        print(f"[translate]   {it['text']!r} box={it['box']}")
    if not items:
        print("[translate] OCR 未识别到任何文本（返回空数组）")
        return []

    # 过滤超大拟声词框与无效短文本（不翻译、不取色、不返回）
    items = _filter_items(items, img)
    if not items:
        print("[translate] 过滤后无剩余文本框（全部被尺寸/无效字符过滤）")
        return []

    # 同气泡多行小框合并成大气泡框：整段话一次性发给 LLM，翻译出连贯中文
    items = _merge_bubble_lines(items)

    texts = [it["text"] for it in items]
    print(f"[translate] 最终发给大模型的文本({len(texts)} 条): {texts}")
    translated = _llm_translate(texts, user_api_key=user_api_key)
    if translated is None:
        # 未配置 Key 或调用失败 → 伪翻译，保证流程可先跑通
        translated = [f"[译] {t}" for t in texts]

    return [
        {
            "box": it["box"],
            "bg_color": _bubble_bg_color(img, it["box"]),
            "original": it["text"],
            "translated": translated[i],
        }
        for i, it in enumerate(items)
    ]
