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
| `OPENAI_BACKUP_API_KEY` | 备用图片服务 API 密钥；`OPENAI_PROVIDER=backup` 时使用 | 无 |
| `OPENAI_BACKUP_BASE_URL` | 备用兼容 OpenAI Images API 的服务地址；未设置时使用 wasai | `https://wasai.soyoung.com` |
| `OPENAI_PROVIDER` | 当前使用的图片服务，填 `primary` 或 `backup` | `primary` |
| `OPENAI_IMAGE_MODEL` | 客户端未传模型时使用的默认图片模型 | `gpt-image-2.6-flare` |
| `ENGLISH_VISION_MODEL` | 英语工作台的人物特征识别模型，需支持图像输入；不影响图片模型 | `gpt-5.6` |
| `PORT` | 服务端端口 | `80` |
| `CORS_ORIGIN` | 允许的跨域来源，逗号分隔 | 无 |
| `IMAGE_RATE_LIMIT_PER_HOUR` | 单 IP 每小时生成次数，`0` 关闭限流 | `20` |
| `MAX_UPLOAD_IMAGES` | 单次参考图数量上限，可设为 `1`～`16` | `4` |

参考图只支持 PNG、JPG 和 WebP：单张最大 20MB，单次请求所有参考图合计最大 40MB。服务端还会检查图片文件头；40MB 总量是不可调高的资源保护上限。

主服务使用 `OPENAI_BASE_URL` 与 `OPENAI_API_KEY`。切换备用服务时设置 `OPENAI_PROVIDER=backup`，服务端会改用 `OPENAI_BACKUP_BASE_URL` 与 `OPENAI_BACKUP_API_KEY`；不设置备用地址时默认使用 `https://wasai.soyoung.com`。修改环境变量后需要重启服务。

当前默认上游必须同时兼容以下能力：

- `POST /v1/images/generations`：无参考图时文生图。
- `POST /v1/images/edits`：有参考图或基于最终图追加修改。
- `gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`，以及 `image[]` 多文件字段。
- `/v1/images/generations` 使用上游流式响应并支持阶段性预览；`/v1/images/edits` 在当前兼容服务上使用非流式上游请求，完成后仍通过浏览器端 SSE 返回最终图片，避免 `stream=true` 长时间无响应。

服务端不会在 Images API 不兼容时静默回退到其他接口，以免改变生成语义。更换兼容服务后应分别验证以上两个端点。

英语工作台使用独立接口，最多 16 张参考图、单张 20MB、总计 40MB。人物特征识别需配置可用的视觉模型；识别失败时可手动填写并审核特征。场景角色图必须填写对应关系。

`/english` 下方提供分镜精修区，可直接导入已有成图或载入上方生成结果：

- 矩形、多边形、笔刷和擦除选区，独立图层、显隐、锁定、排序、透明度及四角透视变形。
- 依据选区导入同尺寸修订图，或通过局部精修接口请求模型编辑；结果只在本地选区内合成，选区外保留原画面。选区复制不会自动修补原位置的内容。
- 原图等比叠加、差异显示和对应关键点偏差检查。关键点偏差以画布长边为基准，不代表整体还原度评分。
- 最近12步工程撤销/重做、浏览器 IndexedDB 自动草稿、工程 JSON 下载/恢复、无辅助标记的最终 PNG 导出。草稿不包含撤销历史或尚未应用的选区，重要版本应下载工程备份。
- 进入场景任务时默认使用 2048×1152（16:9）。局部编辑会等比缩放并补齐到接口支持的16倍数尺寸，结果再还原到工程画布，避免拉伸或裁切分镜。
- 固定约束以飞书《AI生图规范及薪资标准 1》为准；提示词参考只提供结构，每张图的人物、表情、动作、衣服、道具和场景细节必须随当前分镜调整，不照搬示例。人物身份参考角色图，衣着配饰优先服从当前分镜。

局部精修接口要求上游支持 `mask` PNG透明蒙版。是否支持需以实际供应商验证为准；不支持时返回错误，不自动改为整图重绘。可改用外部完成的同尺寸修订图进行本地选区合成。

## API

`GET /api/image-models`

页面加载时，服务端使用当前选中的 provider 地址和密钥查询上游 `GET /v1/models`，筛选 `supported_endpoint_types` 包含 `image-generation` 的模型并去重。返回 `models`、`defaultModel`（优先使用清单中的 `OPENAI_IMAGE_MODEL`，否则取第一项）和 `source: "upstream"`。提交图片请求时同样查询当前 provider 并校验模型，未显式指定模型时使用当前上游清单中的默认模型。

上游失败、格式错误或未声明图片能力时返回 HTTP 502 和明确错误，不使用本地静态列表兜底。该列表只表示上游声明的图像生成能力，并不证明每个模型都支持参考图编辑、蒙版和全部尺寸；这些能力需分别实际验证。

```json
{
  "models": ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"],
  "defaultModel": "gpt-image-2.6-flare",
  "source": "upstream"
}
```

`POST /api/english/extract-character` 和 `POST /api/english/generate-image-stream` 分别服务于新页面的人物特征识别和图片生成；图片生成允许更长的场景提示词和最多 16 张参考图。

`POST /api/english/refine-image-stream` 使用相同SSE返回格式，接受 `prompt`、`model`、`size`、`images` 和独立的 `mask` 文件。第一张 `images` 必须为PNG底图；`mask` 必须为相同尺寸、带透明通道的PNG，透明区域表示允许编辑。最多16张参考图加1张蒙版，所有文件合计不超过40MB，单张不超过20MB。

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
