# EmbyX 本地文件夹模式

## 改动文件
- zh/js/local.js、en/js/local.js（新建）
- zh/index.html（UI + 扫描/播放逻辑）
- docker/docker-compose.yml（本地 build）
- LOCAL_MODE.md（本说明）

## 使用
1. Chrome / Edge 打开页面
2. 我的 → 服务器配置 →「选择并扫描本地文件夹」
3. 授权后自动识别视频、NFO、海报

## 飞牛 Docker
```bash
cd EmbyX
docker compose -f docker/docker-compose.yml up -d --build
# 访问 http://NAS_IP:8090
```
本地模式在浏览器选目录，片库不必挂进容器。
