"""
AoliComic 后端服务入口（FastAPI + SQLAlchemy + SQLite）。

启动方式：
    cd backend
    uvicorn main:app --reload --port 8000

- 数据库：本地 SQLite，首次启动自动在 backend/ 目录下生成 app.db
- ORM：SQLAlchemy 2.0 风格（DeclarativeBase / Mapped / mapped_column）
- 健康检查：GET /api/health -> {"status": "ok"}
- 漫画列表：GET /api/comics -> JSON 数组（首次启动且表为空时自动插入前端展示的初始漫画）
- 用户系统：POST /api/auth/register 注册（bcrypt 哈希）、POST /api/auth/login 登录（返回 7 天有效期 JWT）
"""

import json
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt
import bcrypt
from pydantic import BaseModel
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    func,
    inspect,
    or_,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

# ===== 数据库配置（Railway PostgreSQL / 本地 SQLite 双兼容） =====
# - Railway：环境变量 DATABASE_URL 注入 PostgreSQL 连接串（postgres://...）
# - 本地：没有 DATABASE_URL 时默认使用 SQLite（DATA_DIR 目录下的 app.db）
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)  # Volume 挂载点不存在时自动创建
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite:///{DATA_DIR / 'app.db'}"

# 兼容并统一 PostgreSQL 前缀：
# - Railway 注入的旧式 postgres:// → SQLAlchemy 只认 postgresql://
# - 显式指定 +psycopg2 驱动，避免 SQLAlchemy 默认方言解析到 psycopg(3) 而报
#   "No module named 'psycopg'"（psycopg2-binary 才是 requirements 里装的驱动）
_PG_PREFIXES = {
    "postgres://": "postgresql+psycopg2://",
    "postgresql://": "postgresql+psycopg2://",
    "postgresql+psycopg://": "postgresql+psycopg2://",
}
for _prefix, _replacement in _PG_PREFIXES.items():
    if SQLALCHEMY_DATABASE_URL.startswith(_prefix):
        SQLALCHEMY_DATABASE_URL = _replacement + SQLALCHEMY_DATABASE_URL[len(_prefix):]
        break

# SQLite 需要关闭同线程检查（uvicorn 的线程池访问）；PostgreSQL 等无需该项
_engine_kwargs = (
    {"connect_args": {"check_same_thread": False}} if SQLALCHEMY_DATABASE_URL.startswith("sqlite") else {}
)
engine = create_engine(SQLALCHEMY_DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)

# ===== 认证配置 =====
# JWT 签名密钥：Railway Variables 里必须设置 SECRET_KEY（随机长字符串）；
# 缺省值仅用于本地开发，生产环境不设置会导致 Token 可被伪造
SECRET_KEY = os.getenv("SECRET_KEY", "aolicom-dev-secret-change-me-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 7  # Token 有效期：7 天

# 密码哈希：直接使用原生 bcrypt（passlib 1.7.4 与新版 bcrypt 的兼容层存在
# "password cannot be longer than 72 bytes" 误报 bug，绕过它彻底规避）
def hash_password(plain: str) -> str:
    """bcrypt 哈希，绝不存明文。"""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """校验密码（兼容 passlib 时代生成的 $2b$ 哈希）。"""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


# ===== ORM 基类 =====
class Base(DeclarativeBase):
    pass


# ===== 用户表：真实用户系统（替换前端 localStorage 假登录） =====
class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(120), unique=True, index=True)
    # bcrypt 哈希后的密码（绝不明文存储）
    password_hash: Mapped[str | None] = mapped_column(String(128))
    # 角色：'user' 普通用户 / 'admin' 管理员（启动时自动把 AO 提升为 admin）
    role: Mapped[str] = mapped_column(String(20), default="user")
    # ===== 用户资料（头像/背景可为 dataURL，用 Text 存储不受长度限制） =====
    avatar_url: Mapped[str | None] = mapped_column(Text)
    cover_url: Mapped[str | None] = mapped_column(Text)
    signature: Mapped[str | None] = mapped_column(String(200))
    gender: Mapped[str | None] = mapped_column(String(10))
    birthday: Mapped[str | None] = mapped_column(String(20))
    # 个人标签：JSON 数组字符串，如 '["悬疑", "热血"]'
    tags: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ===== 帖子表：广场/空间动态（author_id 关联 users.id） =====
class Post(Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    content: Mapped[str | None] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(Text)
    # 多图：JSON 数组字符串（如 '["u1","u2"]'）；旧数据为空时由序列化层回退 image_url
    image_urls: Mapped[str | None] = mapped_column(Text)
    # 被 @ 的用户 ID（当前版本仅允许 @ 管理员）；正文后显示紫色 @ 徽标并触发 mention 通知
    mention_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # 点赞计数：收到赞时 +1（防重复由 notifications 表的 like 记录保证）
    likes: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # relationship：post.author.username 直接拿到作者用户名
    # （posts→users 有 author_id / mention_user_id 两条外键路径，两边都必须显式指定）
    author: Mapped["User"] = relationship("User", foreign_keys=[author_id])
    # 被 @ 的用户（与 author 是同一张表的两个外键，必须显式指定 foreign_keys）
    mention_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[mention_user_id]
    )


# ===== 待审核投稿表：用户投稿 → 管理员审核 → 正式 Comic =====
class PendingComic(Base):
    __tablename__ = "pending_comics"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(100), index=True)
    author: Mapped[str] = mapped_column(String(50))
    cover_url: Mapped[str | None] = mapped_column(Text)
    # 标签以 JSON 数组字符串存储
    tags: Mapped[str] = mapped_column(String(200), default="[]")
    intro: Mapped[str | None] = mapped_column(Text)
    need_translation: Mapped[bool] = mapped_column(Boolean, default=False)
    submitter_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    # 待审核章节数据：JSON 数组字符串，如 '[{"title":"第1话","images":["data:..."]}]'
    chapters: Mapped[str | None] = mapped_column(Text)
    # 投稿类型：'new'=新建整本 / 'append'=为已有漫画追加章节
    submit_type: Mapped[str] = mapped_column(String(20), default="new")
    # 追加模式下的目标漫画 ID（new 模式为空）
    target_comic_id: Mapped[int | None] = mapped_column(Integer, index=True)
    # 审核通过后生成的正式漫画 ID（『我的投稿』显示最终封面/书名用）
    approved_comic_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # relationship：pending.submitter.username 直接拿到投稿人用户名
    submitter: Mapped["User"] = relationship("User")


# ===== 请求体模型 =====
class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class ProfileUpdate(BaseModel):
    """资料更新请求：所有字段均可选，只更新传入的字段。"""
    avatar_url: str | None = None
    cover_url: str | None = None
    signature: str | None = None
    tags: list[str] | None = None  # 个人标签数组；入库前序列化为 JSON 字符串
    gender: str | None = None
    birthday: str | None = None


class CreatePostRequest(BaseModel):
    """发帖请求：文字与图片至少一项。"""
    content: str | None = None
    # 旧版单图字段：保留兼容旧客户端；新版一律传 images 数组
    image_url: str | None = None
    # 多图（最多 9 张，R2 公网 URL 列表）
    images: list[str] = []
    # @ 的用户名：当前版本仅支持 @ 管理员账号（AO）
    mention: str | None = None


class ChapterInput(BaseModel):
    """投稿的章节：章名 + 内页图片列表。"""
    title: str = ""
    images: list[str] = []


class SubmitComicRequest(BaseModel):
    """投稿请求：submit_type 必传（new=新建整本 / append=追加章节）。"""
    title: str
    author: str = ""
    cover_url: str | None = None
    tags: list[str] = []
    intro: str | None = None
    need_translation: bool = False
    chapters: list[ChapterInput] = []
    # 投稿类型：new / append（append 时 target_comic_id 必填）
    submit_type: str = "new"
    target_comic_id: int | None = None


class ReviewRequest(BaseModel):
    """审核请求：action 只能是 approve（通过）或 reject（驳回）。"""
    action: str


# ===== 漫画表：首页数据来源 =====
class Comic(Base):
    __tablename__ = "comics"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    author: Mapped[str] = mapped_column(String(50))
    cover_image: Mapped[str] = mapped_column(String(500))
    # 标签以 JSON 数组字符串存储，如 '["科幻", "热血"]'
    tags: Mapped[str] = mapped_column(String(200), default="[]")
    # 简介：投稿时填写的 intro；没写就是 NULL（前端显示『作者很懒，暂无简介』）
    description: Mapped[str | None] = mapped_column(Text)
    # 是否需要 AI 翻译（用户投稿时选择；原生漫画为 NULL → 前端默认显示翻译按钮）
    need_translation: Mapped[bool | None] = mapped_column(Boolean)
    # 投稿人 user.id（审核通过时写入，用于『我的投稿』查询；老数据为 NULL）
    submitter_id: Mapped[int | None] = mapped_column(Integer, index=True)
    # 一部漫画包含多章（一对多）；审核发布的漫画才有章节
    chapters: Mapped[list["Chapter"]] = relationship(
        "Chapter", back_populates="comic", cascade="all, delete-orphan", order_by="Chapter.id"
    )


# ===== 章节表：一章属于一部漫画（多对一），内页以 JSON 字符串存储 =====
class Chapter(Base):
    __tablename__ = "chapters"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(100), default="第1话")
    comic_id: Mapped[int] = mapped_column(ForeignKey("comics.id"), index=True)
    # 章节内页图片 URL/dataURL 数组，如 '["data:image/png;base64,..."]'
    images: Mapped[str] = mapped_column(Text, default="[]")
    # relationship：chapter.comic.title 反查所属漫画
    comic: Mapped["Comic"] = relationship("Comic", back_populates="chapters")


# ===== 收藏表：用户 × 漫画 收藏关系（真实收藏数与收藏状态来源） =====
class Collection(Base):
    __tablename__ = "collections"
    __table_args__ = (UniqueConstraint("user_id", "comic_id", name="uq_collection_user_comic"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # 收藏人
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # 被收藏的漫画
    comic_id: Mapped[int] = mapped_column(ForeignKey("comics.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ===== 翻译结果缓存表：同一张图（按内容 SHA256 唯一）不重复跑 OCR + 大模型 =====
class TranslationCache(Base):
    __tablename__ = "translation_cache"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # 图片内容 SHA256 哈希（唯一索引）：data:URL / HTTP URL / 上传文件统一按字节哈希，
    # 相同图片无论 URL 形式如何都命中同一条缓存
    image_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 原始图片标识（data:URL 过长时截断存储，仅作人工排查参考，不参与查询）
    image_url: Mapped[str] = mapped_column(String(2048), default="")
    # 翻译接口的完整返回 JSON（[{box, bg_color, original, translated}, ...]）
    result_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ===== 异步翻译任务表（数据库队列）：幂等键 comic_id+page_id+target_lang =====
class TranslationTask(Base):
    __tablename__ = "translation_tasks"
    __table_args__ = (
        UniqueConstraint("comic_id", "page_id", "target_lang", name="uq_translate_task"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    comic_id: Mapped[int] = mapped_column(Integer, index=True)
    # 一页的唯一标识（前端用 "{chapterId}:{页下标}"）
    page_id: Mapped[str] = mapped_column(String(128), index=True)
    # 目标语言（目前固定 zh）；OCR 源语言单独存 lang
    target_lang: Mapped[str] = mapped_column(String(12), default="zh")
    lang: Mapped[str] = mapped_column(String(12), default="en")
    # 该页图片地址（对象存储公网 URL），worker 执行时下载
    image_url: Mapped[str] = mapped_column(Text)
    # queued 排队 / processing 执行中 / done 完成 / failed 重试耗尽
    status: Mapped[str] = mapped_column(String(12), default="queued", index=True)
    # 已执行次数（首次 + 最多 2 次重试 = 3）
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # 完成后的完整结果（[{box, bg_color, original, translated}, ...]）
    result_json: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    # 用户 BYOK 密钥（前端填的智谱 Key）：异步 worker 执行时需要它。
    # 仅任务进行中暂存，进入 done/failed 终态时立即清空，日志永不输出明文。
    api_key: Mapped[str | None] = mapped_column(Text)
    # 批量组标识：同一章相邻 3 页共用一个 batch_id，worker 凑组后
    # 组内并发 OCR + 合并成一次 LLM 调用（大幅提速省钱）；单页提交时为空。
    batch_id: Mapped[str | None] = mapped_column(Text)
    # 提交人：用于「每用户同时最多 1 个进行中任务」与调度轮转公平性
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


# 每用户同时进行中任务上限（一张一张串行翻译：同时只处理 1 个任务）
TASK_LIMIT_PER_USER = 1


# ===== 阶段一：先建表，再执行任何模块级数据库查询 =====
# 下面 275 行起的轻量迁移、description 回填、AO 管理员初始化都是 import 时
# 直接执行的代码，会查询 comics / users / pending_comics 等表。
# Railway PostgreSQL 是全新空库，若等到文件末尾才 create_all 会先报
# "关系 comics 不存在"（UndefinedTable）。此处先建当前已定义的 7 张表。
Base.metadata.create_all(bind=engine)

# 轻量迁移：旧版 users 表缺列时启动自动补列（这样已有的 app.db 不需要删除重建）
_inspector = inspect(engine)
if _inspector.has_table("users"):
    _user_cols = {col["name"] for col in _inspector.get_columns("users")}
    _add_column_sql = {
        "email": "ALTER TABLE users ADD COLUMN email VARCHAR(120)",
        "password_hash": "ALTER TABLE users ADD COLUMN password_hash VARCHAR(128)",
        "avatar_url": "ALTER TABLE users ADD COLUMN avatar_url TEXT",
        "cover_url": "ALTER TABLE users ADD COLUMN cover_url TEXT",
        "signature": "ALTER TABLE users ADD COLUMN signature VARCHAR(200)",
        "gender": "ALTER TABLE users ADD COLUMN gender VARCHAR(10)",
        "birthday": "ALTER TABLE users ADD COLUMN birthday VARCHAR(20)",
        "tags": "ALTER TABLE users ADD COLUMN tags TEXT DEFAULT '[]'",
        "role": "ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'",
    }
    with engine.begin() as _conn:
        for _col, _sql in _add_column_sql.items():
            if _col not in _user_cols:
                _conn.execute(text(_sql))

# 旧版 comics 表缺 need_translation 列时自动补列
if _inspector.has_table("comics"):
    _comic_cols = {col["name"] for col in _inspector.get_columns("comics")}
    with engine.begin() as _conn:
        if "need_translation" not in _comic_cols:
            _conn.execute(text("ALTER TABLE comics ADD COLUMN need_translation BOOLEAN"))

# 旧版 pending_comics 表缺列时自动补列（chapters / submit_type / target_comic_id）
if _inspector.has_table("pending_comics"):
    _pc_cols = {col["name"] for col in _inspector.get_columns("pending_comics")}
    _pc_new_cols = {
        "chapters": "ALTER TABLE pending_comics ADD COLUMN chapters TEXT",
        "submit_type": "ALTER TABLE pending_comics ADD COLUMN submit_type VARCHAR(20) DEFAULT 'new'",
        "target_comic_id": "ALTER TABLE pending_comics ADD COLUMN target_comic_id INTEGER",
    }
    with engine.begin() as _conn:
        for _col_name, _ddl in _pc_new_cols.items():
            if _col_name not in _pc_cols:
                _conn.execute(text(_ddl))

# 旧版 posts 表缺 likes / image_urls / mention_user_id 列时自动补列
if _inspector.has_table("posts"):
    _post_cols = {col["name"] for col in _inspector.get_columns("posts")}
    with engine.begin() as _conn:
        if "likes" not in _post_cols:
            _conn.execute(text("ALTER TABLE posts ADD COLUMN likes INTEGER DEFAULT 0"))
        if "image_urls" not in _post_cols:
            _conn.execute(text("ALTER TABLE posts ADD COLUMN image_urls TEXT"))
        if "mention_user_id" not in _post_cols:
            _conn.execute(text("ALTER TABLE posts ADD COLUMN mention_user_id INTEGER"))

# 旧版 comics 表缺 submitter_id（投稿人）列时自动补列
if _inspector.has_table("comics"):
    _comic_cols = {col["name"] for col in _inspector.get_columns("comics")}
    with engine.begin() as _conn:
        if "submitter_id" not in _comic_cols:
            _conn.execute(text("ALTER TABLE comics ADD COLUMN submitter_id INTEGER"))
        # 真实简介：投稿时写的 intro，老数据为 NULL
        if "description" not in _comic_cols:
            _conn.execute(text("ALTER TABLE comics ADD COLUMN description TEXT"))

# 旧版 pending_comics 表缺 approved_comic_id 列时自动补列
if _inspector.has_table("pending_comics"):
    _pc_cols = {col["name"] for col in _inspector.get_columns("pending_comics")}
    with engine.begin() as _conn:
        if "approved_comic_id" not in _pc_cols:
            _conn.execute(text("ALTER TABLE pending_comics ADD COLUMN approved_comic_id INTEGER"))

# 旧版 notifications 表缺 image_url（评论附图）列时自动补列
if _inspector.has_table("notifications"):
    _noti_cols2 = {col["name"] for col in _inspector.get_columns("notifications")}
    with engine.begin() as _conn:
        if "image_url" not in _noti_cols2:
            _conn.execute(text("ALTER TABLE notifications ADD COLUMN image_url TEXT"))

# 旧版 comments（漫画评论）表缺 image_url（评论附图）列时自动补列
if _inspector.has_table("comments"):
    _comment_cols = {col["name"] for col in _inspector.get_columns("comments")}
    with engine.begin() as _conn:
        if "image_url" not in _comment_cols:
            _conn.execute(text("ALTER TABLE comments ADD COLUMN image_url TEXT"))

# 已部署过的服务器：translation_tasks 表缺 api_key（BYOK 密钥）/ batch_id（批量组）
# 列时自动补列（create_all 不会给已存在的表加列，不补则 worker 查询直接报错）
if _inspector.has_table("translation_tasks"):
    _tt_cols = {col["name"] for col in _inspector.get_columns("translation_tasks")}
    with engine.begin() as _conn:
        if "api_key" not in _tt_cols:
            _conn.execute(text("ALTER TABLE translation_tasks ADD COLUMN api_key TEXT"))
        if "batch_id" not in _tt_cols:
            _conn.execute(text("ALTER TABLE translation_tasks ADD COLUMN batch_id TEXT"))

# 旧版 notifications 表：post_id 为 NOT NULL（审核通知不属于帖子，需要可空）→ 重建表；
# 同时补 is_read（未读红点）。SQLite 不支持改列约束，只能建新表搬数据。
if _inspector.has_table("notifications"):
    _noti_cols = {col["name"]: col for col in _inspector.get_columns("notifications")}
    with engine.begin() as _conn:
        if _noti_cols.get("post_id") is not None and not _noti_cols["post_id"]["nullable"]:
            _conn.execute(text("ALTER TABLE notifications RENAME TO notifications_old"))
            _conn.execute(
                text(
                    """
                    CREATE TABLE notifications (
                        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                        type VARCHAR(20) NOT NULL,
                        actor_id INTEGER NOT NULL REFERENCES users(id),
                        recipient_id INTEGER NOT NULL REFERENCES users(id),
                        post_id INTEGER REFERENCES posts(id),
                        content TEXT,
                        is_read BOOLEAN DEFAULT 0,
                        created_at DATETIME NOT NULL
                    )
                    """
                )
            )
            _conn.execute(
                text(
                    """
                    INSERT INTO notifications (id, type, actor_id, recipient_id, post_id, content, created_at)
                    SELECT id, type, actor_id, recipient_id, post_id, content, created_at
                    FROM notifications_old
                    """
                )
            )
            _conn.execute(text("DROP TABLE notifications_old"))
            _conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_type ON notifications (type)"))
            _conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_actor_id ON notifications (actor_id)"))
            _conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_recipient_id ON notifications (recipient_id)"))
            _conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_post_id ON notifications (post_id)"))
            print("[migrate] notifications 表已重建（post_id 可空 + is_read）")
        elif "is_read" not in _noti_cols:
            _conn.execute(text("ALTER TABLE notifications ADD COLUMN is_read BOOLEAN DEFAULT 0"))

# 历史数据回填：老漫画的 description 为空时，用它对应投稿记录里真实填写的 intro 补上
# （只回填真实投稿数据，绝不写入任何假简介）
with SessionLocal() as _db:
    _filled = 0
    for _c in _db.query(Comic).filter(Comic.description.is_(None)).all():
        _p = (
            _db.query(PendingComic)
            .filter(PendingComic.approved_comic_id == _c.id, PendingComic.intro.isnot(None))
            .first()
        )
        if _p is not None and (_p.intro or "").strip():
            _c.description = _p.intro.strip()
            _filled += 1
    if _filled:
        _db.commit()
        print(f"[migrate] 已用投稿简介回填 {_filled} 本漫画的 description")

# 初始化逻辑：每次启动强制把核心账号提升为管理员（用户名 AO + 指定邮箱列表）
ADMIN_BOOTSTRAP_EMAILS = {"2426563458@qq.com"}

with SessionLocal() as _db:
    _promoted: list[str] = []
    _ao = _db.query(User).filter(User.username == "AO").first()
    if _ao is not None and _ao.role != "admin":
        _ao.role = "admin"
        _promoted.append(_ao.username)
    if ADMIN_BOOTSTRAP_EMAILS:
        for _u in _db.query(User).filter(User.email.in_(ADMIN_BOOTSTRAP_EMAILS)).all():
            if _u.role != "admin":
                _u.role = "admin"
                _promoted.append(f"{_u.username}({_u.email})")
    if _promoted:
        _db.commit()
        print(f"[init] 已提升管理员: {', '.join(_promoted)}")

# 注意：不再自动插入种子/假漫画。comics 表内容完全来自真实投稿审核与后续管理操作，
# 数据库为空时前端展示『暂无漫画』空状态。

# ===== 数据库会话依赖 =====
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """解析请求头 Authorization: Bearer <token>，返回当前登录用户。"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    token = authorization[len("Bearer "):]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str | None = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")
    if not username:
        raise HTTPException(status_code=401, detail="Token 无效")
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def get_optional_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User | None:
    """可选登录：带合法 Token 返回用户，未登录/Token 无效返回 None（不抛 401）。

    用于「游客也能看，但登录用户额外拿到自己状态」的接口，如收藏数 + 我是否已收藏。
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[len("Bearer "):]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str | None = payload.get("sub")
    except JWTError:
        return None
    if not username:
        return None
    return db.query(User).filter(User.username == username).first()


def user_profile(user: User) -> dict:
    """把 User ORM 对象序列化为前端所需的资料 JSON（绝不含密码）。
    tags 数据库中存 JSON 字符串，返回前必须解析成数组。"""
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "role": user.role,
        "avatar_url": user.avatar_url,
        "cover_url": user.cover_url,
        "signature": user.signature,
        "gender": user.gender,
        "birthday": user.birthday,
        "tags": json.loads(user.tags or "[]"),
    }


def pending_to_dict(p: PendingComic) -> dict:
    """把 PendingComic ORM 对象序列化为前端所需的 JSON（relationship 带出投稿人）。"""
    return {
        "id": p.id,
        "title": p.title,
        "author": p.author,
        "cover_url": p.cover_url,
        "tags": json.loads(p.tags or "[]"),
        "intro": p.intro,
        "need_translation": bool(p.need_translation),
        "submitter_id": p.submitter_id,
        "submitter_username": p.submitter.username,
        "status": p.status,
        "chapters": json.loads(p.chapters or "[]"),
        "submit_type": p.submit_type or "new",
        "target_comic_id": p.target_comic_id,
        "created_at": p.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }


def require_admin(user: User = Depends(get_current_user)) -> User:
    """管理员权限校验：role != 'admin' 直接 403。"""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限：需要管理员账号")
    return user


def _post_image_urls(post: Post) -> list[str]:
    """帖子全部配图 URL：优先 image_urls JSON 数组，旧数据回退单图 image_url。"""
    if post.image_urls:
        try:
            arr = json.loads(post.image_urls)
            if isinstance(arr, list) and arr:
                return [str(u) for u in arr if u]
        except Exception:
            pass
    return [post.image_url] if post.image_url else []


def post_to_dict(post: Post) -> dict:
    """把 Post ORM 对象序列化为前端所需的 JSON（relationship 带出作者用户名）。

    created_at 在库里以 naive UTC 存储，序列化时补上 Z 后缀（ISO UTC），
    浏览器 new Date() 会自动换算为用户本地时区，避免出现"8小时前"时区偏差。
    """
    return {
        "id": post.id,
        "content": post.content,
        "image_url": post.image_url,
        "image_urls": _post_image_urls(post),
        "mention_username": post.mention_user.username if post.mention_user else None,
        "author_id": post.author_id,
        "author_username": post.author.username,
        "likes": post.likes,
        "created_at": post.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }


# ===== FastAPI 应用 =====
app = FastAPI(title="AoliComic Backend", version="0.1.0")

# ===== 跨域配置：开发阶段先允许所有来源（必须在路由定义之前添加） =====
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 开发阶段：允许所有来源
    allow_credentials=True,
    allow_methods=["*"],  # 全部请求方法
    allow_headers=["*"],  # 全部请求头
)

# ===== OCR 漫画翻译（PaddleOCR Mobile + 百度备用 + OpenCV 取色 + GLM/DeepSeek）=====
from ocr_translate import router as translate_router  # noqa: E402
from ocr_translate import TASK_MAX_ATTEMPTS, start_translation_worker  # noqa: E402

app.include_router(translate_router)


# ===== 异步翻译任务接口：幂等提交 + 轮询状态 =====
class TranslationTaskRequest(BaseModel):
    """提交一页翻译任务。page_id 唯一标识一页（如 "{chapterId}:{下标}"）。"""

    comic_id: int
    page_id: str
    image_url: str
    # OCR 源语言（en/ko/japan/ch）
    lang: str = "en"
    # 目标语言（目前固定 zh）
    target_lang: str = "zh"
    # BYOK：用户自己的智谱 API Key（为空时 worker 降级服务器环境变量 Key）
    api_key: str = ""
    # 批量组标识：同一章相邻页共用（如 "12:3:g0"），worker 凑组并发 OCR + 合并翻译
    batch_id: str = ""
    # force=true：done 任务也重置排队重跑（对应前端「重新翻译」）
    force: bool = False


@app.post("/api/translate/tasks")
def create_translation_task(
    req: TranslationTaskRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """幂等提交翻译任务（异步，只返回 task_id，前端轮询状态）。

    - 已 done（且非 force）→ 直接返回结果，不重复执行
    - queued / processing → 直接返回 task_id，绝不重复入队
    - failed 且未超重试上限（或 force）→ 重置回 queued
    - 每用户同时最多 TASK_LIMIT_PER_USER 个进行中任务（与前端 3 张一组对齐）
    """
    target_lang = (req.target_lang or "zh").strip().lower() or "zh"
    page_id = (req.page_id or "").strip()[:128]
    image_url = (req.image_url or "").strip()
    # BYOK：用户 Key 随任务暂存（worker 执行时用），为空则降级服务器环境变量 Key
    api_key = (req.api_key or "").strip() or None
    # 批量组标识（同一章相邻 3 页共用），worker 按它凑组并发 OCR + 合并翻译
    batch_id = (req.batch_id or "").strip()[:128] or None
    if not page_id:
        raise HTTPException(status_code=400, detail="page_id 不能为空")
    if not image_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="image_url 必须是 http(s) 公网地址（请先上传对象存储）")

    task = (
        db.query(TranslationTask)
        .filter(
            TranslationTask.comic_id == req.comic_id,
            TranslationTask.page_id == page_id,
            TranslationTask.target_lang == target_lang,
        )
        .first()
    )
    if task is not None:
        if task.status == "done" and not req.force:
            result = []
            try:
                result = json.loads(task.result_json or "[]")
            except Exception:
                result = []
            return {"task_id": task.id, "status": "done", "result": result}
        if task.status in ("queued", "processing"):
            # 幂等：直接返回同一 task_id，绝不重复入队；顺手补上 Key 与组标识
            # （旧前端提交的任务没有 batch_id，新前端重进页面时补齐即可凑组）
            # 预热任务（系统 user_id=0）正被用户等待 → 归属到该用户，调度优先级随之提升
            if task.status == "queued" and task.user_id == PRETRANSLATE_USER_ID:
                task.user_id = user.id
            if api_key or batch_id:
                if api_key:
                    task.api_key = api_key
                if batch_id:
                    task.batch_id = batch_id
                db.commit()
            return {"task_id": task.id, "status": task.status}
        # failed（或 force 重译 done）→ 用户主动重新提交即开启新一轮：
        # attempts 归零，worker 内最多再自动重试 2 次（不会无限重试，也不会永久卡在报错页）
        task.status = "queued"
        task.error = None
        task.attempts = 0
        task.image_url = image_url  # 图片可能换源（重新上传）
        task.lang = (req.lang or "en").strip().lower() or "en"
        task.api_key = api_key
        task.batch_id = batch_id
        db.commit()
        db.refresh(task)
        return {"task_id": task.id, "status": "queued"}

    # 新任务：每用户同时最多 3 个进行中（与前端 3 张一组批量提交对齐）
    busy_count = (
        db.query(TranslationTask)
        .filter(
            TranslationTask.user_id == user.id,
            TranslationTask.status.in_(("queued", "processing")),
        )
        .count()
    )
    if busy_count >= TASK_LIMIT_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=f"你有 {busy_count} 个翻译任务进行中，等这批完成后再提交",
        )
    task = TranslationTask(
        comic_id=req.comic_id,
        page_id=page_id,
        target_lang=target_lang,
        lang=(req.lang or "en").strip().lower() or "en",
        image_url=image_url,
        status="queued",
        user_id=user.id,
        api_key=api_key,
        batch_id=batch_id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return {"task_id": task.id, "status": "queued"}


@app.get("/api/translate/tasks/{task_id}")
def get_translation_task(task_id: int, db: Session = Depends(get_db)):
    """轮询任务状态：done 时带完整结果，failed 时带错误信息。"""
    task = db.query(TranslationTask).filter(TranslationTask.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    resp: dict = {
        "task_id": task.id,
        "status": task.status,
        "attempts": task.attempts,
    }
    if task.status == "done":
        try:
            resp["result"] = json.loads(task.result_json or "[]")
        except Exception:
            resp["result"] = []
    if task.status == "failed":
        resp["error"] = task.error
    return resp


# 启动时后台预热 OCR 模型（加载常驻内存，避免首个用户请求承担模型加载等待）。
# 后台线程执行，不阻塞 uvicorn 启动；失败仅打日志，首次请求时自动重试（懒加载兜底）。
# OCR_WARMUP=0 可关闭（如调试时不希望启动就加载 paddle）。
@app.on_event("startup")
def _warmup_ocr_on_startup() -> None:
    if os.getenv("OCR_WARMUP", "1").strip().lower() in ("0", "false", "off"):
        print("[warmup] OCR_WARMUP=0，跳过 OCR 模型预热")
        return

    def _run() -> None:
        try:
            from ocr_translate import warmup_ocr  # noqa: E402

            warmup_ocr("en")  # 前端默认语言，预热最高频的引擎
        except Exception as exc:
            print(f"[warmup] OCR 预热线程异常（不影响服务）: {type(exc).__name__}: {exc}")

    threading.Thread(target=_run, daemon=True, name="ocr-warmup").start()


@app.on_event("startup")
def _start_translation_worker_on_startup() -> None:
    """启动异步翻译队列 worker（全局唯一，单线程串行消费）。

    崩溃/重启恢复：上次遗留的 processing 任务重置回 queued 重新排队
    （attempts 已计数，超限任务不会被无限重跑）。
    """
    reset = 0
    try:
        with SessionLocal() as db:
            reset = (
                db.query(TranslationTask)
                .filter(TranslationTask.status == "processing")
                .update({"status": "queued"}, synchronize_session=False)
            )
            db.commit()
        if reset:
            print(f"[worker] 已把 {reset} 个中断的 processing 任务重置回 queued")
    except Exception as exc:
        print(f"[worker] 恢复中断任务失败（不影响启动）: {type(exc).__name__}: {exc}")
    start_translation_worker()


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    """健康检查：同时验证 SQLite 连接可用（users 表可查询）。"""
    user_count = db.query(User).count()
    return {"status": "ok"}


@app.get("/api/db-check")
def db_check(db: Session = Depends(get_db)):
    """数据库连通性示例：返回 users 表行数，证明 ORM 与 app.db 工作正常。"""
    user_count = db.query(User).count()
    return {"status": "ok", "database": "app.db", "users_count": user_count}


@app.get("/api/tags")
def get_tags(db: Session = Depends(get_db)):
    """标签聚合接口：收集所有已上架漫画的标签，去重后返回（首项固定『全部』）。"""
    comics = db.query(Comic).all()
    tag_set: set[str] = set()
    for c in comics:
        for tag in json.loads(c.tags or "[]"):
            tag = (tag or "").strip()
            if tag:
                tag_set.add(tag)
    # 『全部』放最前，其余按名称排序保证稳定
    return {"tags": ["全部"] + sorted(tag_set)}


@app.get("/api/comics")
def get_comics(db: Session = Depends(get_db)):
    """漫画列表接口：从数据库查询全部漫画，返回 JSON 数组（含 AI 翻译标记）。"""
    comics = db.query(Comic).order_by(Comic.id).all()
    return [
        {
            "id": c.id,
            "title": c.title,
            "author": c.author,
            "coverImage": c.cover_image,
            "tags": json.loads(c.tags or "[]"),
            "needTranslation": c.need_translation,
            # 章节列表：id 格式 "{comicId}-{chapterId}"，pages = 内页数量
            "chapters": [
                {
                    "id": f"{c.id}-{ch.id}",
                    "title": ch.title,
                    "pages": len(json.loads(ch.images or "[]")),
                }
                for ch in c.chapters
            ],
        }
        for c in comics
    ]


@app.get("/api/collections")
def list_my_collections(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """我的书架：当前 Token 用户真实收藏的漫画列表（按收藏时间倒序）。

    - 必须登录：未登录 401
    - 只查 collections 表中 user_id == 当前用户 的记录，join comics 取真实书籍信息
    - 不再依赖前端 localStorage 的假数据，返回空数组时前端显示空状态
    """
    rows = (
        db.query(Comic)
        .join(Collection, Collection.comic_id == Comic.id)
        .filter(Collection.user_id == user.id)
        .order_by(Collection.id.desc())
        .all()
    )
    return [
        {
            "id": c.id,
            "title": c.title,
            "author": c.author,
            "coverImage": c.cover_image,
            "tags": json.loads(c.tags or "[]"),
            "description": c.description,
            # 真实收藏总数（这本书被多少人收藏）
            "favorites": db.query(Collection).filter(Collection.comic_id == c.id).count(),
            "chapters": [
                {
                    "id": f"{c.id}-{ch.id}",
                    "title": ch.title,
                    "pages": len(json.loads(ch.images or "[]")),
                }
                for ch in c.chapters
            ],
        }
        for c in rows
    ]


# ===== 评论表：一条评论属于一部漫画，作者关联 User 表 =====
class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    content: Mapped[str] = mapped_column(Text)
    comic_id: Mapped[int] = mapped_column(ForeignKey("comics.id"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # 评论附图（可选）：R2 公网 URL
    image_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # relationship：评论.author.username / 评论.author.avatar_url 反查发评论人
    author: Mapped["User"] = relationship("User")


def comment_to_dict(c: Comment) -> dict:
    """把 Comment ORM 对象序列化：带出真实用户名与头像。"""
    return {
        "id": c.id,
        "content": c.content,
        "comic_id": c.comic_id,
        "author_id": c.author_id,
        "author_username": c.author.username,
        "avatar_url": c.author.avatar_url,
        "image_url": c.image_url,
        "created_at": c.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }


# ===== 公告表：管理员发布，通知中心展示 =====
class Announcement(Base):
    __tablename__ = "announcements"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


def announcement_to_dict(a: Announcement) -> dict:
    """把 Announcement ORM 对象序列化为前端所需 JSON。"""
    return {
        "id": a.id,
        "title": a.title,
        "content": a.content,
        "created_at": a.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }


class AnnouncementRequest(BaseModel):
    """发布公告请求：标题与正文必填。"""
    title: str
    content: str


# ===== 互动通知表：帖子点赞 / 评论时产生，recipient 收到后通知中心展示 =====
class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # 通知类型：like=赞了动态 / comment=评论了动态 / review=投稿审核结果
    type: Mapped[str] = mapped_column(String(20), index=True)
    # 触发互动的用户（审核通知为管理员账号）
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # 收到通知的用户（动态作者 / 投稿人）
    recipient_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # 关联的帖子（审核类通知为空）
    post_id: Mapped[int | None] = mapped_column(ForeignKey("posts.id"), index=True)
    # 评论内容 / 审核结果文案（like 类型为空）
    content: Mapped[str | None] = mapped_column(Text)
    # 评论附图（comment 通知专用，like/review 为空）：R2 公网 URL
    image_url: Mapped[str | None] = mapped_column(Text)
    # 是否已读：导航栏铃铛红点按未读数判断
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    actor: Mapped["User"] = relationship("User", foreign_keys=[actor_id])


def notification_to_dict(n: Notification) -> dict:
    """把 Notification ORM 对象序列化：带出触发者真实用户名与头像。"""
    return {
        "id": n.id,
        "type": n.type,
        "actor_id": n.actor_id,
        "actor_username": n.actor.username,
        "actor_avatar": n.actor.avatar_url,
        "recipient_id": n.recipient_id,
        "post_id": n.post_id,
        "content": n.content,
        "image_url": n.image_url,
        "is_read": bool(n.is_read),
        "created_at": n.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }


# 阶段二：所有 ORM 模型定义完毕后再建一次表——补齐阶段一之后才定义的
# comments / announcements / notifications 三张表；已存在的表 checkfirst 自动跳过，
# 重复调用无副作用（PostgreSQL / SQLite 均适用）。
Base.metadata.create_all(bind=engine)
print("[init] 数据库建表完成")

# ===== 官方公告 =====
@app.get("/api/announcements")
def list_announcements(db: Session = Depends(get_db)):
    """全部公告：按发布时间倒序（最新在前）。"""
    rows = db.query(Announcement).order_by(Announcement.id.desc()).all()
    return [announcement_to_dict(a) for a in rows]


@app.post("/api/admin/announcements")
def create_announcement(
    req: AnnouncementRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """发布公告：严格校验 Token，只有 role == 'admin' 才能调用（403）。"""
    title = (req.title or "").strip()
    content = (req.content or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="公告标题不能为空")
    if not content:
        raise HTTPException(status_code=400, detail="公告内容不能为空")
    ann = Announcement(title=title, content=content)
    db.add(ann)
    db.commit()
    db.refresh(ann)
    return {"message": "公告发布成功", "announcement": announcement_to_dict(ann)}


@app.delete("/api/announcements/{announcement_id}")
def delete_announcement(
    announcement_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """撤销官方公告：仅管理员（403）。

    公告是**全站公开**数据，删除后所有用户的通知中心都不再出现（官方撤销）。
    """
    ann = db.query(Announcement).filter(Announcement.id == announcement_id).first()
    if ann is None:
        raise HTTPException(status_code=404, detail="公告不存在")
    db.delete(ann)
    db.commit()
    return {"message": "公告已撤销", "id": announcement_id}


# ===== 漫画详情 / 章节内页 =====
@app.get("/api/comics/my-submissions")
def my_submissions(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """我的投稿记录：当前登录用户提交的全部稿件（待审核/已通过/已驳回），时间倒序。
    注意：本路由必须声明在 /api/comics/{comic_id} 之前，否则会被路径参数吞掉。"""
    rows = (
        db.query(PendingComic)
        .filter(PendingComic.submitter_id == user.id)
        .order_by(PendingComic.id.desc())
        .all()
    )
    result = []
    for p in rows:
        title = p.title or ""
        cover = p.cover_url
        # 已通过：书名/封面取正式漫画库的最终数据
        if p.status == "approved" and p.approved_comic_id:
            comic = db.query(Comic).filter(Comic.id == p.approved_comic_id).first()
            if comic is not None:
                title = comic.title
                cover = comic.cover_image or cover
        elif (p.submit_type or "new") == "append" and p.target_comic_id:
            # 追加章节投稿：书名/封面取目标漫画（投稿本身不带整本书信息）
            target = db.query(Comic).filter(Comic.id == p.target_comic_id).first()
            if target is not None:
                if not title:
                    title = target.title
                cover = cover or target.cover_image
        result.append(
            {
                "id": p.id,
                "title": title,
                "cover_url": cover,
                "status": p.status or "pending",
                "submit_type": p.submit_type or "new",
                "created_at": p.created_at.replace(tzinfo=timezone.utc).isoformat(),
            }
        )
    return result


@app.get("/api/comics/{comic_id}")
def get_comic_detail(
    comic_id: int,
    db: Session = Depends(get_db),
    viewer: User | None = Depends(get_optional_user),
):
    """单本漫画详情：基本信息 + 真实简介 + 真实收藏数 + 真实章节列表（不含内页大图）。"""
    comic = db.query(Comic).filter(Comic.id == comic_id).first()
    if comic is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    favorite_count = db.query(Collection).filter(Collection.comic_id == comic.id).count()
    collected = False
    if viewer is not None:
        collected = (
            db.query(Collection)
            .filter(Collection.comic_id == comic.id, Collection.user_id == viewer.id)
            .first()
            is not None
        )
    return {
        "id": comic.id,
        "title": comic.title,
        "author": comic.author,
        "coverImage": comic.cover_image,
        "tags": json.loads(comic.tags or "[]"),
        # 真实简介：没有就是 None，前端显示『作者很懒，暂无简介』
        "description": comic.description,
        "needTranslation": comic.need_translation,
        # 真实收藏数（collections 表统计）与当前用户是否已收藏
        "favorites": favorite_count,
        "collected": collected,
        "chapters": [
            {
                "id": f"{comic.id}-{ch.id}",
                "title": ch.title,
                "pages": len(json.loads(ch.images or "[]")),
            }
            for ch in comic.chapters
        ],
    }


@app.get("/api/comics/{comic_id}/collection")
def get_collection_state(
    comic_id: int,
    db: Session = Depends(get_db),
    viewer: User | None = Depends(get_optional_user),
):
    """收藏状态 + 真实收藏总数（游客也能拿到总数）。"""
    if db.query(Comic).filter(Comic.id == comic_id).first() is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    count = db.query(Collection).filter(Collection.comic_id == comic_id).count()
    collected = False
    if viewer is not None:
        collected = (
            db.query(Collection)
            .filter(Collection.comic_id == comic_id, Collection.user_id == viewer.id)
            .first()
            is not None
        )
    return {"comic_id": comic_id, "count": count, "collected": collected}


@app.post("/api/comics/{comic_id}/collect")
def collect_comic(
    comic_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """收藏：真实写入 collections 表（幂等，重复收藏不报错）。"""
    if db.query(Comic).filter(Comic.id == comic_id).first() is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    exists = (
        db.query(Collection)
        .filter(Collection.comic_id == comic_id, Collection.user_id == user.id)
        .first()
    )
    if exists is None:
        db.add(Collection(comic_id=comic_id, user_id=user.id))
        db.commit()
    count = db.query(Collection).filter(Collection.comic_id == comic_id).count()
    return {"message": "已收藏", "collected": True, "count": count}


@app.delete("/api/comics/{comic_id}/collect")
def uncollect_comic(
    comic_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """取消收藏：从 collections 表删除对应记录（幂等）。"""
    if db.query(Comic).filter(Comic.id == comic_id).first() is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    db.query(Collection).filter(
        Collection.comic_id == comic_id, Collection.user_id == user.id
    ).delete(synchronize_session=False)
    db.commit()
    count = db.query(Collection).filter(Collection.comic_id == comic_id).count()
    return {"message": "已取消收藏", "collected": False, "count": count}


@app.delete("/api/comics/{comic_id}")
def delete_comic(
    comic_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """管理员专属：删除漫画。

    严格权限校验：Authorization: Bearer <token> → 查询用户 → role != 'admin' 直接 403。
    级联清理：手动删除收藏记录（Collection 无 relationship），
    章节（Chapter）由 Comic.chapters 的 cascade="all, delete-orphan" 自动删除，不留孤儿数据。
    """
    comic = db.query(Comic).filter(Comic.id == comic_id).first()
    if comic is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    title = comic.title
    # 先收集封面与全部章节内页 URL（级联删除后再访问 chapters 就拿不到了），
    # 删库后同步清理 R2 对象（存储不残留）
    comic_images = [comic.cover_image]
    for ch in comic.chapters:
        try:
            comic_images.extend(json.loads(ch.images or "[]"))
        except Exception:
            pass
    # 级联删除该漫画的所有收藏记录
    removed_collections = (
        db.query(Collection)
        .filter(Collection.comic_id == comic_id)
        .delete(synchronize_session=False)
    )
    # 删除漫画本身（chapters 级联自动删除）
    db.delete(comic)
    db.commit()
    print(
        f"[admin] 管理员 {admin.username} 删除了漫画 #{comic_id}《{title}》"
        f"（级联清理收藏 {removed_collections} 条）"
    )
    # 已确认删除 → 封面 + 章节内页对应的 R2 对象一并清理（按投稿人身份查引用）
    _purge_r2_images(db, comic.submitter_id or admin.id, comic_images)
    return {"message": "删除成功", "comic_id": comic_id}


class TagsUpdateRequest(BaseModel):
    """标签更新请求体：完整的新标签数组（去重后写库）。"""

    tags: list[str] = []


@app.put("/api/comics/{comic_id}/tags")
def update_comic_tags(
    comic_id: int,
    req: TagsUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """更新漫画标签。

    权限规则：
    - 新增标签（新数组包含旧数组没有的标签）：任意登录用户可操作
    - 删除标签（新数组比旧数组少）：**仅管理员**，否则 403
    """
    comic = db.query(Comic).filter(Comic.id == comic_id).first()
    if comic is None:
        raise HTTPException(status_code=404, detail="漫画不存在")

    old_tags = [t for t in json.loads(comic.tags or "[]") if t]
    # 清洗：去空、去首尾空格、去掉 # 前缀、去重、限长
    cleaned: list[str] = []
    for raw in req.tags:
        tag = (raw or "").strip().lstrip("#").strip()
        if not tag:
            continue
        if len(tag) > 12:
            raise HTTPException(status_code=400, detail="单个标签不能超过 12 个字")
        if tag not in cleaned:
            cleaned.append(tag)
    if len(cleaned) > 10:
        raise HTTPException(status_code=400, detail="标签最多 10 个")

    removed = [t for t in old_tags if t not in cleaned]
    if removed and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权限：只有管理员可以删除标签")

    comic.tags = json.dumps(cleaned, ensure_ascii=False)
    db.commit()

    # 全站标签：更新后重新聚合去重（分类页直接刷新即可拿到最新标签栏）
    all_tags: set[str] = set()
    for c in db.query(Comic).all():
        for t in json.loads(c.tags or "[]"):
            t = (t or "").strip()
            if t:
                all_tags.add(t)
    return {
        "message": "标签已更新",
        "comic_id": comic.id,
        "tags": cleaned,
        "removed": removed,
        "all_tags": ["全部"] + sorted(all_tags),
    }


@app.get("/api/comics/{comic_id}/chapters/{chapter_id}")
def get_chapter_images(comic_id: int, chapter_id: int, db: Session = Depends(get_db)):
    """单章内页：阅读页根据章节 ID 只加载这一话的图片。"""
    ch = (
        db.query(Chapter)
        .filter(Chapter.id == chapter_id, Chapter.comic_id == comic_id)
        .first()
    )
    if ch is None:
        raise HTTPException(status_code=404, detail="章节不存在")
    return {
        "id": f"{comic_id}-{ch.id}",
        "comic_id": comic_id,
        "title": ch.title,
        "images": json.loads(ch.images or "[]"),
    }


# ===== 漫画评论 =====
@app.get("/api/comics/{comic_id}/comments")
def get_comic_comments(comic_id: int, db: Session = Depends(get_db)):
    """某本漫画的全部真实评论（新→旧），relationship 带出发评论人用户名与头像。"""
    if db.query(Comic).filter(Comic.id == comic_id).first() is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    comments = (
        db.query(Comment)
        .filter(Comment.comic_id == comic_id)
        .order_by(Comment.id.desc())
        .all()
    )
    return [comment_to_dict(c) for c in comments]


@app.post("/api/comics/{comic_id}/comments")
def create_comic_comment(
    comic_id: int,
    body: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """发表评论：校验 Token，存库后返回带真实用户名/头像的完整评论。"""
    if db.query(Comic).filter(Comic.id == comic_id).first() is None:
        raise HTTPException(status_code=404, detail="漫画不存在")
    content = (body.get("content") or "").strip()
    image_url = (body.get("image_url") or "").strip() or None
    if not content and not image_url:
        raise HTTPException(status_code=400, detail="评论内容不能为空")
    if content and len(content) > 500:
        raise HTTPException(status_code=400, detail="评论内容不能超过 500 字")
    comment = Comment(content=content, comic_id=comic_id, author_id=user.id, image_url=image_url)
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return {"message": "评论发表成功", "comment": comment_to_dict(comment)}


# ===== 投稿 / 管理员审核 =====
@app.post("/api/comics/submit")
def submit_comic(
    req: SubmitComicRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """投稿：校验 Token，把当前登录用户作为投稿人，写入 pending_comics（status=pending）。"""
    # 投稿类型校验：new / append；append 时必须给出目标漫画且目标必须存在
    submit_type = (req.submit_type or "new").strip().lower()
    if submit_type not in ("new", "append"):
        raise HTTPException(status_code=400, detail="submit_type 只能是 new 或 append")
    if submit_type == "append":
        if req.target_comic_id is None:
            raise HTTPException(status_code=400, detail="追加章节时必须指定 target_comic_id")
        target = db.query(Comic).filter(Comic.id == req.target_comic_id).first()
        if target is None:
            raise HTTPException(status_code=400, detail="目标漫画不存在")
    if not req.title.strip() and submit_type == "new":
        raise HTTPException(status_code=400, detail="书名不能为空")
    if not req.cover_url and submit_type == "new":
        raise HTTPException(status_code=400, detail="请上传封面图")
    title = req.title.strip()

    # 章节数据一并入库（JSON 字符串）：空标题自动补“第N话”
    # 追加模式的序号接着目标漫画已有章节数往后排（如已有 2 章 → 新章从“第3话”起）
    chapter_offset = len(target.chapters) if submit_type == "append" else 0
    chapters_data = [
        {
            "title": (ch.title or "").strip() or f"第{chapter_offset + i + 1}话",
            "images": ch.images,
        }
        for i, ch in enumerate(req.chapters)
        if ch.images  # 无内页的空章节丢弃
    ]
    # 追加模式没有独立书名/封面时，沿用目标漫画的信息便于审核台展示
    pending = PendingComic(
        title=title or (target.title if submit_type == "append" else ""),
        author=req.author.strip() or user.username,
        cover_url=req.cover_url or (target.cover_image if submit_type == "append" else None),
        tags=json.dumps(req.tags, ensure_ascii=False),
        intro=(req.intro or "").strip() or None,
        need_translation=req.need_translation,
        submitter_id=user.id,
        status="pending",
        chapters=json.dumps(chapters_data, ensure_ascii=False) if chapters_data else None,
        submit_type=submit_type,
        target_comic_id=req.target_comic_id if submit_type == "append" else None,
    )
    db.add(pending)
    db.commit()
    db.refresh(pending)
    return {"message": "投稿成功！请耐心等待管理员审核", "comic": pending_to_dict(pending)}


@app.get("/api/admin/pending")
def admin_pending_list(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """管理员获取待审核列表：非管理员账号 403。"""
    rows = (
        db.query(PendingComic)
        .filter(PendingComic.status == "pending")
        .order_by(PendingComic.id.desc())
        .all()
    )
    return [pending_to_dict(p) for p in rows]


# ===== 审核通过后的翻译预热（后台预翻译） =====
# 系统预翻译任务的身份 user_id（真实用户自增 id 从 1 开始，0 不会冲突）。
# worker 调度保证用户手动提交的任务优先于系统预热任务（见 pick_next_task）。
PRETRANSLATE_USER_ID = 0


def enqueue_pretranslate_tasks(
    comic_id: int, chapters, db: Session, need_translation: bool | None = None
) -> int:
    """章节上架后把每章每页排队为后台预翻译任务（缓存预热）。

    - 前提：投稿时选了「需要 AI 翻译」。need_translation=False → 直接跳过不预热
      （与阅读页一致：仅明确 false 隐藏翻译按钮，true 或老数据缺失都显示）
    - 用户打开阅读页时正常提交翻译任务：预热已 done → 幂等直接返回结果（秒开）；
      预热还在排队 → 返回同一 task_id 继续等，绝不重复执行
    - 防重：同一 (comic_id, page_id, target_lang) 已有任何任务记录 → 跳过（唯一约束兜底）
    - 排队防 OOM：worker 单线程一张一张串行，多章节自动排队，OCR 绝无并发
    - lang 与前端阅读页一致写 "en"（前端写死）；翻译缓存按图片内容 hash 命中
    - user_id=0 系统身份：不走提交接口，不受「每用户 1 个进行中任务」限制
    返回新入队页数（0 = 不需要翻译 / 该章节此前已入过队 / 无图片）。
    """
    if need_translation is False:
        print(f"[pretranslate] 漫画 {comic_id} 投稿未选 AI 翻译，跳过预热")
        return 0
    queued = 0
    for ch in chapters:
        images = json.loads(ch.images or "[]")
        for i, src in enumerate(images):
            page_id = f"{ch.id}:{i}"[:128]
            exists = (
                db.query(TranslationTask)
                .filter(
                    TranslationTask.comic_id == comic_id,
                    TranslationTask.page_id == page_id,
                    TranslationTask.target_lang == "zh",
                )
                .first()
            )
            if exists:
                continue
            db.add(
                TranslationTask(
                    comic_id=comic_id,
                    page_id=page_id,
                    target_lang="zh",
                    lang="en",
                    image_url=src,
                    status="queued",
                    user_id=PRETRANSLATE_USER_ID,
                )
            )
            queued += 1
    if queued:
        db.commit()
        print(
            f"[pretranslate] 漫画 {comic_id} 翻译预热入队 {queued} 页"
            "（后台一张一张串行，多章节自动排队）"
        )
    return queued


@app.post("/api/admin/comics/{comic_id}/review")
def review_comic(
    comic_id: int,
    req: ReviewRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """管理员审核：approve 复制进正式 Comic 表；reject 标记驳回。
    两种结果都保留待审核记录（供『我的投稿』查询）并给投稿人写一条审核通知。"""
    if req.action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action 必须是 approve 或 reject")

    pending = db.query(PendingComic).filter(PendingComic.id == comic_id).first()
    if pending is None:
        raise HTTPException(status_code=404, detail="待审核记录不存在")

    if req.action == "approve":
        # 用投稿类型区分处理：new 新建整本 / append 追加章节到已有漫画
        submit_type = pending.submit_type or "new"
        if submit_type == "append":
            # ===== 追加模式：不新建漫画，把新章节挂到 target_comic_id 下 =====
            target = db.query(Comic).filter(Comic.id == pending.target_comic_id).first()
            if target is None:
                raise HTTPException(status_code=400, detail="目标漫画不存在，无法追加章节")
            # 投稿人为本次追加选择的「是否需要 AI 翻译」同步到目标漫画，
            # 阅读页的翻译按钮显隐随最新一次追加的设置走
            target.need_translation = bool(pending.need_translation)
            # 章节序号接在已有章节之后（空标题自动补“第N话”）
            offset = len(target.chapters)
            added_chapters = []
            for idx, ch in enumerate(json.loads(pending.chapters or "[]"), start=1):
                chapter = Chapter(
                    title=ch.get("title") or f"第{offset + idx}话",
                    comic_id=target.id,
                    images=json.dumps(ch.get("images") or [], ensure_ascii=False),
                )
                db.add(chapter)
                added_chapters.append(chapter)
            # 保留投稿记录：标记已通过（不删除，供『我的投稿』展示）
            pending.status = "approved"
            pending.approved_comic_id = target.id
            # 给投稿人写审核通知（红点依赖未读状态）
            db.add(
                Notification(
                    type="review",
                    actor_id=admin.id,
                    recipient_id=pending.submitter_id,
                    post_id=None,
                    content=f"你为《{target.title}》提交的 {len(added_chapters)} 个新章节已审核通过",
                )
            )
            db.commit()
            db.refresh(target)  # 刷新 relationship，让返回的章节列表包含新章
            # 翻译预热：新章节逐页排队后台预翻译，用户打开时命中缓存秒出
            # （仅投稿选了「需要 AI 翻译」才预热；append 时 1479 行已同步该标志）
            enqueue_pretranslate_tasks(
                target.id, target.chapters, db, target.need_translation
            )
            return {
                "message": f"已通过！{len(added_chapters)} 个章节已追加到《{target.title}》",
                "comic_id": target.id,
                "chapters": [
                    {"id": f"{target.id}-{ch.id}", "title": ch.title, "pages": len(json.loads(ch.images or "[]"))}
                    for ch in target.chapters
                ],
            }
        # ===== 新建模式：整本漫画 + 章节一起入库 =====
        # 正式表 title 唯一：避免重复审核同名作品导致 500
        exists = db.query(Comic).filter(Comic.title == pending.title).first()
        if exists:
            raise HTTPException(status_code=400, detail="正式漫画库中已存在同名作品")
        comic = Comic(
            title=pending.title,
            author=pending.author,
            cover_image=pending.cover_url or "",
            tags=pending.tags,  # 已是 JSON 字符串，直接复用
            # 投稿时填写的简介原样带入（没填 → None，前端显示『作者很懒，暂无简介』）
            description=(pending.intro or "").strip() or None,
            need_translation=pending.need_translation,
            submitter_id=pending.submitter_id,  # 记录投稿人，供『我的投稿』查询
        )
        db.add(comic)
        db.flush()  # 先拿到 comic.id，章节外键要用
        # 待审核的章节数据真实写入 Chapter 表（一对多）
        for idx, ch in enumerate(json.loads(pending.chapters or "[]"), start=1):
            db.add(
                Chapter(
                    title=ch.get("title") or f"第{idx}话",
                    comic_id=comic.id,
                    images=json.dumps(ch.get("images") or [], ensure_ascii=False),
                )
            )
        # 保留投稿记录：标记已通过（不删除，供『我的投稿』展示）
        pending.status = "approved"
        pending.approved_comic_id = comic.id
        # 给投稿人写审核通知
        db.add(
            Notification(
                type="review",
                actor_id=admin.id,
                recipient_id=pending.submitter_id,
                post_id=None,
                content=f"你的作品《{pending.title}》审核通过，已上架漫画库",
            )
        )
        db.commit()
        db.refresh(comic)
        # 翻译预热：整本逐章逐页排队后台预翻译（多章节自动排队，worker 串行防 OOM）
        # （仅投稿选了「需要 AI 翻译」才预热，1531 行建 comic 时已带入该标志）
        enqueue_pretranslate_tasks(comic.id, comic.chapters, db, comic.need_translation)
        return {
            "message": "已通过并发布！",
            "comic_id": comic.id,
            "chapters": [
                {"id": f"{comic.id}-{ch.id}", "title": ch.title, "pages": len(json.loads(ch.images or "[]"))}
                for ch in comic.chapters
            ],
        }

    # reject：标记驳回（保留记录供『我的投稿』展示已驳回状态）并通知投稿人；
    # 封面与章节内页已确认废弃 → R2 对象立即清除（存储不残留），
    # 记录里的图片 URL 同步置空（前端显示占位，避免裂图；重新投稿需重新传图）
    rejected_images = [pending.cover_url]
    try:
        for ch in json.loads(pending.chapters or "[]"):
            rejected_images.extend(ch.get("images") or [])
    except Exception:
        pass
    pending.status = "rejected"
    pending.cover_url = None
    pending.chapters = "[]"
    db.add(
        Notification(
            type="review",
            actor_id=admin.id,
            recipient_id=pending.submitter_id,
            post_id=None,
            content=f"你的作品《{pending.title}》审核未通过，可修改后重新投稿",
        )
    )
    db.commit()
    _purge_r2_images(db, pending.submitter_id, rejected_images)
    return {"message": "已驳回"}


# ===== 用户系统：注册 / 登录 =====
@app.post("/api/auth/register")
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    """注册：检查用户名/邮箱唯一性 → bcrypt 哈希密码 → 入库（不返回密码）。"""
    username = req.username.strip()
    email = req.email.strip().lower()
    # 基础校验
    if not username or not email or not req.password:
        raise HTTPException(status_code=400, detail="用户名、邮箱和密码均不能为空")
    # 邮箱格式校验：必须包含 @（简单校验，配合前端提示）
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        raise HTTPException(status_code=400, detail="邮件格式不正确")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="密码长度至少 6 位")

    # 唯一性检查：用户名或邮箱已存在 → 400
    exists = (
        db.query(User)
        .filter((User.username == username) | (User.email == email))
        .first()
    )
    if exists:
        field = "用户名" if exists.username == username else "邮箱"
        raise HTTPException(status_code=400, detail=f"{field}已被注册")

    user = User(
        username=username,
        email=email,
        password_hash=hash_password(req.password),  # bcrypt 哈希，绝不存明文
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return {"message": "注册成功", "user": {"id": user.id, "username": user.username}}


@app.post("/api/auth/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    """登录：邮箱 + 密码 → 校验密码 → 生成 7 天有效期的 JWT Token 返回给前端。"""
    user = db.query(User).filter(User.email == req.email.strip().lower()).first()
    # 用户不存在或密码错误统一返回 401（不泄露账号是否存在）
    if user is None or user.password_hash is None or not verify_password(
        req.password, user.password_hash
    ):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")

    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    token = jwt.encode(
        {"sub": user.username, "exp": expire},
        SECRET_KEY,
        algorithm=ALGORITHM,
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": TOKEN_EXPIRE_DAYS * 24 * 3600,
        "user": {"id": user.id, "username": user.username, "role": user.role},
    }


@app.get("/api/auth/me")
def read_me(user: User = Depends(get_current_user)):
    """获取当前登录用户的完整资料（从数据库查询）。"""
    return {"user": user_profile(user)}


@app.get("/api/users/{user_id}")
def public_user_profile(user_id: int, db: Session = Depends(get_db)):
    """他人空间页用的公开资料（无需登录，绝不含邮箱/密码/生日等敏感字段）。

    广场帖子的 authorId 是真实数据库用户 id；旧版他人空间页只查前端假数据
    SPACE_USERS，导致真实用户点进去显示『用户不存在』，此接口补齐真实数据源。
    """
    target = db.query(User).filter(User.id == user_id).first()
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {
        "id": target.id,
        "username": target.username,
        "avatar_url": target.avatar_url,
        "cover_url": target.cover_url,
        "signature": target.signature,
        "tags": json.loads(target.tags or "[]"),
    }


@app.put("/api/auth/me")
def update_me(
    req: ProfileUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """更新当前登录用户的资料：只更新前端传入的字段，写回数据库。

    换头像/背景时旧图立即从 R2 清理（仅限本站对象存储的 URL，
    且该用户其余数据不再引用它），避免对象存储堆积废弃图片。
    """
    updated = req.model_dump(exclude_unset=True)
    # 记录换图前的旧 URL（仅头像/背景这两个字段参与清理）
    old_urls = {f: getattr(user, f) for f in ("avatar_url", "cover_url") if f in updated}
    for field, value in updated.items():
        # tags 是数组 → 入库前序列化为 JSON 字符串
        if field == "tags" and value is not None:
            setattr(user, "tags", json.dumps(value, ensure_ascii=False))
        else:
            setattr(user, field, value)
    db.commit()
    db.refresh(user)

    # 旧图清理：URL 真的变了才清；外链 / data:URL / 仍被其他数据引用的不清
    for field, old in old_urls.items():
        if not old or old == updated.get(field):
            continue
        key = _r2_object_key(old)
        if key and not _url_still_referenced(db, user.id, old):
            _delete_r2_object_quietly(key)
    return {"message": "资料已保存", "user": user_profile(user)}


# ===== Cloudflare R2 对象存储：图片上传（S3 兼容协议，boto3） =====
# 密钥全部来自环境变量，Railway Variables 里配置：
#   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME
#   R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
#   R2_PUBLIC_BASE=https://pub-xxx.r2.dev（或绑定的自定义域，须开启公开访问）
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "")
R2_ENDPOINT = os.getenv("R2_ENDPOINT", "")
R2_PUBLIC_BASE = os.getenv("R2_PUBLIC_BASE", "").rstrip("/")

# 允许的图片类型 → 文件扩展名
_UPLOAD_ALLOWED = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}
# 单张图片上限 10MB（防止占满 R2 与拖慢请求）
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

_r2_client = None


def _get_r2_client():
    """懒加载 boto3 S3 客户端（R2 兼容 S3 协议，region 固定 auto）。"""
    global _r2_client
    if _r2_client is None:
        import boto3

        _r2_client = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )
    return _r2_client


def _r2_object_key(url: str | None) -> str | None:
    """本站对象存储的公网 URL → 对象键（uploads/...）；外链 / data:URL 返回 None。"""
    if not url or not R2_PUBLIC_BASE:
        return None
    if not url.startswith(R2_PUBLIC_BASE + "/"):
        return None
    return url[len(R2_PUBLIC_BASE) + 1 :]


def _delete_r2_object_quietly(key: str) -> None:
    """删除 R2 对象；失败只打日志不抛错（清理是附带动作，不能阻塞主流程）。"""
    try:
        _get_r2_client().delete_object(Bucket=R2_BUCKET_NAME, Key=key)
        print(f"[r2] 已清理旧对象 {key}")
    except Exception as exc:
        print(f"[r2] 清理旧对象失败 {key}: {type(exc).__name__}: {exc}")


def _url_still_referenced(db: Session, user_id: int, url: str) -> bool:
    """该用户的其他数据是否仍引用该 URL（防止换头像误删正在展示的帖子配图）。

    检查范围：帖子配图（image_url / image_urls）、正式漫画封面、待审投稿封面与内页。
    URL 含 uuid 不可预测，跨用户引用实际不可能发生，因此只查本用户的行。
    """
    if (
        db.query(Post)
        .filter(
            Post.author_id == user_id,
            or_(Post.image_url == url, Post.image_urls.contains(url)),
        )
        .first()
    ):
        return True
    if (
        db.query(Comic)
        .filter(Comic.submitter_id == user_id, Comic.cover_image == url)
        .first()
    ):
        return True
    if (
        db.query(PendingComic)
        .filter(
            PendingComic.submitter_id == user_id,
            or_(PendingComic.cover_url == url, PendingComic.chapters.contains(url)),
        )
        .first()
    ):
        return True
    if (
        db.query(Notification)
        .filter(
            Notification.actor_id == user_id,
            Notification.image_url == url,
        )
        .first()
    ):
        return True
    return False


def _purge_r2_images(db: Session, owner_id: int, urls) -> None:
    """数据确认删除后，清理其图片对应的 R2 对象（存储不残留）。

    - 仅处理本站对象存储的 URL（外链 / data:URL 自动跳过）
    - 每个 URL 删除前先用 _url_still_referenced 检查该用户其它数据是否仍引用
      （防同一图多处使用误删），无引用才删
    - 失败只打日志不抛错：清理是附带动作，不能阻塞删除主流程
    """
    seen: set[str] = set()
    for u in urls or []:
        if not u or u in seen:
            continue
        seen.add(u)
        key = _r2_object_key(u)
        if key is None:
            continue
        try:
            if _url_still_referenced(db, owner_id, u):
                print(f"[r2] {key} 仍被其它数据引用，跳过清理")
                continue
        except Exception as exc:
            print(f"[r2] 引用检查失败 {key}: {type(exc).__name__}: {exc}（保守跳过）")
            continue
        _delete_r2_object_quietly(key)


@app.post("/api/upload")
async def upload_image(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """上传图片到 Cloudflare R2（不落服务器本地盘，不存 data:URL）。

    - 需登录（防止匿名滥用刷流量）
    - 返回 {"url": 公网链接}；前端把这个 URL 作为 cover_url / image_url 等存库
    """
    missing = [
        name
        for name, val in [
            ("R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID),
            ("R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY),
            ("R2_BUCKET_NAME", R2_BUCKET_NAME),
            ("R2_ENDPOINT", R2_ENDPOINT),
            ("R2_PUBLIC_BASE", R2_PUBLIC_BASE),
        ]
        if not val
    ]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"对象存储未配置，缺少环境变量: {', '.join(missing)}",
        )

    ext = _UPLOAD_ALLOWED.get((file.content_type or "").lower())
    if ext is None:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的图片类型: {file.content_type}（仅支持 JPG/PNG/WebP/GIF）",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="图片超过 10MB 上限")

    # 对象键：uploads/年/月/uuid.ext —— 天然去重、按月归档、不可预测
    key = f"uploads/{datetime.utcnow():%Y/%m}/{uuid.uuid4().hex}.{ext}"
    try:
        _get_r2_client().put_object(
            Bucket=R2_BUCKET_NAME,
            Key=key,
            Body=data,
            ContentType=file.content_type,
        )
    except Exception as exc:
        print(f"[upload] R2 上传失败: {type(exc).__name__}: {exc}")
        raise HTTPException(status_code=502, detail="图片上传到对象存储失败，请稍后重试")

    # R2 put_object 不返回公网地址，公网 URL = 公开访问域 + 对象键
    url = f"{R2_PUBLIC_BASE}/{key}"
    print(f"[upload] {user.username} 上传成功 {key}（{len(data)} bytes）")
    return {"url": url}


# ===== 帖子：发帖 / 列表 / 删除 =====
@app.post("/api/posts")
def create_post(
    req: CreatePostRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """发帖：从 Token 解析当前用户作为作者，写入 posts 表。

    - 图片支持多张（最多 9 张）：images 数组优先，旧字段 image_url 兼容为单图
    - mention 可选 @ 管理员：正文后显示紫色 @ 徽标，并给被 @ 者写 mention 通知
      （通知中心点击 → /square?post_id= 精准定位该动态）
    """
    content = (req.content or "").strip()
    image_urls = [u.strip() for u in (req.images or []) if u and u.strip()]
    if not image_urls and req.image_url:
        image_urls = [req.image_url]
    if len(image_urls) > 9:
        raise HTTPException(status_code=400, detail="最多上传 9 张图片")
    if not content and not image_urls:
        raise HTTPException(status_code=400, detail="文字内容和图片至少要有一样")

    # @ 好友：当前版本仅允许 @ 管理员账号（防止用户随便 @ 别人造成骚扰）
    mention_user = None
    mention_name = (req.mention or "").strip().lstrip("@")
    if mention_name:
        mention_user = (
            db.query(User).filter(User.username == mention_name).first()
        )
        if mention_user is None or mention_user.role != "admin":
            raise HTTPException(status_code=400, detail="只能 @ 管理员账号")

    post = Post(
        content=content or None,
        image_url=image_urls[0] if image_urls else None,
        image_urls=json.dumps(image_urls, ensure_ascii=False) if image_urls else None,
        mention_user_id=mention_user.id if mention_user else None,
        author_id=user.id,
    )
    db.add(post)
    db.commit()
    db.refresh(post)

    # mention 通知：给被 @ 的管理员写一条（@ 自己不通知）
    if mention_user is not None and mention_user.id != user.id:
        db.add(
            Notification(
                type="mention",
                actor_id=user.id,
                recipient_id=mention_user.id,
                post_id=post.id,
                content=f"{user.username} 在动态中提到了你",
            )
        )
        db.commit()

    return {"message": "发布成功", "post": post_to_dict(post)}


@app.get("/api/posts")
def list_posts(db: Session = Depends(get_db)):
    """帖子列表：按创建时间倒序，relationship 带出作者用户名；附带真实评论数。"""
    posts = db.query(Post).order_by(Post.created_at.desc(), Post.id.desc()).all()
    # 批量统计每条动态的评论数（评论以 comment 通知的形式存储），避免 N+1 查询
    counts = dict(
        db.query(Notification.post_id, func.count(Notification.id))
        .filter(Notification.type == "comment", Notification.post_id.isnot(None))
        .group_by(Notification.post_id)
        .all()
    )
    result = []
    for p in posts:
        d = post_to_dict(p)
        d["comment_count"] = counts.get(p.id, 0)
        result.append(d)
    return result


@app.delete("/api/posts/{post_id}")
def delete_post(
    post_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除自己的帖子：只允许作者本人删除。"""
    post = db.query(Post).filter(Post.id == post_id).first()
    if post is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    if post.author_id != user.id:
        raise HTTPException(status_code=403, detail="只能删除自己的动态")
    # 先收集配图 URL，删库后同步清理 R2 对象（存储不残留）
    post_images = [post.image_url] + list(post.image_urls or [])
    db.delete(post)
    db.commit()
    _purge_r2_images(db, user.id, post_images)
    return {"message": "删除成功"}


# ===== 帖子互动：点赞 / 评论（产生真实互动通知） =====
@app.get("/api/posts/liked")
def my_liked_posts(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户赞过的动态 id 列表（前端红心初始状态的数据源）。"""
    rows = (
        db.query(Notification.post_id)
        .filter(
            Notification.type == "like",
            Notification.actor_id == user.id,
            Notification.post_id.isnot(None),
        )
        .all()
    )
    return {"post_ids": [r[0] for r in rows]}


@app.post("/api/posts/{post_id}/like")
def like_post(
    post_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """点赞/取消点赞（切换）：已赞时再次调用即取消红心。

    已赞记录以 notifications 表的 like 通知为准：
    点赞 → 计数 +1 并给作者产生通知；取消 → 删除该通知、计数 -1。
    """
    post = db.query(Post).filter(Post.id == post_id).first()
    if post is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    if post.author_id == user.id:
        raise HTTPException(status_code=400, detail="不能给自己的动态点赞")
    dup = (
        db.query(Notification)
        .filter(
            Notification.type == "like",
            Notification.actor_id == user.id,
            Notification.post_id == post_id,
        )
        .first()
    )
    if dup is not None:
        # 已赞 → 取消：计数 -1 并同步撤销作者收到的点赞通知
        post.likes = max(0, post.likes - 1)
        db.delete(dup)
        db.commit()
        return {"message": "已取消点赞", "likes": post.likes, "liked": False}
    post.likes += 1
    db.add(
        Notification(
            type="like", actor_id=user.id, recipient_id=post.author_id, post_id=post_id
        )
    )
    db.commit()
    return {"message": "点赞成功", "likes": post.likes, "liked": True}


@app.get("/api/posts/{post_id}/comments")
def list_post_comments(
    post_id: int,
    db: Session = Depends(get_db),
):
    """读取某条动态的评论列表（评论以 comment 通知的形式存储，公开可读）。"""
    if db.query(Post).filter(Post.id == post_id).first() is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    rows = (
        db.query(Notification)
        .filter(Notification.type == "comment", Notification.post_id == post_id)
        .order_by(Notification.id.asc())
        .all()
    )
    return [
        {
            "id": n.id,
            "actor_id": n.actor_id,
            "actor_username": n.actor.username,
            "actor_avatar": n.actor.avatar_url,
            "content": n.content,
            "image_url": n.image_url,
            "created_at": n.created_at.replace(tzinfo=timezone.utc).isoformat(),
        }
        for n in rows
    ]


class PostCommentRequest(BaseModel):
    """帖子评论请求：内容必填；附图可选（已上传到 R2 的公网 URL）。"""
    content: str
    image_url: str | None = None


@app.post("/api/posts/{post_id}/comments")
def comment_post(
    post_id: int,
    req: PostCommentRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """评论动态：给作者产生 comment 通知（评论内容与附图随通知存储）。"""
    post = db.query(Post).filter(Post.id == post_id).first()
    if post is None:
        raise HTTPException(status_code=404, detail="帖子不存在")
    content = (req.content or "").strip()
    image_url = (req.image_url or "").strip() or None
    if not content and not image_url:
        raise HTTPException(status_code=400, detail="评论内容不能为空")
    if content and len(content) > 500:
        raise HTTPException(status_code=400, detail="评论内容不能超过 500 字")
    notification = Notification(
        type="comment",
        actor_id=user.id,
        recipient_id=post.author_id,
        post_id=post_id,
        content=content,
        image_url=image_url,
    )
    db.add(notification)
    db.commit()
    db.refresh(notification)
    return {"message": "评论成功", "notification": notification_to_dict(notification)}


@app.get("/api/notifications")
def list_notifications(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """通知中心数据源：『当前用户的私人通知』+『全站官方公告』合并后返回。

    - 私人通知（like/comment/review）：**必须** recipient_id == 当前 Token 用户 id，
      绝不泄露别人的点赞/评论/审核结果
    - 官方公告（official）：**不加 recipient 过滤**，全站公开，所有登录用户都能看到
    - 合并后按真实时间 created_at 倒序（source 字段区分来源，供前端删除时选对接口）
    """
    # A. 私人通知：严格按收件人过滤
    rows = (
        db.query(Notification)
        .filter(Notification.recipient_id == user.id)
        .order_by(Notification.id.desc())
        .all()
    )
    items = [
        {
            **notification_to_dict(n),
            "source": "notification",
            "title": None,
        }
        for n in rows
    ]

    # B. 官方公告：全站公开，所有人可见（不加任何用户过滤）
    anns = db.query(Announcement).order_by(Announcement.id.desc()).all()
    items.extend(
        {
            "source": "announcement",
            "id": a.id,
            "type": "official",
            "title": a.title,
            "content": a.content,
            "post_id": None,
            "actor_id": 0,
            "actor_username": "AoliComic官方",
            "actor_avatar": None,
            "recipient_id": None,
            "is_read": True,
            "created_at": a.created_at.replace(tzinfo=timezone.utc).isoformat(),
        }
        for a in anns
    )

    # 合并后按真实时间倒序（最新在前）
    items.sort(key=lambda it: it["created_at"], reverse=True)
    return items


@app.get("/api/notifications/unread-count")
def unread_notification_count(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """未读通知数：导航栏铃铛红点用。"""
    count = (
        db.query(Notification)
        .filter(Notification.recipient_id == user.id, Notification.is_read.is_(False))
        .count()
    )
    return {"count": count}


@app.post("/api/notifications/read")
def mark_notifications_read(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """把我的全部通知标记为已读（进入通知中心时调用，红点消失）。"""
    updated = (
        db.query(Notification)
        .filter(Notification.recipient_id == user.id, Notification.is_read.is_(False))
        .update({"is_read": True}, synchronize_session=False)
    )
    db.commit()
    return {"message": "已全部标记为已读", "updated": updated}


@app.delete("/api/notifications/{notification_id}")
def delete_notification(
    notification_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除一条**私人**通知。

    权限：管理员可删除任意通知；普通用户**只能删除发给自己的那条**
    （严格校验 recipient_id == 当前用户 id，否则 403，绝不越权）。
    公告请走 DELETE /api/announcements/{id}（删除即全站撤销）。
    """
    notification = (
        db.query(Notification).filter(Notification.id == notification_id).first()
    )
    if notification is None:
        raise HTTPException(status_code=404, detail="通知不存在")
    if user.role != "admin" and notification.recipient_id != user.id:
        raise HTTPException(status_code=403, detail="无权限：只能删除发给自己的通知")
    # 评论附图：删通知后同步清理 R2 对象（其它数据仍引用时会自动跳过）
    comment_image = notification.image_url
    db.delete(notification)
    db.commit()
    if comment_image:
        _purge_r2_images(db, notification.actor_id or user.id, [comment_image])
    return {"message": "通知已删除", "id": notification_id}
