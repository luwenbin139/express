require("dotenv").config();

const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const morgan = require("morgan");
const logger = morgan("tiny");
const openaiBaseUrl = (process.env.OPENAI_BASE_URL || "https://vibe.soyoung.com").replace(/\/+$/, "");
const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const responsesModel = process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || imageModel;
const allowedImageSizes = new Set([
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
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

    if (req.path === "/api/generate-image-stream") {
      res.writeHead(429, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
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
    fields: 3,
    parts: MAX_UPLOAD_IMAGES + 3,
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

function postJson(urlString, payload) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  const client = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let rawBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          rawBody += chunk;
        });
        response.on("end", () => {
          let data = {};

          try {
            data = rawBody ? JSON.parse(rawBody) : {};
          } catch (error) {
            reject(new Error("图片服务返回了无法解析的响应"));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = data.error && data.error.message ? data.error.message : "图片生成请求失败";
            reject(new Error(message));
            return;
          }

          resolve(data);
        });
      }
    );

    request.setTimeout(120000, () => {
      request.destroy(new Error("图片生成请求超时，请稍后重试"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

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

function parseImageRequest(req, res, next) {
  parseMultipartImageRequest(req, res, next, (message) => {
    res.status(400).send({
      code: 1,
      message,
    });
  });
}

function parseStreamImageRequest(req, res, next) {
  parseMultipartImageRequest(req, res, next, (message) => {
    res.writeHead(400, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
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

function createResponsesImagePayload(prompt, size, imageDataUrls, stream) {
  const content = [
    {
      type: "input_text",
      text: prompt,
    },
  ];

  for (const imageDataUrl of imageDataUrls) {
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

async function requestImageGeneration(prompt, size) {
  const data = await postJson(`${openaiBaseUrl}/v1/images/generations`, {
    model: imageModel,
    prompt,
    size,
    n: 1,
  });

  return {
    api: "images",
    data,
  };
}

async function requestResponsesImage(prompt, size, imageDataUrls) {
  const images = Array.isArray(imageDataUrls) ? imageDataUrls : [];
  const data = await postJson(`${openaiBaseUrl}/v1/responses`, createResponsesImagePayload(prompt, size, images, false));

  return {
    api: images.length > 0 ? "responses_edit" : "responses",
    data,
  };
}

async function generateImage(prompt, size) {
  try {
    return await requestImageGeneration(prompt, size);
  } catch (imageError) {
    try {
      return await requestResponsesImage(prompt, size, []);
    } catch (responsesError) {
      responsesError.message = `${responsesError.message}；图片接口错误：${imageError.message}`;
      throw responsesError;
    }
  }
}

async function editImage(prompt, size, imageDataUrls) {
  return requestResponsesImage(prompt, size, imageDataUrls);
}

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

  if (data.type === "response.output_item.done" && isPlainObject(data.item) && typeof data.item.result === "string") {
    context.finalImage = `data:image/png;base64,${data.item.result}`;
    sendSseEventIfWritable(context.res, "final_image", {
      image: context.finalImage,
      model: imageModel,
      responsesModel,
      api: context.images.length > 0 ? "responses_stream_edit" : "responses_stream",
    });
    return;
  }

  if (data.type === "response.completed") {
    sendSseEventIfWritable(context.res, "done", {
      image: context.finalImage,
      model: imageModel,
      responsesModel,
      api: context.images.length > 0 ? "responses_stream_edit" : "responses_stream",
    });
  }
}

function streamResponsesImage(prompt, size, imageDataUrls, res) {
  const images = Array.isArray(imageDataUrls) ? imageDataUrls : [];
  const url = new URL(`${openaiBaseUrl}/v1/responses`);
  const body = JSON.stringify(createResponsesImagePayload(prompt, size, images, true));
  const client = url.protocol === "http:" ? http : https;
  let upstreamRequest;
  let upstreamBody = "";
  let sseBuffer = "";
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
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
          upstreamResponse.on("data", (chunk) => {
            upstreamBody += chunk;
          });
          upstreamResponse.on("end", () => {
            sendStreamError(
              `图片服务返回异常：HTTP ${upstreamResponse.statusCode} ${contentType}`,
              upstreamBody.slice(0, 500)
            );
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
          return;
        }

        sendSseEventIfWritable(res, "status", {
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
          sseBuffer += chunk;
          const blocks = sseBuffer.split(/\r?\n\r?\n/);
          sseBuffer = blocks.pop() || "";

          for (const block of blocks) {
            processResponsesSseBlock(block, sseContext);
          }
        });

        upstreamResponse.on("end", () => {
          if (sseBuffer.trim()) {
            processResponsesSseBlock(sseBuffer, sseContext);
            sseBuffer = "";
          }
          resolveOnce();
        });
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

// 由服务端代理调用图片模型，避免在浏览器中暴露 API Key。
app.post("/api/generate-image", imageRateLimiter, parseImageRequest, async (req, res) => {
  const prompt = typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  const size = allowedImageSizes.has(req.body.size) ? req.body.size : "1024x1024";
  const mode = req.body.mode === "edit" ? "edit" : "generate";
  let imageDataUrls = [];

  try {
    imageDataUrls = getRequestImageDataUrls(req);
  } catch (error) {
    res.status(400).send({
      code: 1,
      message: error.message,
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).send({
      code: 1,
      message: "服务端缺少 OPENAI_API_KEY 环境变量",
    });
    return;
  }

  if (!prompt) {
    res.status(400).send({
      code: 1,
      message: "请输入图片提示词",
    });
    return;
  }

  if (prompt.length > 2000) {
    res.status(400).send({
      code: 1,
      message: "提示词最多 2000 个字符",
    });
    return;
  }

  if (mode === "edit" && imageDataUrls.length === 0) {
    res.status(400).send({
      code: 1,
      message: "图片编辑模式需要上传 PNG、JPG 或 WebP 原图",
    });
    return;
  }

  try {
    const result = mode === "edit" ? await editImage(prompt, size, imageDataUrls) : await generateImage(prompt, size);
    const data = result.data;
    const image = normalizeImagePayload(data);

    if (!image) {
      res.status(502).send({
        code: 1,
        message: "图片服务未返回可展示的图片",
      });
      return;
    }

    res.send({
      code: 0,
      data: {
        image,
        model: imageModel,
        responsesModel,
        api: result.api,
      },
    });
  } catch (error) {
    res.status(502).send({
      code: 1,
      message: error.message || "图片生成失败",
    });
  }
});

app.post("/api/generate-image-stream", imageRateLimiter, parseStreamImageRequest, async (req, res) => {
  const prompt = typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  const size = allowedImageSizes.has(req.body.size) ? req.body.size : "1024x1024";
  const mode = req.body.mode === "edit" ? "edit" : "generate";
  let imageDataUrls = [];
  let heartbeatTimer;

  try {
    imageDataUrls = getRequestImageDataUrls(req);
  } catch (error) {
    res.writeHead(400, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    sendSseEvent(res, "error", { message: error.message });
    res.end();
    return;
  }

  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });

  if (!process.env.OPENAI_API_KEY) {
    sendSseEvent(res, "error", {
      message: "服务端缺少 OPENAI_API_KEY 环境变量",
    });
    res.end();
    return;
  }

  if (!prompt) {
    sendSseEvent(res, "error", {
      message: "请输入图片提示词",
    });
    res.end();
    return;
  }

  if (prompt.length > 2000) {
    sendSseEvent(res, "error", {
      message: "提示词最多 2000 个字符",
    });
    res.end();
    return;
  }

  if (mode === "edit" && imageDataUrls.length === 0) {
    sendSseEvent(res, "error", {
      message: "图片编辑模式需要上传 PNG、JPG 或 WebP 原图",
    });
    res.end();
    return;
  }

  heartbeatTimer = startSseHeartbeat(res);

  try {
    await streamResponsesImage(prompt, size, mode === "edit" ? imageDataUrls : [], res);
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
