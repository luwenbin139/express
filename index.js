require("dotenv").config();

const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const morgan = require("morgan");
const logger = morgan("tiny");
const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const responsesModel = process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || "gpt-5.5";
const allowedImageSizes = new Set([
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1280x1024",
  "1920x1080",
  "3840x2160",
  "5760x3240",
  "1080x1920",
  "2160x3840",
  "3240x5760",
]);
const MAX_UPLOAD_IMAGES = 4;
const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
const JSON_BODY_LIMIT = "60mb";
const allowedUploadMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const imageDataUrlPattern = /^data:(image\/(png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i;
const IMAGE_STREAM_ROUTE = "/api/generate-image-stream";

// 默认走 IAI；保留 default provider 只是为了手动切回旧通道排障。
function resolveImageProvider(value) {
  const providerId = value === "default" ? "default" : "iai";

  if (providerId === "iai") {
    return {
      id: "iai",
      baseUrl: (process.env.IAI_BASE_URL || "https://iai.soyoung.com").replace(/\/+$/, ""),
      apiKey: process.env.IAI_API_KEY || "",
      missingKeyEnv: "IAI_API_KEY",
    };
  }

  return {
    id: "default",
    baseUrl: (process.env.OPENAI_BASE_URL || "https://vibe.soyoung.com").replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_API_KEY || "",
    missingKeyEnv: "OPENAI_API_KEY",
  };
}

function parseAllowedCorsOrigins(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function createCorsOptions() {
  const allowedOrigins = parseAllowedCorsOrigins(process.env.CORS_ORIGIN);

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  };
}

// 轻量限流放在内存里，够当前单实例服务使用；多实例部署时应换成 Redis 等共享存储。
function getImageRateLimitPerHour() {
  const parsed = Number.parseInt(process.env.IMAGE_RATE_LIMIT_PER_HOUR || "20", 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 20;
  }

  return parsed;
}

function createImageRateLimiter() {
  const windowMs = 60 * 60 * 1000;
  const requestsByIp = new Map();

  return function imageRateLimiter(req, res, next) {
    const limit = getImageRateLimitPerHour();

    if (limit === 0) {
      next();
      return;
    }

    const now = Date.now();
    const key = req.ip || req.connection.remoteAddress || "unknown";

    for (const [ip, entry] of requestsByIp) {
      if (entry.resetAt <= now) {
        requestsByIp.delete(ip);
      }
    }

    const entry = requestsByIp.get(key) || { count: 0, resetAt: now + windowMs };

    if (entry.resetAt <= now) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    requestsByIp.set(key, entry);

    if (entry.count <= limit) {
      next();
      return;
    }

    const message = "图片生成请求过于频繁，请稍后再试";

    if (req.path === IMAGE_STREAM_ROUTE) {
      writeSseHead(res, 429);
      sendSseEvent(res, "error", { message });
      res.end();
      return;
    }

    res.status(429).send({
      code: 1,
      message,
    });
  };
}

const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_UPLOAD_IMAGES,
    fileSize: MAX_UPLOAD_IMAGE_BYTES,
    fields: 4,
    parts: MAX_UPLOAD_IMAGES + 4,
    fieldSize: 8 * 1024,
    fieldNameSize: 32,
  },
  fileFilter(req, file, callback) {
    if (!allowedUploadMimeTypes.has(file.mimetype)) {
      callback(new Error("仅支持 PNG、JPG 或 WebP 图片"));
      return;
    }

    callback(null, true);
  },
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(cors(createCorsOptions()));
app.use(logger);
// 静态资源目录
app.use(express.static(path.join(__dirname, "build")));

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "build/index.html"));
});

// 图片接口的返回格式在不同兼容服务之间不完全一致，这里统一抽成浏览器可直接展示的 URL/data URL。
function isLikelyBase64Image(value) {
  return typeof value === "string" && value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value);
}

function normalizeImagePayload(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:image/")) {
      return value;
    }

    if (isLikelyBase64Image(value)) {
      return `data:image/png;base64,${value}`;
    }

    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const image = normalizeImagePayload(item);
      if (image) {
        return image;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    return (
      normalizeImagePayload(value.url) ||
      normalizeImagePayload(value.image_url) ||
      normalizeImagePayload(value.b64_json) ||
      normalizeImagePayload(value.image_base64) ||
      normalizeImagePayload(value.result) ||
      normalizeImagePayload(value.data) ||
      normalizeImagePayload(value.output) ||
      normalizeImagePayload(value.content)
    );
  }

  return null;
}

function isImageDataUrl(value) {
  return typeof value === "string" && imageDataUrlPattern.test(value);
}

function parseImageDataUrl(imageDataUrl) {
  const match = typeof imageDataUrl === "string" ? imageDataUrl.match(imageDataUrlPattern) : null;

  if (!match) {
    return null;
  }

  const mimetype = normalizeImageMimeType(match[1].toLowerCase());
  const base64Data = match[3];

  return {
    mimetype,
    buffer: Buffer.from(base64Data, "base64"),
  };
}

function normalizeImageMimeType(mimetype) {
  return mimetype === "image/jpg" ? "image/jpeg" : mimetype;
}

function getImageDataUrlDecodedByteLength(imageDataUrl) {
  const base64Data = imageDataUrl.slice(imageDataUrl.indexOf(",") + 1);
  const padding = base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0;

  return (base64Data.length / 4) * 3 - padding;
}

function collectJsonImageDataUrls(body) {
  const imageCandidates = [];

  if (body && typeof body.image === "string") {
    imageCandidates.push(body.image);
  }

  if (body && Array.isArray(body.images)) {
    for (const image of body.images) {
      if (typeof image === "string") {
        imageCandidates.push(image);
      }
    }
  }

  return imageCandidates.map((image) => image.trim()).filter(Boolean);
}

// 除了 MIME，还检查图片头，避免把伪装成图片的任意 base64 传给上游服务。
function validateImageDataUrls(imageDataUrls) {
  if (imageDataUrls.length > MAX_UPLOAD_IMAGES) {
    throw new Error(`最多上传 ${MAX_UPLOAD_IMAGES} 张图片`);
  }

  for (const imageDataUrl of imageDataUrls) {
    if (!isImageDataUrl(imageDataUrl)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    if (getImageDataUrlDecodedByteLength(imageDataUrl) > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error("单张图片最大 10MB");
    }

    const parsedImageDataUrl = parseImageDataUrl(imageDataUrl);

    if (!parsedImageDataUrl || !isImageMagicValid(parsedImageDataUrl.mimetype, parsedImageDataUrl.buffer)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }
  }

  return imageDataUrls;
}

function convertUploadedFilesToDataUrls(files) {
  const uploadedFiles = Array.isArray(files) ? files : [];

  if (uploadedFiles.length > MAX_UPLOAD_IMAGES) {
    throw new Error(`最多上传 ${MAX_UPLOAD_IMAGES} 张图片`);
  }

  return uploadedFiles.map((file) => {
    if (!file || !allowedUploadMimeTypes.has(file.mimetype)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);
    const size = typeof file.size === "number" ? file.size : buffer.length;

    if (size > MAX_UPLOAD_IMAGE_BYTES || buffer.length > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error("单张图片最大 10MB");
    }

    if (!isImageMagicValid(file.mimetype, buffer)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    return `data:${file.mimetype};base64,${buffer.toString("base64")}`;
  });
}

// multipart 请求由 multer 初筛，这里再次校验文件头，保证 JSON 和 multipart 两条入口一致。
function isImageMagicValid(mimetype, buffer) {
  if (mimetype === "image/png") {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  if (mimetype === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimetype === "image/webp") {
    return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  }

  return false;
}

function isMultipartRequest(req) {
  return Boolean(req.is && req.is("multipart/form-data"));
}

function getMulterErrorMessage(error) {
  if (error && error.code) {
    const messages = {
      LIMIT_FILE_SIZE: "单张图片最大 10MB",
      LIMIT_FILE_COUNT: `最多上传 ${MAX_UPLOAD_IMAGES} 张图片`,
      LIMIT_FIELD_COUNT: "上传字段过多",
      LIMIT_FIELD_VALUE: "上传字段内容过长",
      LIMIT_PART_COUNT: "上传内容过多",
      LIMIT_FIELD_KEY: "上传字段名过长",
    };

    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      return error.field && error.field !== "images" ? "请使用 images 字段上传图片" : `最多上传 ${MAX_UPLOAD_IMAGES} 张图片`;
    }

    if (messages[error.code]) {
      return messages[error.code];
    }
  }

  return (error && error.message) || "图片上传失败";
}

function parseMultipartImageRequest(req, res, next, onError) {
  if (!isMultipartRequest(req)) {
    next();
    return;
  }

  uploadImages.array("images", MAX_UPLOAD_IMAGES)(req, res, (error) => {
    if (error) {
      onError(getMulterErrorMessage(error));
      return;
    }

    next();
  });
}

function parseStreamImageRequest(req, res, next) {
  parseMultipartImageRequest(req, res, next, (message) => {
    writeSseHead(res, 400);
    sendSseEvent(res, "error", { message });
    res.end();
  });
}

function getRequestImageDataUrls(req) {
  if (isMultipartRequest(req)) {
    return validateImageDataUrls(convertUploadedFilesToDataUrls(req.files));
  }

  return validateImageDataUrls(collectJsonImageDataUrls(req.body));
}

// gpt-5.5 这类 Responses 主模型可能把短 prompt 当普通聊天；明确要求它必须调用图片工具。
function createImageInstructionText(prompt, hasReferenceImages) {
  const referenceInstruction = hasReferenceImages
    ? "参考用户上传的图片进行编辑或再创作。"
    : "不需要等待用户补充参考图。";

  return [
    "这是一个图片生成请求，不是普通聊天请求。",
    "必须调用 image_generation 工具输出图片，不要只回复文字。",
    referenceInstruction,
    "用户的原始图片描述如下：",
    prompt,
  ].join("\n");
}

// Responses API: model 是主模型，image_generation 是工具；图片模型不要直接放在 model 字段。
function createResponsesImagePayload(prompt, size, imageDataUrls, stream) {
  const images = Array.isArray(imageDataUrls) ? imageDataUrls : [];
  const content = [
    {
      type: "input_text",
      text: createImageInstructionText(prompt, images.length > 0),
    },
  ];

  for (const imageDataUrl of images) {
    content.push({
      type: "input_image",
      image_url: imageDataUrl,
    });
  }

  return {
    model: responsesModel,
    input: [
      {
        role: "user",
        content,
      },
    ],
    tools: [
      {
        type: "image_generation",
        size,
      },
    ],
    store: false,
    stream,
  };
}

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseHead(res, statusCode = 200) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
}

function endSseWithError(res, message, extra) {
  sendSseEvent(res, "error", {
    message,
    ...(extra || {}),
  });
  res.end();
}

function sendSseEventIfWritable(res, event, data) {
  if (!res.destroyed && !res.writableEnded) {
    sendSseEvent(res, event, data);
    return true;
  }

  return false;
}

function startSseHeartbeat(res) {
  const timer = setInterval(() => {
    sendSseEventIfWritable(res, "heartbeat", {
      message: "生成仍在进行，请继续等待",
      timestamp: Date.now(),
    });
  }, 20000);

  res.on("close", () => {
    clearInterval(timer);
  });

  return timer;
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  return {
    event: eventLine ? eventLine.slice(6).trim() : "message",
    data,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStreamImageApiName(context) {
  return context.images.length > 0 ? "responses_stream_edit" : "responses_stream";
}

function getStreamImageMetadata(context) {
  return {
    model: imageModel,
    responsesModel,
    api: getStreamImageApiName(context),
  };
}

function getResponseOutputSummary(data) {
  const output = data && data.response && Array.isArray(data.response.output) ? data.response.output : [];

  return output
    .map((item) => {
      if (!isPlainObject(item)) {
        return typeof item;
      }

      const label = [item.type, item.status].filter(Boolean).join(":") || "object";

      if (item.type !== "message") {
        return label;
      }

      const text = normalizeMessageOutputText(item);
      return text ? `${label}:${text.slice(0, 160)}` : label;
    })
    .slice(0, 10);
}

function normalizeMessageOutputText(item) {
  const content = Array.isArray(item.content) ? item.content : [];

  for (const part of content) {
    if (!isPlainObject(part)) {
      continue;
    }

    if (typeof part.text === "string") {
      return part.text;
    }

    if (typeof part.output_text === "string") {
      return part.output_text;
    }
  }

  return "";
}

function sendFinalImageIfFound(context, payload) {
  const image = normalizeImagePayload(payload);

  if (!image) {
    return false;
  }

  context.finalImage = image;
  sendSseEventIfWritable(context.res, "final_image", {
    image: context.finalImage,
    ...getStreamImageMetadata(context),
  });
  return true;
}

// 把上游 Responses SSE 翻译成前端只关心的 status/partial_image/final_image/done/error。
function processResponsesSseBlock(block, context) {
  const parsed = parseSseBlock(block.trim());
  if (!parsed.data || parsed.data === "[DONE]") {
    return;
  }

  let data;
  try {
    data = JSON.parse(parsed.data);
  } catch (error) {
    return;
  }

  if (!isPlainObject(data) || typeof data.type !== "string") {
    return;
  }

  if (data.type === "response.image_generation_call.in_progress") {
    sendSseEventIfWritable(context.res, "status", {
      message: "图片任务已开始...",
    });
    return;
  }

  if (data.type === "response.image_generation_call.generating") {
    sendSseEventIfWritable(context.res, "status", {
      message: "正在生成图片，请继续等待...",
    });
    return;
  }

  if (data.type === "response.image_generation_call.partial_image" && typeof data.partial_image_b64 === "string") {
    sendSseEventIfWritable(context.res, "partial_image", {
      image: `data:image/png;base64,${data.partial_image_b64}`,
    });
    return;
  }

  if (data.type === "response.output_item.done" && isPlainObject(data.item)) {
    sendFinalImageIfFound(context, data.item);
    return;
  }

  if (data.type === "response.completed") {
    // 有些服务只在 completed.response.output 里给最终图，所以这里做一次兜底提取。
    if (!context.finalImage) {
      sendFinalImageIfFound(context, data.response && data.response.output);
    }

    if (!context.finalImage) {
      sendSseEventIfWritable(context.res, "error", {
        message: "图片服务已完成，但未返回可展示的图片",
        responseStatus: data.response && data.response.status,
        output: getResponseOutputSummary(data),
        ...getStreamImageMetadata(context),
      });
      return;
    }

    sendSseEventIfWritable(context.res, "done", {
      image: context.finalImage,
      ...getStreamImageMetadata(context),
    });
  }
}

function processResponsesSseChunk(chunk, state, context) {
  state.buffer += chunk;
  const blocks = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = blocks.pop() || "";

  for (const block of blocks) {
    processResponsesSseBlock(block, context);
  }
}

function flushResponsesSseBuffer(state, context) {
  if (!state.buffer.trim()) {
    return;
  }

  processResponsesSseBlock(state.buffer, context);
  state.buffer = "";
}

// 非 event-stream 通常是模型名、鉴权或参数错误；保留一小段 body 方便前端直接看到原因。
function handleBadUpstreamResponse(upstreamResponse, sendStreamError, resolveOnce) {
  const contentType = upstreamResponse.headers["content-type"] || "";
  let body = "";

  upstreamResponse.on("data", (chunk) => {
    body += chunk;
  });
  upstreamResponse.on("end", () => {
    sendStreamError(`图片服务返回异常：HTTP ${upstreamResponse.statusCode} ${contentType}`, body.slice(0, 500));
    resolveOnce();
  });
  upstreamResponse.on("error", (error) => {
    sendStreamError(error.message || "图片生成流响应失败");
    resolveOnce();
  });
  upstreamResponse.on("aborted", () => {
    sendStreamError("图片生成流响应已中断");
    resolveOnce();
  });
}

function handleGoodUpstreamStream(upstreamResponse, context, state, sendStreamError, resolveOnce) {
  sendSseEventIfWritable(context.res, "status", {
    message: "已连接图片生成流，正在等待模型返回...",
  });

  upstreamResponse.on("error", (error) => {
    sendStreamError(error.message || "图片生成流响应失败");
    resolveOnce();
  });
  upstreamResponse.on("aborted", () => {
    sendStreamError("图片生成流响应已中断");
    resolveOnce();
  });
  upstreamResponse.on("data", (chunk) => {
    processResponsesSseChunk(chunk, state, context);
  });
  upstreamResponse.on("end", () => {
    flushResponsesSseBuffer(state, context);
    resolveOnce();
  });
}

// 服务端代理上游流，避免浏览器暴露 API Key，并把上游事件整理成自己的 SSE 协议。
function streamResponsesImage(prompt, size, imageDataUrls, res, provider) {
  const images = Array.isArray(imageDataUrls) ? imageDataUrls : [];
  const url = new URL(`${provider.baseUrl}/v1/responses`);
  const body = JSON.stringify(createResponsesImagePayload(prompt, size, images, true));
  const client = url.protocol === "http:" ? http : https;
  let upstreamRequest;
  const sseState = { buffer: "" };
  const sseContext = {
    finalImage: "",
    images,
    res,
  };

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const sendStreamError = (message, detail) => {
      if (settled) {
        return;
      }

      const data = { message };

      if (detail) {
        data.detail = detail;
      }

      sendSseEventIfWritable(res, "error", data);
    };

    upstreamRequest = client.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (upstreamResponse) => {
        const contentType = upstreamResponse.headers["content-type"] || "";
        const isEventStream = contentType.includes("text/event-stream");

        upstreamResponse.setEncoding("utf8");

        if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300 || !isEventStream) {
          handleBadUpstreamResponse(upstreamResponse, sendStreamError, resolveOnce);
          return;
        }

        handleGoodUpstreamStream(upstreamResponse, sseContext, sseState, sendStreamError, resolveOnce);
      }
    );

    upstreamRequest.setTimeout(12 * 60 * 1000, () => {
      upstreamRequest.destroy(new Error("图片生成流请求超时，请稍后重试"));
    });
    upstreamRequest.on("error", (error) => {
      sendStreamError(error.message || "图片生成流请求失败");
      resolveOnce();
    });
    upstreamRequest.write(body);
    upstreamRequest.end();

    res.on("close", () => {
      if (upstreamRequest) {
        upstreamRequest.destroy();
      }
      resolveOnce();
    });
  });
}

const imageRateLimiter = createImageRateLimiter();

function getImageStreamRequest(req, imageDataUrls) {
  return {
    imageDataUrls,
    mode: req.body.mode === "edit" ? "edit" : "generate",
    prompt: typeof req.body.prompt === "string" ? req.body.prompt.trim() : "",
    provider: resolveImageProvider(req.body.provider),
    size: allowedImageSizes.has(req.body.size) ? req.body.size : "1024x1024",
  };
}

function getImageStreamValidationError(request) {
  if (!request.provider.apiKey) {
    return `服务端缺少 ${request.provider.missingKeyEnv} 环境变量`;
  }

  if (!request.prompt) {
    return "请输入图片提示词";
  }

  if (request.prompt.length > 2000) {
    return "提示词最多 2000 个字符";
  }

  if (request.mode === "edit" && request.imageDataUrls.length === 0) {
    return "图片编辑模式需要上传 PNG、JPG 或 WebP 原图";
  }

  return "";
}

app.post(IMAGE_STREAM_ROUTE, imageRateLimiter, parseStreamImageRequest, async (req, res) => {
  let imageDataUrls = [];
  let heartbeatTimer;

  try {
    imageDataUrls = getRequestImageDataUrls(req);
  } catch (error) {
    writeSseHead(res, 400);
    endSseWithError(res, error.message);
    return;
  }

  writeSseHead(res);

  const request = getImageStreamRequest(req, imageDataUrls);
  const validationError = getImageStreamValidationError(request);

  if (validationError) {
    endSseWithError(res, validationError);
    return;
  }

  heartbeatTimer = startSseHeartbeat(res);

  try {
    await streamResponsesImage(
      request.prompt,
      request.size,
      request.mode === "edit" ? request.imageDataUrls : [],
      res,
      request.provider
    );
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    res.end();
  }
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

const port = process.env.PORT || 80;

if (require.main === module) {
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

module.exports = {
  app,
  parseAllowedCorsOrigins,
  createCorsOptions,
  getImageRateLimitPerHour,
  createImageRateLimiter,
  resolveImageProvider,
  isImageDataUrl,
  normalizeImagePayload,
  getImageDataUrlDecodedByteLength,
  collectJsonImageDataUrls,
  validateImageDataUrls,
  convertUploadedFilesToDataUrls,
  MAX_UPLOAD_IMAGES,
  MAX_UPLOAD_IMAGE_BYTES,
  JSON_BODY_LIMIT,
  allowedUploadMimeTypes,
};
