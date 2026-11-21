# Railway 部署：Python 3.13 精简镜像 + OpenCV 运行所需的系统动态库
# PaddleOCR → paddlex → opencv-contrib-python（完整版 cv2），精简容器缺
# libGL.so.1 / libglib-2.0.so.0 等会报 ImportError，必须先装齐。
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 系统库：OpenCV（含 X11/OpenGL 图形栈）+ 常用运行库
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（Railway 构建耗时长主要来自 paddlepaddle / paddleocr，属正常）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 端口由 start.py 从环境变量 PORT 读取（不依赖 shell 展开 $PORT）
EXPOSE 8080
CMD ["python", "start.py"]
