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

import ast
import base64
import gc
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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
MAX_BOX_WIDTH_RATIO = 0.60   # 文字框宽度超过图片总宽度的 60% → 检查是否为长句标题
MAX_BOX_HEIGHT_RATIO = 0.40  # 文字框高度超过图片总高度的 40% → 检查是否为长句标题
MIN_MEANINGFUL_CHARS = 2     # 有效字符（去掉标点/空白后的字母数字）少于 2 个 → 跳过（单字符拟声词/标点）
# 大尺寸框里有效字符 ≥ 此数 → 判定为横幅标题/旁白（如 "AFTER I POSSESSED THAT EMPTY BODY..."），
# 必须翻译放行；只有短短几个字的巨型拟声词（악、ドン）才真正跳过
LONG_BANNER_MIN_CHARS = 8

# ===== OCR 懒加载单例（按语言缓存；启动预热 + 首次调用兜底） =====
# PaddleOCR 3.x 返回结构各模型一致（rec_texts 等 dict），下游解析零改动。
# 【重要】server_det（~85MB）在 2核4G 容器实测推理抛 MemoryError（任务 3 次重试全失败）。
# 默认恢复 mobile_det（~5MB）先保证可用；大标题检出改由下方低内存「分块二次检测」补足。
# 仅内存充足的服务器可显式设 OCR_DET_MODEL=PP-OCRv5_server_det 启用大模型。
OCR_DET_MODEL = os.getenv("OCR_DET_MODEL", "PP-OCRv5_mobile_det") or "PP-OCRv5_mobile_det"
# 检测输入边长保持 960（1280 会进一步抬高内存峰值）
OCR_DET_SIDE_LEN = max(640, int(os.getenv("OCR_DET_SIDE_LEN", "960") or "960"))
# 低内存分块二次检测：全图 OCR 后上下切两块各再跑一次（每块更小 → 峰值更低），
# 补齐 mobile_det 漏检的大号描边标题，结果按 IoU/文本去重合并。设 0 可关闭。
OCR_TILE_DETECT = (os.getenv("OCR_TILE_DETECT", "1") or "1").strip().lower() not in (
    "0", "false", "no",
)
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
            _ocr_instances[lang] = _create_ocr(lang)
        return _ocr_instances[lang]


def _create_ocr(lang: str):
    """新建一个 PaddleOCR 实例（调优参数 → 安全配置 → 默认模型 三级兜底）。

    独立成函数供主实例与切片检测实例复用；paddle pipeline 对象非线程安全，
    并发 predict 必须各自持有独立实例，不能共用。
    """
    from paddleocr import PaddleOCR  # 延迟导入：未安装 paddle 时其它接口不受影响

    # ===== 性能调优参数（2核4G 小内存服务器实测配置）=====
    # - enable_mkldnn=True：启用 MKLDNN 加速 CPU 推理
    # - rec_batch_num=1：识别批大小压到 1，内存峰值最低（漫画逐行识别足够）
    # - use_angle_cls=False：漫画文字固定正向，跳过方向分类省时省内存
    # - cpu_math_library_num_threads=2：CPU 数学库线程数对齐 2 核
    # - det_limit_side_len=OCR_DET_SIDE_LEN（默认 960）：大图缩放控内存
    tuned_kwargs = dict(
        lang=lang,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=True,
        rec_batch_num=1,
        use_angle_cls=False,
        cpu_math_library_num_threads=2,
        det_limit_side_len=OCR_DET_SIDE_LEN,
    )
    # 兜底安全配置：调优参数在当前 paddle 版本不可用（初始化报错）时回退，
    # mkldnn 关闭走纯 CPU 算子（paddle 3.3.1 onednn 存在兼容 bug 的场景）
    safe_kwargs = dict(
        lang=lang,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,
    )
    try:
        if lang == "korean":
            # 韩文：两个模型名都显式指定（lang 此时会被忽略，不能依赖它选 rec）
            return PaddleOCR(
                text_detection_model_name=OCR_DET_MODEL,
                text_recognition_model_name=_KOREAN_MOBILE_REC,
                **tuned_kwargs,
            )
        return PaddleOCR(
            text_detection_model_name=OCR_DET_MODEL,
            text_recognition_model_name=_MOBILE_REC,
            **tuned_kwargs,
        )
    except Exception as exc:
        # 兜底：调优参数不可用时回退安全配置（保证功能不中断）
        print(f"[ocr] 调优参数初始化失败，回退安全配置: {type(exc).__name__}: {exc}")
        try:
            if lang == "korean":
                return PaddleOCR(
                    text_detection_model_name=OCR_DET_MODEL,
                    text_recognition_model_name=_KOREAN_MOBILE_REC,
                    **safe_kwargs,
                )
            return PaddleOCR(
                text_detection_model_name=OCR_DET_MODEL,
                text_recognition_model_name=_MOBILE_REC,
                **safe_kwargs,
            )
        except Exception as exc2:
            print(f"[ocr] Mobile 模型初始化失败，回退默认模型: {type(exc2).__name__}: {exc2}")
            return PaddleOCR(**safe_kwargs)


# 切片二次检测专用实例（与主实例隔离：paddle pipeline 非线程安全，并发 predict 不能共用）
_tile_ocr_instances: dict[str, object] = {}
_tile_ocr_lock = threading.Lock()


def _get_tile_ocr(lang: str):
    """切片检测专用 OCR 实例（惰性创建，每语言一个；首次创建会阻塞数秒加载模型）。"""
    with _tile_ocr_lock:
        if lang not in _tile_ocr_instances:
            _tile_ocr_instances[lang] = _create_ocr(lang)
        return _tile_ocr_instances[lang]


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


# ===== 低内存分块二次检测 =====
def _box_iou(a: list, b: list) -> float:
    """两个 [x, y, w, h] 框的交并比。"""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    iw = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    ih = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _dedup_ocr_items(items: list[dict]) -> list[dict]:
    """全图与切片结果的重复框去重：同位置（IoU>0.55）或位置接近且文本包含 → 只留高置信度那条。"""
    kept: list[dict] = []
    for it in sorted(items, key=lambda x: -float(x.get("conf") or 0)):
        t = re.sub(r"\W+", "", it.get("text") or "", flags=re.UNICODE).lower()
        dup = False
        for k in kept:
            iou = _box_iou(it["box"], k["box"])
            kt = re.sub(r"\W+", "", k.get("text") or "", flags=re.UNICODE).lower()
            same_text = bool(t) and (t == kt or t in kt or kt in t)
            if iou > 0.55 or (iou > 0.1 and same_text):
                dup = True
                break
        if not dup:
            kept.append(it)
    return kept


def _ocr_detect(ocr, img: np.ndarray, lang: str = "en") -> list[dict]:
    """OCR 检测：全图一次 + 上下两个重叠切片各一次（每块更小 → 内存峰值更低）。

    mobile_det 对铺满宽度的描边艺术字标题容易漏检；切片后文本行长宽比变正常，
    检出率明显提升。切片结果坐标加回 Y 偏移，与全图结果去重后合并。
    提速：全图（主实例）与两个切片（独立切片实例，串行共用）【并发】跑，
    OCR 总耗时约从 3 份压到 2 份。任一切片失败只忽略该片，绝不影响主流程；
    全图失败则照旧向上抛（调用方按 OCR 失败处理）。
    """
    h = img.shape[0]
    if not OCR_TILE_DETECT or h < 600:
        return _parse_ocr_result(ocr.predict(img))

    def run_full() -> list[dict]:
        return _parse_ocr_result(ocr.predict(img))

    def run_tiles() -> list[dict]:
        out: list[dict] = []
        try:
            tile_ocr = _get_tile_ocr(lang)
        except Exception as exc:
            print(f"[ocr] 切片实例创建失败（只跑全图）: {type(exc).__name__}: {exc}")
            return out
        for tile, y1 in ((img[: int(h * 0.58)], 0), (img[int(h * 0.42) :], int(h * 0.42))):
            try:
                tile_items = _parse_ocr_result(tile_ocr.predict(tile))
            except Exception as exc:
                print(f"[ocr] 分块检测失败（忽略，不影响主流程）: {type(exc).__name__}: {exc}")
                continue
            for it in tile_items:
                x, y, w, hh = it["box"]
                it["box"] = [x, y + y1, w, hh]
            out.extend(tile_items)
        return out

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_full = pool.submit(run_full)
        f_tiles = pool.submit(run_tiles)
        items = f_full.result()  # 全图失败 → 抛出，主流程失败（与旧行为一致）
        items.extend(f_tiles.result())
    merged = _dedup_ocr_items(items)
    print(f"[ocr] 全图+分块并发检测：{len(items)} 个框去重后 {len(merged)} 个")
    return merged


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
        meaningful_chars = len(_PUNCT_RE.sub("", it["text"]))
        if w > img_w * MAX_BOX_WIDTH_RATIO or h > img_h * MAX_BOX_HEIGHT_RATIO:
            # 超宽/超高框：长句是封面标题、章节横幅或长旁白 → 放行翻译；
            # 只有短短几个字的巨型拟声词（악、ドン）才跳过，避免遮挡画面
            if meaningful_chars >= LONG_BANNER_MIN_CHARS:
                print(
                    f"[translate]   保留大尺寸标题/横幅: {it['text']!r} "
                    f"(占图宽 {w / img_w:.0%} / 占图高 {h / img_h:.0%})"
                )
            else:
                skipped += 1
                print(
                    f"[translate]   跳过大框: {it['text']!r} box={it['box']} "
                    f"(占图宽 {w / img_w:.0%} / 占图高 {h / img_h:.0%})"
                )
                continue
        if meaningful_chars < MIN_MEANINGFUL_CHARS:
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


def _bubble_text_color(img: np.ndarray, box: list[int], bg_hex: str) -> Optional[str]:
    """采样文字框内【原本的文字像素】颜色，作为译文文字颜色（不再是单纯黑白）。

    判定前景：与气泡背景色差异明显的像素（描边字、彩色标题也能取到主色），
    取其中位数抑制抗锯齿边缘；样本太少或与背景对比不足 → 返回 None，
    前端回退到按背景亮度自动取黑/白，保证任何情况下译文都可读。
    """
    x, y, w, h = box
    img_h, img_w = img.shape[:2]
    # 内缩 5% 避开文字框外沿的气泡描边
    ix1, iy1 = max(0, x + int(w * 0.05)), max(0, y + int(h * 0.05))
    ix2, iy2 = min(img_w, x + w - int(w * 0.05)), min(img_h, y + h - int(h * 0.05))
    if ix2 <= ix1 or iy2 <= iy1:
        return None
    try:
        s = bg_hex.lstrip("#")
        bg_rgb = np.array([int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)])
    except Exception:
        return None
    region = img[iy1:iy2, ix1:ix2].reshape(-1, 3).astype(np.int32)
    bg_bgr = bg_rgb[::-1].astype(np.int32)  # cv2 图像是 BGR
    diff = np.max(np.abs(region - bg_bgr), axis=1)
    fg = region[diff > 50]  # 与背景差异明显 = 文字笔画
    if len(fg) < max(10, int(len(region) * 0.005)):
        return None
    med = np.median(fg, axis=0).astype(int)  # BGR
    lum_fg = 0.299 * med[2] + 0.587 * med[1] + 0.114 * med[0]
    lum_bg = 0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]
    if abs(lum_fg - lum_bg) < 40:  # 取出的颜色与背景太接近 → 回退对比色
        return None
    return "#{:02x}{:02x}{:02x}".format(int(med[2]), int(med[1]), int(med[0]))


def _build_translated_bubble(img: np.ndarray, item: dict, translated_text: str) -> dict:
    """统一组装单条译文气泡：坐标 + 背景色 + 原文字颜色 + 原文/译文。"""
    bg = _bubble_bg_color(img, item["box"])
    return {
        "box": item["box"],
        "bg_color": bg,
        "text_color": _bubble_text_color(img, item["box"], bg),
        "original": item["text"],
        "translated": translated_text,
    }


# ===== 同气泡行合并：把同一气泡/同一段落里上下贴近的多行小框合并成一个框 =====
# 判定条件（满足全部才算同一段）：
#   1. X 轴相近：两框中心点水平距离 < 较宽框宽度的 60%，或两框水平重叠率 > 40%
#      （居中/左对齐/右对齐的行都能并上）
#   2. Y 轴间距 < 较矮框高度 × 1.5 —— 漫画旁白行距普遍大于气泡内行距，
#      0.5 的旧阈值导致同一段话被拆成多个独立翻译框（用户看到的"间隔"）
MERGE_X_CENTER_TOLERANCE = 0.6
MERGE_Y_GAP_RATIO = 1.5
# 水平重叠率下限：overlap = 交集宽 / 较窄框宽，超过即视为同段（X 中心判定的补充）
MERGE_X_OVERLAP_RATIO = 0.4
# 防误并保险：一组最多 5 行，避免整页旁白全部串成一句
MERGE_MAX_LINES_PER_GROUP = 5


def _group_bbox(group: list[dict]) -> list[int]:
    """一组文本框的并集外接矩形 [x, y, w, h]。"""
    xs1 = [g["box"][0] for g in group]
    ys1 = [g["box"][1] for g in group]
    xs2 = [g["box"][0] + g["box"][2] for g in group]
    ys2 = [g["box"][1] + g["box"][3] for g in group]
    x, y = min(xs1), min(ys1)
    return [x, y, max(xs2) - x, max(ys2) - y]


def _can_merge(g1: list[dict], g2: list[dict]) -> bool:
    """两组框是否属于同一段：X 轴相近（中心或重叠）且 Y 轴间距不大。"""
    # 防误并保险：合并后超过行数上限的组永不合并
    if len(g1) + len(g2) > MERGE_MAX_LINES_PER_GROUP:
        return False
    x1, y1, w1, h1 = _group_bbox(g1)
    x2, y2, w2, h2 = _group_bbox(g2)
    # 1) X 轴相近：中心点距离 < 较宽框宽度 × 容差，或水平重叠率足够大
    cx1, cx2 = x1 + w1 / 2, x2 + w2 / 2
    x_near = abs(cx1 - cx2) < MERGE_X_CENTER_TOLERANCE * max(w1, w2)
    if not x_near:
        inter_w = min(x1 + w1, x2 + w2) - max(x1, x2)
        x_near = inter_w > MERGE_X_OVERLAP_RATIO * min(w1, w2)
    if not x_near:
        return False
    # 2) Y 轴间距 < 较矮框高度 × 阈值（负数 = 已相交，直接算近）
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
    "人名、地名、拟声词、单字母、纯符号也要音译或意译成汉字"
    "（例如 SISTER DANA → 达娜修女，S- → 咝，AH! → 啊！），"
    "绝不要因为文本很短就原样返回；返回数组的元素个数必须与输入完全一致。"
    "若台词里出现网址、域名或站点水印（如 XXX.ORG / XXX.COM / http 链接），"
    "一律用中文描述或直接省略，严禁把拉丁字母原样写进译文。"
)

# ===== 水印/推广气泡过滤 =====
# 漫画图上常带盗版站水印（如「MAKE SURE YOU ... CEAL MAGUSTOON.ORG」），
# 它不是对白，模型又总会忠实保留域名拉丁字母，导致中文校验永远不过、整页翻译失败。
# 这类文本在【翻译前】直接剔除：不送 LLM、不生成中文气泡，也不影响其它正常对白。
_WATERMARK_RE = re.compile(
    r"(?:https?://|www\.)\S+"  # 完整 URL
    r"|\b[A-Za-z0-9][A-Za-z0-9\-]*\s*\.\s*"
    r"(?:org|com|net|io|cc|co|xyz|top|site|club|shop|me|tv|info|biz|kr|jp|cn)\b"  # 域名，允许 "MAGUSTOON .ORG"
    r"|\.\s*(?:org|com|net|io|cc|co|xyz|top|site|club|shop|me|tv|info|biz|kr|jp|cn)\b"  # 孤立后缀 " .ORG"
    r"|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",  # 邮箱
    re.IGNORECASE,
)


def strip_watermark_items(items: list[dict]) -> list[dict]:
    """剔除含网址/域名/邮箱的水印推广气泡（保留正常对白），并打印剔除数量便于排查。"""
    if not items:
        return items
    kept = [it for it in items if not _WATERMARK_RE.search(str(it.get("text") or ""))]
    removed = len(items) - len(kept)
    if removed:
        print(f"[watermark] 剔除 {removed} 个含网址/域名的水印气泡（不参与翻译）")
    return kept

# ===== 译文中文校验 =====
# 大模型偶尔偷懒：数组里只有一部分翻成中文，其余原样返回英文/韩文/日文；
# 或者返回伪翻译 "[译] 原文"。这些结果一旦写入缓存会永久显示，必须在入缓存前拦住。
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
# 连续 3 个以上拉丁字母（放行 OK/AI 这类 2 字母缩写）/ 任意韩文音节 / 任意日文假名
# → 判定为原文残留
_FOREIGN_RE = re.compile(r"[A-Za-z]{3,}|[\uac00-\ud7af\u3130-\u318f]|[\u3040-\u30ff]")


def _is_chinese_translation(text: str) -> bool:
    """单条译文是否为合规中文：至少含一个汉字，且不含成串外文与伪翻译标记。

    网址/域名残留（水印）先剥离再判定：它不是「原文台词残留」；
    纯外文句子、伪翻译标记仍一律拒绝，严格校验不放松。
    """
    t = (text or "").strip()
    if not t or "[译]" in t:
        return False
    t = _WATERMARK_RE.sub("", t).strip()
    if not t or not _CJK_RE.search(t):
        return False
    if _FOREIGN_RE.search(t):
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


def _parse_llm_array(content: str, expected: int) -> Optional[list[str]]:
    """容错解析 LLM 返回的 JSON 数组。

    实测日志：模型明明给出了 5 条正确中文译文，却因 `Unterminated string`
    （引号未闭合 / 裸换行 / 全角引号 / 结尾多余解释）被 json.loads 整批丢弃。
    这里按「清洗 → 宽松解析 → 正则兜底」多层救回，最后仍强制等长校验，
    绝不把错位译文写进结果。
    """
    s = (content or "").strip()
    if not s:
        return None
    # 1) markdown 代码围栏：```json [...] ``` / ``` [...] ```
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s).strip()
    # 2) 只取第一个 [ 到最后一个 ]，丢掉模型爱加的「以下是翻译：」等解释文字
    lb, rb = s.find("["), s.rfind("]")
    if lb >= 0 and rb > lb:
        s = s[lb : rb + 1]
    # 3) 中文引号 → 半角引号（模型偶发）
    s = s.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")

    # 4) 依次尝试：宽松 JSON（strict=False 放行字符串内裸换行/控制字符）→ Python 字面量
    for loader in (lambda x: json.loads(x, strict=False), ast.literal_eval):
        try:
            parsed = loader(s)
        except Exception:
            continue
        if isinstance(parsed, (list, tuple)) and len(parsed) == expected:
            return [str(t) for t in parsed]

    # 5) 终极兜底：引号未闭合/数组被截断时，抓出所有完整引号串
    #    （要求数量完全等于输入，且后面还有纯中文校验，安全）
    strs = re.findall(r'"([^"]*)"', s)
    if len(strs) == expected - 1:
        # 末尾少一个闭合引号（Unterminated string 的典型形态）→ 补上最后一段文本
        tail = s.rfind('"')
        frag = s[tail + 1 :].rstrip("] \t\r\n, 、")
        if frag.strip():
            strs.append(frag.strip())
    if len(strs) == expected and all(t.strip() for t in strs):
        print("[translate] JSON 严格解析失败，已用引号串兜底提取译文")
        return [t.strip() for t in strs]
    return None


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
        # repr 打印：裸换行 / \r / 全角引号等隐藏字符会原形毕露，便于排查
        print(f"[translate] LLM 返回正文: {content!r}")
        # 多层容错解析（围栏、裸控制字符、全角引号、引号未闭合），并强制等长
        parsed = _parse_llm_array(content, len(texts))
        if parsed is not None:
            return parsed
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
            items = _ocr_detect(ocr, img, lang)
        finally:
            _ocr_semaphore.release()
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
    # 剔除含网址/域名的水印推广气泡（不是对白，且会让中文校验永远失败）
    items = strip_watermark_items(items)

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
        _build_translated_bubble(img, it, translated[i])
        for i, it in enumerate(items)
    ]
    # 新图翻译完成：结果写入缓存，下次同图直接命中
    # 备用引擎结果覆盖写入（主引擎可能先写过空/低质量缓存）
    _cache_put(cache_key, str(image_url or ""), result, overwrite=(engine == "baidu"))
    print(f"[新图翻译并写入缓存] 引擎={engine} hash={cache_key[:16]}… 共 {len(result)} 条气泡")
    return result


# ===== 批量 OCR 接口：POST /api/ocr/batch =====
# 面向整章多图的纯识别（不走 LLM 翻译）：
# - 对象存储里的图一张一张串行取（绝不并发跑 OCR，信号量逐张持有）
# - 每张处理完立即 del + gc.collect() 释放内存，2核4G 服务器稳定
# - 保存每个文本框的四点坐标（按原图宽高归一化到 0~1）和文本为 JSON
# - 单张失败自动重试 2 次（共 3 次尝试），重试耗尽后记录错误继续下一张，不影响整批


def _parse_ocr_items_normalized(raw, img_w: int, img_h: int) -> list[dict]:
    """解析 OCR 原始结果 → 每个文本框的【四点坐标（按原图尺寸归一化 0~1）】+ 文本 + 置信度。

    兼容 PaddleOCR 3.x（dict: rec_texts/rec_polys/rec_scores）与 2.x（嵌套 list）。
    四点顺序与 rec_polys 一致：左上 → 右上 → 右下 → 左下。
    """
    items: list[dict] = []
    if raw is None:
        return items
    first = raw[0] if isinstance(raw, list) else raw
    if isinstance(first, dict):
        texts = _result_field(first, "rec_texts")
        polys = _result_field(first, "rec_polys")
        scores = _result_field(first, "rec_scores")
        for i, text in enumerate(texts):
            if i >= len(polys) or polys[i] is None:
                continue
            try:
                pts = [(float(p[0]), float(p[1])) for p in polys[i]]
            except Exception:
                continue
            if len(pts) < 4:
                continue
            norm = [
                [round(x / img_w, 6), round(y / img_h, 6)]
                for x, y in pts[:4]
            ]
            conf = None
            if i < len(scores):
                try:
                    conf = round(float(scores[i]), 4)
                except (TypeError, ValueError):
                    conf = None
            items.append({"poly": norm, "text": str(text), "conf": conf})
        return items

    # 2.x：[[poly, (text, conf)], ...]
    for entry in raw:
        try:
            poly, pair = entry[0], entry[1]
            pts = [(float(p[0]), float(p[1])) for p in poly]
            if len(pts) < 4:
                continue
            norm = [
                [round(x / img_w, 6), round(y / img_h, 6)]
                for x, y in pts[:4]
            ]
            conf = None
            try:
                conf = round(float(pair[1]), 4)
            except (TypeError, ValueError, IndexError):
                conf = None
            items.append({"poly": norm, "text": str(pair[0]), "conf": conf})
        except Exception:
            continue
    return items


@router.post("/api/ocr/batch")
async def ocr_batch(request: Request):
    """批量 OCR（纯识别，不调用大模型翻译）。

    请求：application/json
        {"image_urls": ["https://r2/.../p1.png", "..."], "lang": "en"}

    处理策略：
    - 一张一张串行下载 + 识别（不并发跑 OCR），逐张持有信号量保护资源
    - 每张处理完（成功或失败）立即 del + gc.collect() 释放内存
    - 单张失败自动重试 2 次（共 3 次尝试，间隔 1 秒），重试耗尽记录错误、继续下一张
    - 返回每个文本框的四点坐标（按原图尺寸归一化 0~1）与文本

    返回：
        {"lang": "en", "total": N, "success": M, "results": [
            {"index": 0, "image_url": "...", "ok": true, "attempts": 1,
             "image_width": 800, "image_height": 1200,
             "items": [{"poly": [[0.1,0.2],[0.5,0.2],[0.5,0.25],[0.1,0.25]],
                        "text": "Hello", "conf": 0.98}],
             "error": null},
            ...
        ]}
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="请用 application/json 提交")
    urls = body.get("image_urls")
    if not isinstance(urls, list) or not urls:
        raise HTTPException(status_code=400, detail="image_urls 必须是非空字符串数组")
    # 单次批量上限：防止极端长列表把串行队列拖到不可用
    urls = [str(u) for u in urls if str(u).strip()][:50]
    if not urls:
        raise HTTPException(status_code=400, detail="image_urls 里没有有效地址")

    lang = SUPPORTED_LANGS.get(str(body.get("lang") or "en").lower())
    if lang is None:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的语言，可选：{sorted(set(SUPPORTED_LANGS.values()))}",
        )

    try:
        ocr = _get_ocr(lang)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"OCR 引擎初始化失败：{exc}。首次运行需联网下载模型，或手动把模型放到 ~/.paddlex/official_models/ 目录",
        )

    results: list[dict] = []
    for idx, url in enumerate(urls):
        img_bytes: Optional[bytes] = None
        img = None
        raw = None
        ok = False
        attempts = 0
        error_msg: Optional[str] = None
        items: list[dict] = []
        img_w: Optional[int] = None
        img_h: Optional[int] = None

        # 首次尝试 + 重试 2 次（共 3 次）；任何一步失败都重试整张
        for attempt in (1, 2, 3):
            attempts = attempt
            try:
                # 串行取图：上一张彻底处理完才取下一张
                img_bytes = _fetch_image_bytes(url)
                img = _decode_image(img_bytes)
                img_h, img_w = img.shape[:2]
                acquired = _ocr_semaphore.acquire(timeout=_OCR_QUEUE_TIMEOUT)
                if not acquired:
                    raise RuntimeError(f"OCR 排队超时（{_OCR_QUEUE_TIMEOUT}s）")
                try:
                    raw = ocr.predict(img)
                finally:
                    _ocr_semaphore.release()
                items = _parse_ocr_items_normalized(raw, img_w, img_h)
                ok = True
                break
            except Exception as exc:
                error_msg = f"{type(exc).__name__}: {exc}"
                print(f"[ocr-batch] 第 {idx + 1} 张第 {attempt} 次尝试失败: {error_msg}")
                img = None
                img_bytes = None
                raw = None
                gc.collect()
                if attempt < 3:
                    time.sleep(1)

        results.append(
            {
                "index": idx,
                "image_url": url,
                "ok": ok,
                "attempts": attempts,
                "image_width": img_w,
                "image_height": img_h,
                "items": items,
                "error": None if ok else error_msg,
            }
        )
        print(
            f"[ocr-batch] 第 {idx + 1}/{len(urls)} 张完成: "
            f"{'成功' if ok else '失败'}(尝试 {attempts} 次) 识别 {len(items)} 个文本框"
        )

        # 单张处理结束：彻底释放本张内存再进入下一张
        img = None
        img_bytes = None
        raw = None
        gc.collect()

    success = sum(1 for r in results if r["ok"])
    print(f"[ocr-batch] 批次完成：{success}/{len(urls)} 张成功（lang={lang}）")
    return {"lang": lang, "total": len(urls), "success": success, "results": results}


# ===== 异步翻译任务队列（单 worker 串行，禁止并发 OCR）=====
# 由 main.py 的 TranslationTask 表充当队列；worker 逻辑聚合在本模块。

# 首次执行 + 最多 2 次重试 = 共 3 次尝试，超过即 failed 终态
TASK_MAX_ATTEMPTS = 3
# LLM 翻译批量：一次调用翻更多条，减少 HTTP 往返（20 条/页从 4 次调用降到 2 次）。
# 模型响应等待时间远大于 token 处理时间，加大批量是单页提速的最大头；
# 批内失败仍自动降级逐条翻译，质量保护不变。14 条约 1.5k 字符 payload 安全
TRANSLATE_BATCH_SIZE = max(1, int(os.getenv("TRANSLATE_BATCH_SIZE", "14") or "14"))
# 队列空转轮询间隔（秒）
_WORKER_IDLE_SLEEP = 1.5

_rr_last_user: Optional[int] = None  # 用户轮转游标：记录上一个被调度的用户
_rr_lock = threading.Lock()


def _llm_translate_serial(
    texts: list[str], user_api_key: str = "", batch_size: int = TRANSLATE_BATCH_SIZE
) -> Optional[list[str]]:
    """OCR 之后小批量串行翻译：按 batch_size 切片逐批调 LLM，批间不并发。

    每批沿用 _llm_translate 的中文校验 + 温度重试。整批失败时（常见于一批里混了
    拟声词/人名/单字母短句，模型返回原文或 JSON 少一条），自动**降级为逐条翻译**：
    单条短文本单独问模型成功率高得多，1 条难翻不再毁掉整页。
    逐条仍失败才整页返回 None（绝不写部分结果、不写脏译文）。
    """
    out: list[str] = []
    for start in range(0, len(texts), batch_size):
        chunk = texts[start : start + batch_size]
        batch_no = start // batch_size + 1
        translated = _llm_translate(chunk, user_api_key)
        if translated is not None and len(translated) != len(chunk):
            print(
                f"[task] 第 {batch_no} 批返回 {len(translated)} 条（应为 {len(chunk)}），按失败处理"
            )
            translated = None
        if translated is None:
            print(
                f"[task] 小批量翻译第 {batch_no} 批（{len(chunk)} 条）整批失败，"
                f"降级为逐条翻译重试: {chunk!r}"
            )
            recovered: list[str] = []
            for j, single in enumerate(chunk):
                one = _llm_translate([single], user_api_key)
                if one is None or len(one) != 1:
                    print(
                        f"[task] 第 {batch_no} 批第 {j + 1} 条逐条重试仍失败: {single!r}，整页放弃"
                    )
                    return None
                recovered.extend(one)
            translated = recovered
            print(f"[task] 第 {batch_no} 批逐条重试全部成功（{len(recovered)} 条）")
        out.extend(translated)
    return out


def pick_next_task(db):
    """按用户轮转（round-robin）取下一个 queued 任务，保证多用户公平。

    - queued 任务按 created_at 升序分组到各用户名下（每用户取最旧的一个）
    - 全局游标 _rr_last_user 记录上次调度的用户，本次从它的下一位用户开始转
    - 取到即标记 processing（由调用方 commit），天然防止重复取
    - 一次只取一个任务：worker 一张一张串行翻译（不凑组、不并发 OCR）
    返回任务对象或 None。"""
    global _rr_last_user
    from sqlalchemy import asc

    TranslationTask = _load_task_model()
    rows = (
        db.query(TranslationTask)
        .filter(TranslationTask.status == "queued")
        .order_by(asc(TranslationTask.created_at), asc(TranslationTask.id))
        .all()
    )
    if not rows:
        return None

    with _rr_lock:
        # 按用户分组保序（created_at 升序）
        by_user: dict = {}
        for r in rows:
            by_user.setdefault(r.user_id, []).append(r)
        users = list(by_user)
        start = 0
        if _rr_last_user in users:
            start = (users.index(_rr_last_user) + 1) % len(users)
        ordered = users[start:] + users[:start]
        chosen_user = ordered[0]
        chosen = by_user[chosen_user][0]
        _rr_last_user = chosen_user
    chosen.status = "processing"
    return chosen


def _load_task_model():
    """延迟加载 main.TranslationTask（避免模块加载期循环导入）。"""
    from main import TranslationTask

    return TranslationTask


def _finish_task(
    task_id: int,
    status: str,
    result_json: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    """任务状态回写（独立 session，避免长事务占用连接）。

    进入 done/failed 终态时同时清除暂存的 BYOK 密钥（用完即清，密钥不长期留库）。
    """
    from main import SessionLocal, TranslationTask

    db2 = SessionLocal()
    try:
        t = db2.query(TranslationTask).filter(TranslationTask.id == task_id).first()
        if t is None:
            return
        t.status = status
        if result_json is not None:
            t.result_json = result_json
        t.error = error
        if status in ("done", "failed"):
            t.api_key = None
        db2.commit()
    finally:
        db2.close()


def _task_fail_or_retry(task_id: int, error_msg: str) -> None:
    """任务失败处理：attempts 未超上限 → 重置回 queued 等下轮；超限 → failed 终态。"""
    from main import SessionLocal, TranslationTask

    print(f"[task] #{task_id} 执行失败: {error_msg}")
    db3 = SessionLocal()
    try:
        t = db3.query(TranslationTask).filter(TranslationTask.id == task_id).first()
        if t is not None:
            if (t.attempts or 0) < TASK_MAX_ATTEMPTS:
                t.status = "queued"
                t.error = error_msg
                print(f"[task] #{task_id} 将重试（第 {t.attempts}/{TASK_MAX_ATTEMPTS} 次）")
            else:
                t.status = "failed"
                t.error = error_msg
                t.api_key = None  # 终态清除暂存密钥（queued 重试时仍需保留）
                print(f"[task] #{task_id} 重试耗尽，标记 failed")
            db3.commit()
    finally:
        db3.close()


def _ocr_page(task_url: str, task_lang: str) -> dict:
    """单页 OCR 流水线：下载 → 解码 → 缓存检查 → OCR 推理 → 气泡过滤/合并/水印剔除。

    返回 dict：
      cached_json 非 None → 缓存命中（img/items 为 None，调用方直接写 done）
      items 为 []        → 无文字页（合法完成态，不写缓存）
    下载/解码/OCR 任何异常向上抛，由调用方统一走失败重试。
    线程安全：PaddleOCR 实例共享，并发数由 _ocr_semaphore 限制。
    """
    img_bytes = _fetch_image_bytes(task_url)
    img = _decode_image(img_bytes)
    img_h, img_w = img.shape[:2]

    # 缓存直取：同图已有【非空】合规中文译文 → 不再跑 OCR 与大模型。
    # 空数组缓存（上次 OCR 漏检 / 无文字页）不直接复用：重新识别一次，
    # 避免一次漏检（换模型参数、压缩画质波动）被永久缓存、重新翻译也无效。
    cache_key = hashlib.sha256(img_bytes).hexdigest()
    cached_json = _cache_get(cache_key)
    if cached_json:
        try:
            cached_rows = json.loads(cached_json)
            if (
                isinstance(cached_rows, list)
                and cached_rows  # 非空才命中
                and _result_all_chinese(cached_rows)
            ):
                return {
                    "cache_key": cache_key,
                    "img": None,
                    "items": None,
                    "img_w": img_w,
                    "img_h": img_h,
                    "cached_json": cached_json,
                }
        except Exception:
            pass

    ocr = _get_ocr(task_lang)
    # 信号量保护：worker 与旧同步接口 /api/translate 共用同一实例
    acquired = _ocr_semaphore.acquire(timeout=_OCR_QUEUE_TIMEOUT)
    if not acquired:
        raise RuntimeError(f"OCR 排队超时（{_OCR_QUEUE_TIMEOUT}s）")
    try:
        items = _ocr_detect(ocr, img, task_lang)
    finally:
        _ocr_semaphore.release()

    items = _filter_items(items, img)
    items = _merge_bubble_lines(items) if items else []
    items = strip_watermark_items(items)  # 水印/网址气泡不参与翻译，避免整页被拖垮
    return {
        "cache_key": cache_key,
        "img": img,
        "items": items,
        "img_w": img_w,
        "img_h": img_h,
        "cached_json": None,
    }


def _build_page_result(img, items: list, translated: list) -> list:
    """组装单页 result（气泡框 + 背景色 + 原文/译文）。"""
    return [
        _build_translated_bubble(img, it, translated[i])
        for i, it in enumerate(items)
    ]


def _translate_and_store(
    task_id: int,
    task_url: str,
    cache_key: str,
    img,
    items: list,
    task_api_key: str,
) -> None:
    """OCR 结果 → 小批量串行翻译（整批失败降级逐条）→ 译文回写 + 缓存。

    翻译失败抛 RuntimeError（区分「没 Key」与「调用/校验失败」），由调用方走失败重试。
    """
    texts = [it["text"] for it in items]
    print(
        f"[task] #{task_id} OCR 完成 {len(items)} 个气泡，开始小批量串行翻译"
        f"（BYOK={'有' if task_api_key else '无'}）"
    )
    translated = _llm_translate_serial(texts, user_api_key=task_api_key)
    if translated is None:
        # 区分「根本没 Key」与「Key 有但调用/校验失败」，便于按日志快速定位
        has_any_key = bool(
            task_api_key
            or os.getenv("ZHIPU_API_KEY", "").strip()
            or os.getenv("DEEPSEEK_API_KEY", "").strip()
        )
        if not has_any_key:
            raise RuntimeError(
                "翻译失败：未配置 API 密钥（前端未传 BYOK，服务器也未设置 "
                "ZHIPU_API_KEY / DEEPSEEK_API_KEY）"
            )
        raise RuntimeError(
            "翻译失败：大模型调用失败或译文未通过中文校验"
            "（Key 无效 / 额度不足 / 超时 / 返回了原文），详见服务器日志 [translate]"
        )

    result = _build_page_result(img, items, translated)
    result_json = json.dumps(result, ensure_ascii=False)
    _cache_put(cache_key, task_url, result)
    _finish_task(task_id, "done", result_json)
    print(f"[task] #{task_id} 完成：{len(result)} 条气泡已回写 result_json")


def run_translation_task(task_id: int) -> None:
    """执行单个翻译任务（一张一张串行）：下载 → OCR → 小批量串行翻译。

    - 每页处理完（成功或失败）立即 gc.collect() 释放内存
    - 失败 attempts+1：未超 TASK_MAX_ATTEMPTS 重置回 queued 等下轮，超限记 failed
    - 执行前查 TranslationCache，同图已有合规中文结果直接 done（省 OCR 与额度）
    """
    from main import SessionLocal, TranslationTask

    task_lang = "en"
    task_url = ""
    task_api_key = ""

    db = SessionLocal()
    try:
        task = db.query(TranslationTask).filter(TranslationTask.id == task_id).first()
        if task is None:
            return
        task.status = "processing"
        task.error = None
        task.attempts = (task.attempts or 0) + 1
        db.commit()
        task_lang = task.lang or "en"
        task_url = task.image_url
        task_api_key = (task.api_key or "").strip()
    finally:
        db.close()

    try:
        page = _ocr_page(task_url, task_lang)
        if page["cached_json"]:
            print(f"[task] #{task_id} 缓存命中 hash={page['cache_key'][:16]}…，直接完成")
            _finish_task(task_id, "done", page["cached_json"])
            return
        items = page["items"]
        if not items:
            # 图片本身无文字（或本次 OCR 漏检）→ 空数组是合法完成态，
            # 但【不写缓存】：下次仍有机会重新识别，不被一次漏检永久锁死
            _finish_task(task_id, "done", "[]")
            print(
                f"[task] #{task_id} 未识别到文字（{page['img_w']}x{page['img_h']}），"
                "空结果完成（不写缓存）"
            )
            return
        _translate_and_store(
            task_id, task_url, page["cache_key"], page["img"], items, task_api_key
        )
    except Exception as exc:
        _task_fail_or_retry(task_id, f"{type(exc).__name__}: {exc}")
    finally:
        # 单页处理结束：彻底释放内存
        gc.collect()


def _worker_tick() -> bool:
    """worker 单轮：轮转取一个 queued 任务并【一张一张】串行执行。取到并执行返回 True。"""
    from main import SessionLocal

    db = SessionLocal()
    task_id: Optional[int] = None
    try:
        chosen = pick_next_task(db)
        if chosen is None:
            return False
        db.commit()
        task_id = chosen.id
    finally:
        db.close()
    if task_id is not None:
        run_translation_task(task_id)
        return True
    return False


def _worker_loop() -> None:
    """单 worker 主循环：串行消费数据库队列，空队列时小睡。绝不并发跑 OCR。"""
    print("[worker] 翻译任务 worker 已启动（单页串行模式：一张一张翻译）")
    while True:
        try:
            executed = _worker_tick()
        except Exception as exc:
            print(f"[worker] 单轮异常（继续下一轮）: {type(exc).__name__}: {exc}")
            executed = False
        if not executed:
            time.sleep(_WORKER_IDLE_SLEEP)


def start_translation_worker() -> None:
    """启动唯一的队列 worker（幂等：重复调用只起一个线程）。"""
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    threading.Thread(target=_worker_loop, daemon=True, name="translate-worker").start()


_worker_started = False
