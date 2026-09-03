# AI Image Studio

一个图片生成、参考图编辑和本地图片处理工作台。前端使用 React/Vite，Express 后端把请求直接代理到兼容 OpenAI Images API 的图片服务。

## 功能

- 文生图与参考图编辑，支持 PNG、JPG、WebP 参考图和 SSE 流式预览
- 基于当前生成结果追加提示词继续修改
- 证件照制作：上传正面人像后可选一寸、小一寸或二寸以及蓝、白、红底；通过图片编辑服务换底，再在浏览器导出标准像素 PNG
- 最终图下载、复制，并可直接送入透明 PNG、去边框、压缩、图片转 PDF
- 本地生成历史：浏览器 IndexedDB 保存最近 12 条结果，支持恢复和删除
- 浏览器本地工具：智能去边框、透明 PNG、图片压缩、PDF 转图片、图片转 PDF
- 最终图、参考图和工具结果支持放大、缩小、90° 旋转和拖动查看

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
| `OPENAI_BASE_URL` | 兼容 OpenAI Images API 的服务地址 | `https://vibe.soyoung.com` |
| `OPENAI_IMAGE_MODEL` | 图片生成和编辑模型 | `gpt-image-2` |
| `PORT` | 服务端端口 | `80` |
| `CORS_ORIGIN` | 允许的跨域来源，逗号分隔 | 无 |
| `IMAGE_RATE_LIMIT_PER_HOUR` | 单 IP 每小时生成次数，`0` 关闭限流 | `20` |
| `MAX_UPLOAD_IMAGES` | 单次参考图数量上限，可设为 `1`～`16` | `4` |

参考图只支持 PNG、JPG 和 WebP：单张最大 20MB，单次请求所有参考图合计最大 40MB。服务端还会检查图片文件头；40MB 总量是不可调高的资源保护上限。

当前默认上游必须同时兼容以下能力：

- `POST /v1/images/generations`：无参考图时文生图。
- `POST /v1/images/edits`：有参考图或基于最终图追加修改。
- `gpt-image-2`、Images API SSE，以及 `image[]` 多文件字段。

服务端不会在 Images API 不兼容时静默回退到其他接口，以免改变生成语义。更换兼容服务后应分别验证以上两个端点。

## API

`POST /api/generate-image-stream`

使用 `multipart/form-data` 传入：

- `prompt`：必填，去除首尾空白后不能为空，最多 2000 个字符。
- `size`：可省略，默认 `auto`；也可传 `gpt-image-2` 支持的 `WIDTHxHEIGHT`。除 `auto` 外，宽高必须都是 16 的倍数，比例在 1:3～3:1，最长边不超过 3840px，总像素为 655,360～8,294,400。
- `images`：可选的一个或多个参考图片。是否存在参考图就是服务端选择“生成”或“编辑”的唯一依据，不接受客户端 `mode`。

浏览器接口始终返回 SSE，事件包括 `status`、`heartbeat`、`partial_image`、`final_image`、`done` 和 `error`。响应头 `X-Request-ID` 以及图片/错误事件中的 `requestId` 可用于定位请求。

服务端会记录不含敏感内容的单行请求指标，例如操作类型、参考图数量与总字节数、尺寸、上游端点、模型、HTTP 状态和各阶段耗时。日志不会记录图片、Base64、完整提示词、API Key 或 Authorization。

## 校验

```bash
npm test
node --check index.js
npm run frontend:build
git diff --check
```

## 项目结构

```text
index.js             Express 服务、上传校验和 Images API 流代理
frontend/src/App.tsx 生成工作台与本地图片/PDF 工具
frontend/src/styles.css 页面样式
test/                上传、尺寸、请求协议、流转换与限流测试
build/               前端生产构建输出
```
