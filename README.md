# AI Image Studio

一个图片生成、追图编辑和本地图片处理工作台。前端使用 React/Vite，Express 后端将生成请求代理到兼容 OpenAI Responses API 的图片服务。

## 功能

- 文生图与参考图编辑，支持 PNG、JPG、WebP 参考图和 SSE 流式状态
- 基于当前生成结果追加提示词继续修改
- 多区域局部修改：在“图片工具”页上传任意图片，框选多个区域并分别填写要求；仅上传各区域裁剪图及少量边缘上下文，浏览器按顺序羽化拼回原图，也可从生成结果直接进入
- 最终图下载、复制，并可直接送入透明 PNG、压缩、图片转 PDF
- 本地生成历史：浏览器 IndexedDB 保存最近 12 条结果，支持恢复和删除
- 浏览器本地工具：智能去边框、透明 PNG、图片压缩、PDF 转图片、图片转 PDF
- 最终图、参考图和工具结果支持放大、缩放和拖动查看

## 本地启动

需要 Node.js 20.19 或更高版本。

```bash
npm install
npm run frontend:install
npm run frontend:build
OPENAI_API_KEY=your_key npm start
```

服务默认监听 `80` 端口。开发前端时可单独启动：

```bash
npm run dev --prefix frontend
```

生产环境由 Express 提供根目录的 `build/` 静态文件，因此修改前端后需要执行：

```bash
npm run frontend:build
```

## 配置

把密钥放在本地环境变量或未提交的 `.env` 文件中，不要写入源码或构建产物。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 图片服务 API 密钥，必填 | 无 |
| `OPENAI_BASE_URL` | OpenAI 兼容服务地址 | `https://vibe.soyoung.com` |
| `OPENAI_RESPONSES_MODEL` | Responses API 使用的模型 | `OPENAI_MODEL` 或 `gpt-5.5` |
| `OPENAI_IMAGE_MODEL` | 图片生成模型 | `gpt-image-2` |
| `PORT` | 服务端端口 | `80` |
| `CORS_ORIGIN` | 允许的跨域来源，逗号分隔 | 无 |
| `IMAGE_RATE_LIMIT_PER_HOUR` | 单 IP 每小时生成次数，`0` 关闭限流 | `20` |
| `MAX_UPLOAD_IMAGES` | 单次上传参考图数量上限，`0` 表示不限制 | `0` |

单张参考图最大 20MB；服务端会检查 MIME 类型和图片文件头。

## API

`POST /api/generate-image-stream`

使用 `multipart/form-data` 传入：

- `prompt`: 生成提示词
- `mode`: `generate` 或 `edit`
- `size`: `auto`、`1024x1024`、`1024x1536`、`1536x1024`、`1920x1080`
- `images`: 可选的一个或多个参考图片

响应为 SSE，事件包括 `status`、`heartbeat`、`partial_image`、`final_image`、`done` 和 `error`。

## 校验

```bash
npm test
npm run frontend:build
```

## 项目结构

```text
index.js             Express 服务和图片生成流代理
frontend/src/App.tsx 生成工作台与本地图片/PDF 工具
frontend/src/styles.css 页面样式
test/                服务端上传与限流辅助函数测试
build/               前端生产构建输出
```
