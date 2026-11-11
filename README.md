# AI Image Studio

一个图片生成、参考图编辑和本地图片处理工作台。前端使用 React/Vite，Express 后端把请求直接代理到兼容 OpenAI Images API 的图片服务。

## 功能

- 文生图与参考图编辑，支持 PNG、JPG、WebP 参考图和 SSE 流式预览
- 独立英语图片工作台 `/english`：人物特征提取与审核、角色图、教材场景图和道具修改；默认使用文档中的场景提示词
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
| `OPENAI_IMAGE_MODEL` | 客户端未传模型时使用的默认图片模型 | `gpt-image-2.5-flare` |
| `ENGLISH_VISION_MODEL` | 英语工作台的人物特征识别模型，需支持图像输入；不影响图片模型 | `gpt-5.6` |
| `PORT` | 服务端端口 | `80` |
| `CORS_ORIGIN` | 允许的跨域来源，逗号分隔 | 无 |
| `IMAGE_RATE_LIMIT_PER_HOUR` | 单 IP 每小时生成次数，`0` 关闭限流 | `20` |
| `MAX_UPLOAD_IMAGES` | 单次参考图数量上限，可设为 `1`～`16` | `4` |

参考图只支持 PNG、JPG 和 WebP：单张最大 20MB，单次请求所有参考图合计最大 40MB。服务端还会检查图片文件头；40MB 总量是不可调高的资源保护上限。

当前默认上游必须同时兼容以下能力：

- `POST /v1/images/generations`：无参考图时文生图。
- `POST /v1/images/edits`：有参考图或基于最终图追加修改。
- `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，以及 `image[]` 多文件字段。
- `/v1/images/generations` 使用上游流式响应并支持阶段性预览；`/v1/images/edits` 在当前兼容服务上使用非流式上游请求，完成后仍通过浏览器端 SSE 返回最终图片，避免 `stream=true` 长时间无响应。

服务端不会在 Images API 不兼容时静默回退到其他接口，以免改变生成语义。更换兼容服务后应分别验证以上两个端点。

英语工作台使用独立接口，最多 16 张参考图、单张 20MB、总计 40MB。人物特征识别需配置可用的视觉模型；识别失败时可手动填写并审核特征。场景角色图必须填写对应关系。

## API

`GET /api/image-models`

页面加载时先调用该接口获取可用模型清单，前端不内置模型 ID 和默认模型。返回 `models`（当前服务端允许的图片模型）与 `defaultModel`（默认模型，取 `OPENAI_IMAGE_MODEL`，若不在清单内则取列表第一项）。接口失败时下拉框不可用并展示重试入口。

```json
{
  "models": ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
  "defaultModel": "gpt-image-2.5-flare"
}
```

`POST /api/english/extract-character` 和 `POST /api/english/generate-image-stream` 分别服务于新页面的人物特征识别和图片生成；图片生成允许更长的场景提示词和最多 16 张参考图。

`POST /api/generate-image-stream`

使用 `multipart/form-data` 传入：

- `prompt`：必填，去除首尾空白后不能为空，最多 2000 个字符。
- `model`：前端始终显式传入从 `/api/image-models` 获取的模型；直接调用接口时可省略，此时由服务端 `OPENAI_IMAGE_MODEL` 决定。仅支持 `/api/image-models` 返回的模型。
- `size`：可省略，默认 `auto`；也可传已选图片模型支持的 `WIDTHxHEIGHT`。除 `auto` 外，宽高必须都是 16 的倍数，比例在 1:3～3:1，最长边不超过 3840px，总像素为 655,360～8,294,400。
- `images`：可选的一个或多个参考图片。是否存在参考图就是服务端选择“生成”或“编辑”的唯一依据，不接受客户端 `mode`。

浏览器接口始终返回 SSE，事件包括 `status`、`heartbeat`、`partial_image`、`final_image`、`done` 和 `error`。无参考图时可以收到 `partial_image`；参考图编辑会在上游完成后收到 `final_image`。响应头 `X-Request-ID` 以及图片/错误事件中的 `requestId` 可用于定位请求。

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
