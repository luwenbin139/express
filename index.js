require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const morgan = require("morgan");

const logger = morgan("tiny");
const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const CUSTOM_IMAGE_SIZE_PATTERN = /^(\d+)x(\d+)$/;
const CUSTOM_IMAGE_MODELS = new Set(["gpt-image-2", "gpt-image-2-2026-04-21"]);
const MIN_CUSTOM_IMAGE_PIXELS = 655_360;
const MAX_CUSTOM_IMAGE_PIXELS = 8_294_400;
const MAX_CUSTOM_IMAGE_EDGE = 3840;
const MAX_IMAGES_API_REFERENCE_IMAGES = 16;
const DEFAULT_MAX_UPLOAD_IMAGES = 4;
const MAX_UPLOAD_IMAGES = getMaxUploadImages(process.env.MAX_UPLOAD_IMAGES);
const MAX_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_MULTIPART_METADATA_OVERHEAD_BYTES = 64 * 1024;
const MAX_MULTIPART_BOUNDARY_OVERHEAD_BYTES = 512;
const JSON_BODY_LIMIT = "60mb";
const IMAGE_PARTIAL_COUNT = 1;
const IMAGE_REQUEST_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_IMAGE_SIZE = "auto";
const allowedUploadMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const imageDataUrlPattern = /^data:(image\/(png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i;
const IMAGE_STREAM_ROUTE = "/api/generate-image-stream";

function getMaxUploadImages(value) {
  const parsed = Number(String(value ?? "").trim());

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_IMAGES_API_REFERENCE_IMAGES) {
    return DEFAULT_MAX_UPLOAD_IMAGES;
  }

  return parsed;
}

function resolveImageProvider() {
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
      sendSseEvent(res, "error", {
        message,
        requestId: getImageRequestId(req),
      });
      finishImageRequestMetric(req, {
        outcome: "rate_limited",
        httpStatus: 429,
        errorStage: "rate_limit",
      });
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
    parts: MAX_UPLOAD_IMAGES + 5,
    fileSize: MAX_UPLOAD_IMAGE_BYTES,
    fields: 4,
    fieldSize: 8 * 1024,
    fieldNameSize: 32,
  },
  fileFilter(req, file, callback) {
    if (file.fieldname !== "images") {
      callback(new Error("请使用 images 字段上传图片"));
      return;
    }

    if (!allowedUploadMimeTypes.has(file.mimetype)) {
      callback(new Error("仅支持 PNG、JPG 或 WebP 图片"));
      return;
    }

    callback(null, true);
  },
});

function getUploadImageLimitMessage(maxImages = MAX_UPLOAD_IMAGES) {
  return `最多上传 ${maxImages} 张图片`;
}

function getUploadTotalLimitMessage(maxTotalBytes = MAX_UPLOAD_TOTAL_BYTES) {
  return `参考图合计最大 ${Math.round(maxTotalBytes / (1024 * 1024))}MB`;
}

function isAllowedImageSize(value) {
  if (value === "auto") {
    return true;
  }

  const match = typeof value === "string" ? value.match(CUSTOM_IMAGE_SIZE_PATTERN) : null;
  if (!match || !CUSTOM_IMAGE_MODELS.has(imageModel)) {
    return false;
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  const pixels = width * height;
  const ratio = width / height;

  return (
    width % 16 === 0 &&
    height % 16 === 0 &&
    width <= MAX_CUSTOM_IMAGE_EDGE &&
    height <= MAX_CUSTOM_IMAGE_EDGE &&
    pixels >= MIN_CUSTOM_IMAGE_PIXELS &&
    pixels <= MAX_CUSTOM_IMAGE_PIXELS &&
    ratio >= 1 / 3 &&
    ratio <= 3
  );
}

function initializeImageRequest(req, res, next) {
  if (req.method !== "POST" || req.path !== IMAGE_STREAM_ROUTE) {
    next();
    return;
  }

  const requestId = crypto.randomUUID();
  req.imageRequestMetrics = {
    requestId,
    startedAt: Date.now(),
  };
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("Access-Control-Expose-Headers", "X-Request-ID");
  next();
}

const app = express();
app.use(cors(createCorsOptions()));
app.use(logger);
app.use(initializeImageRequest);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, "build")));

app.get(["/", "/generator", "/tools"], async (req, res) => {
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

function normalizeImageMimeType(mimetype) {
  return mimetype === "image/jpg" ? "image/jpeg" : mimetype;
}

function parseImageDataUrl(imageDataUrl) {
  const match = typeof imageDataUrl === "string" ? imageDataUrl.match(imageDataUrlPattern) : null;

  if (!match) {
    return null;
  }

  return {
    mimetype: normalizeImageMimeType(match[1].toLowerCase()),
    buffer: Buffer.from(match[3], "base64"),
  };
}

function getImageDataUrlDecodedByteLength(imageDataUrl) {
  const match = typeof imageDataUrl === "string" ? imageDataUrl.match(imageDataUrlPattern) : null;
  if (!match) {
    return 0;
  }

  const base64Data = match[3];
  const padding = base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64Data.length * 3) / 4) - padding);
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

// multipart 请求由 multer 初筛，这里再次检查文件头；JSON 和 multipart 最终共用数量与字节限制。
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

function getReferenceImageLimits(overrides = {}) {
  return {
    maxImages: overrides.maxImages ?? MAX_UPLOAD_IMAGES,
    maxImageBytes: overrides.maxImageBytes ?? MAX_UPLOAD_IMAGE_BYTES,
    maxTotalBytes: overrides.maxTotalBytes ?? MAX_UPLOAD_TOTAL_BYTES,
  };
}

function validateReferenceImages(images, overrides) {
  const limits = getReferenceImageLimits(overrides);

  if (images.length > limits.maxImages) {
    throw new Error(getUploadImageLimitMessage(limits.maxImages));
  }

  let totalBytes = 0;

  for (const image of images) {
    if (!image || !allowedUploadMimeTypes.has(image.mimetype) || !Buffer.isBuffer(image.buffer)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    const size = image.buffer.length;

    if (size > limits.maxImageBytes || (Number.isFinite(image.declaredSize) && image.declaredSize > limits.maxImageBytes)) {
      throw new Error(`单张图片最大 ${Math.round(limits.maxImageBytes / (1024 * 1024))}MB`);
    }

    if (!isImageMagicValid(image.mimetype, image.buffer)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    image.size = size;
    totalBytes += size;

    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(getUploadTotalLimitMessage(limits.maxTotalBytes));
    }
  }

  return images;
}

function validateImageDataUrls(imageDataUrls, overrides) {
  const limits = getReferenceImageLimits(overrides);

  if (imageDataUrls.length > limits.maxImages) {
    throw new Error(getUploadImageLimitMessage(limits.maxImages));
  }

  let estimatedTotalBytes = 0;
  const images = imageDataUrls.map((imageDataUrl) => {
    if (!isImageDataUrl(imageDataUrl)) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    const decodedBytes = getImageDataUrlDecodedByteLength(imageDataUrl);
    if (decodedBytes > limits.maxImageBytes) {
      throw new Error(`单张图片最大 ${Math.round(limits.maxImageBytes / (1024 * 1024))}MB`);
    }

    estimatedTotalBytes += decodedBytes;
    if (estimatedTotalBytes > limits.maxTotalBytes) {
      throw new Error(getUploadTotalLimitMessage(limits.maxTotalBytes));
    }

    const parsed = parseImageDataUrl(imageDataUrl);

    if (!parsed) {
      throw new Error("仅支持 PNG、JPG 或 WebP 图片");
    }

    return {
      mimetype: parsed.mimetype,
      buffer: parsed.buffer,
      size: parsed.buffer.length,
    };
  });

  return validateReferenceImages(images, limits);
}

function normalizeUploadedFiles(files, overrides) {
  const uploadedFiles = Array.isArray(files) ? files : [];
  const limits = getReferenceImageLimits(overrides);

  if (uploadedFiles.length > limits.maxImages) {
    throw new Error(getUploadImageLimitMessage(limits.maxImages));
  }

  const images = uploadedFiles.map((file) => {
    const mimetype = file && normalizeImageMimeType(file.mimetype);
    const buffer = file && Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);

    return {
      mimetype,
      buffer,
      size: buffer.length,
      declaredSize: file && typeof file.size === "number" ? file.size : undefined,
    };
  });

  return validateReferenceImages(images, limits);
}

function isMultipartRequest(req) {
  return Boolean(req.is && req.is("multipart/form-data"));
}

function getMaxMultipartRequestBytes(maxImages = MAX_UPLOAD_IMAGES) {
  return (
    MAX_UPLOAD_TOTAL_BYTES +
    MAX_MULTIPART_METADATA_OVERHEAD_BYTES +
    maxImages * MAX_MULTIPART_BOUNDARY_OVERHEAD_BYTES
  );
}

function getMultipartContentLengthError(req) {
  if (!isMultipartRequest(req)) {
    return "";
  }

  const header = req.headers && req.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;

  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return "";
  }

  const contentLength = Number(value);
  return contentLength > getMaxMultipartRequestBytes() ? getUploadTotalLimitMessage() : "";
}

function getMulterErrorMessage(error) {
  if (error && error.code) {
    const messages = {
      LIMIT_FILE_SIZE: "单张图片最大 20MB",
      LIMIT_FILE_COUNT: getUploadImageLimitMessage(),
      LIMIT_FIELD_COUNT: "上传字段过多",
      LIMIT_FIELD_VALUE: "上传字段内容过长",
      LIMIT_PART_COUNT: "上传内容过多",
      LIMIT_FIELD_KEY: "上传字段名过长",
    };

    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      return error.field && error.field !== "images" ? "请使用 images 字段上传图片" : getUploadImageLimitMessage();
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

  const contentLengthError = getMultipartContentLengthError(req);
  if (contentLengthError) {
    onError(contentLengthError);
    return;
  }

  const parseImages = uploadImages.fields([{ name: "images", maxCount: MAX_UPLOAD_IMAGES }]);

  parseImages(req, res, (error) => {
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
    sendSseEvent(res, "error", {
      message,
      requestId: getImageRequestId(req),
    });
    finishImageRequestMetric(req, {
      outcome: "rejected",
      httpStatus: 400,
      errorStage: "upload",
    });
    res.end();
  });
}

function getMultipartFiles(req, field) {
  if (!req.files || Array.isArray(req.files)) {
    return field === "images" && Array.isArray(req.files) ? req.files : [];
  }

  return Array.isArray(req.files[field]) ? req.files[field] : [];
}

function getRequestImageInput(req) {
  if (isMultipartRequest(req)) {
    return normalizeUploadedFiles(getMultipartFiles(req, "images"));
  }

  return validateImageDataUrls(collectJsonImageDataUrls(req.body));
}

function createImageGenerationPayload(prompt, size) {
  return {
    model: imageModel,
    prompt,
    size,
    stream: true,
    partial_images: IMAGE_PARTIAL_COUNT,
  };
}

function getImageFileExtension(mimetype) {
  if (mimetype === "image/jpeg") {
    return "jpg";
  }

  if (mimetype === "image/webp") {
    return "webp";
  }

  return "png";
}

function createImageEditFormData(prompt, size, images) {
  const formData = new FormData();
  formData.append("model", imageModel);
  formData.append("prompt", prompt);
  formData.append("size", size);
  formData.append("stream", "true");
  formData.append("partial_images", String(IMAGE_PARTIAL_COUNT));

  images.forEach((image, index) => {
    const blob = new Blob([image.buffer], { type: image.mimetype });
    formData.append("image[]", blob, `reference-${index + 1}.${getImageFileExtension(image.mimetype)}`);
  });

  return formData;
}

function getImagesApiPath(operation) {
  return operation === "edit" ? "/v1/images/edits" : "/v1/images/generations";
}

function getImageStreamRequest(req, referenceImages) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const rawSize = body.size;
  const hasExplicitSize = rawSize !== undefined && rawSize !== null && rawSize !== "";
  const size = hasExplicitSize ? rawSize : DEFAULT_IMAGE_SIZE;
  const operation = referenceImages.length > 0 ? "edit" : "generate";

  return {
    referenceImages,
    operation,
    endpoint: getImagesApiPath(operation),
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    provider: resolveImageProvider(),
    requestedSize: hasExplicitSize ? rawSize : "",
    size,
    totalImageBytes: referenceImages.reduce((total, image) => total + image.size, 0),
  };
}

function validateImageStreamRequest(request) {
  if (!request.prompt) {
    return {
      message: "请输入图片提示词",
      statusCode: 400,
      errorStage: "prompt",
    };
  }

  if (request.prompt.length > 2000) {
    return {
      message: "提示词最多 2000 个字符",
      statusCode: 400,
      errorStage: "prompt",
    };
  }

  if (!isAllowedImageSize(request.size)) {
    return {
      message: "输出尺寸不合法：宽高须为 16 的倍数，比例为 1:3～3:1，最长边不超过 3840px，总像素为 655360～8294400",
      statusCode: 400,
      errorStage: "size",
    };
  }

  if (!request.provider.apiKey) {
    return {
      message: `服务端缺少 ${request.provider.missingKeyEnv} 环境变量`,
      statusCode: 500,
      errorStage: "configuration",
    };
  }

  return null;
}

function getImageStreamValidationError(request) {
  const error = validateImageStreamRequest(request);
  return error ? error.message : "";
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

function getImageRequestId(req) {
  return (req.imageRequestMetrics && req.imageRequestMetrics.requestId) || "";
}

function getStreamImageMetadata(context) {
  return {
    model: imageModel,
    api: context.operation === "edit" ? "images_edit" : "images_generation",
    endpoint: context.endpoint,
    requestId: context.requestId,
  };
}

function markFirstImage(context) {
  if (context.metrics && !context.metrics.firstImageAt) {
    context.metrics.firstImageAt = Date.now();
  }
}

function markStreamCompleted(context) {
  context.completed = true;
  if (context.metrics) {
    context.metrics.completedAt = Date.now();
  }
}

function sendFinalImageIfFound(context, payload) {
  const image = normalizeImagePayload(payload);

  if (!image) {
    return false;
  }

  context.finalImage = image;
  markFirstImage(context);
  sendSseEventIfWritable(context.res, "final_image", {
    image: context.finalImage,
    ...getStreamImageMetadata(context),
  });
  return true;
}

function getImagesApiErrorMessage(data) {
  if (isPlainObject(data) && isPlainObject(data.error) && typeof data.error.message === "string") {
    return data.error.message;
  }

  if (isPlainObject(data) && typeof data.message === "string") {
    return data.message;
  }

  return "图片服务返回了错误事件";
}

function sendImagesStreamError(context, message, options = {}) {
  if (context.completed) {
    return;
  }

  context.failed = true;
  sendSseEventIfWritable(context.res, "error", {
    message,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.retryable ? { retryable: true } : {}),
    ...getStreamImageMetadata(context),
  });
  markStreamCompleted(context);
}

// 把 Images API 的生成/编辑事件翻译成前端稳定使用的 SSE 协议。
function processImagesSseBlock(block, context) {
  const parsed = parseSseBlock(block.trim());
  if (!parsed.data || parsed.data === "[DONE]" || context.completed) {
    return;
  }

  let data;
  try {
    data = JSON.parse(parsed.data);
  } catch (error) {
    return;
  }

  if (!isPlainObject(data)) {
    return;
  }

  const type = typeof data.type === "string" ? data.type : parsed.event;

  if (type === "image_generation.partial_image" || type === "image_edit.partial_image") {
    const image = normalizeImagePayload(data.b64_json);
    if (image) {
      markFirstImage(context);
      sendSseEventIfWritable(context.res, "partial_image", {
        image,
        partialImageIndex: data.partial_image_index,
        ...getStreamImageMetadata(context),
      });
    }
    return;
  }

  if (type === "image_generation.completed" || type === "image_edit.completed") {
    if (!sendFinalImageIfFound(context, data.b64_json)) {
      sendImagesStreamError(context, "图片服务已完成，但未返回可展示的图片");
      return;
    }

    sendSseEventIfWritable(context.res, "done", {
      image: context.finalImage,
      ...getStreamImageMetadata(context),
    });
    markStreamCompleted(context);
    return;
  }

  if (type === "error" || type.endsWith(".failed")) {
    sendImagesStreamError(context, getImagesApiErrorMessage(data));
  }
}

function processImagesSseChunk(chunk, state, context) {
  state.buffer += chunk;
  const blocks = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = blocks.pop() || "";

  for (const block of blocks) {
    processImagesSseBlock(block, context);
  }
}

function flushImagesSseBuffer(state, context) {
  if (!state.buffer.trim()) {
    return;
  }

  processImagesSseBlock(state.buffer, context);
  state.buffer = "";
}

function processImagesJsonResponse(payload, context) {
  if (!sendFinalImageIfFound(context, payload)) {
    sendImagesStreamError(context, "图片服务已完成，但未返回可展示的图片");
    return false;
  }

  sendSseEventIfWritable(context.res, "done", {
    image: context.finalImage,
    ...getStreamImageMetadata(context),
  });
  markStreamCompleted(context);
  return true;
}

function getBadUpstreamImageMessage(statusCode, contentType) {
  return `图片服务返回异常：HTTP ${statusCode} ${contentType}`;
}

function parseUpstreamImageError(body) {
  if (typeof body !== "string" || !body.trim()) {
    return { code: "", message: "" };
  }

  try {
    const payload = JSON.parse(body);
    const error = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : payload;

    return {
      code:
        isPlainObject(error) && typeof error.type === "string"
          ? error.type
          : isPlainObject(error) && typeof error.code === "string"
            ? error.code
            : "",
      message: isPlainObject(error) && typeof error.message === "string" ? error.message.trim() : "",
    };
  } catch (error) {
    return { code: "", message: "" };
  }
}

function getBadUpstreamImageError(statusCode, contentType, body) {
  const parsed = parseUpstreamImageError(body);

  if (statusCode === 429 || parsed.code === "rate_limit_exceeded") {
    const isRequestsPerMinuteLimit = /requests-per-minute/i.test(parsed.message);

    return {
      message: isRequestsPerMinuteLimit
        ? "上游图片服务的每分钟请求次数已达上限，请稍后再试。"
        : "上游图片服务暂时限流，请稍后再试。",
      detail: parsed.message,
      errorCode: parsed.code || "rate_limit_exceeded",
      retryable: true,
    };
  }

  return {
    message: getBadUpstreamImageMessage(statusCode, contentType),
    detail: parsed.message || (typeof body === "string" ? body.slice(0, 500) : ""),
    ...(parsed.code ? { errorCode: parsed.code } : {}),
  };
}

function createImageRequestMetric(metrics, result = {}, endedAt = Date.now()) {
  const startedAt = Number.isFinite(metrics && metrics.startedAt) ? metrics.startedAt : endedAt;
  const durationFromStart = (timestamp) =>
    Number.isFinite(timestamp) ? Math.max(0, timestamp - startedAt) : undefined;
  const record = {
    event: "image_request",
    requestId: metrics && metrics.requestId ? metrics.requestId : "",
    operation: metrics && metrics.operation,
    imageCount: metrics && metrics.imageCount,
    totalImageBytes: metrics && metrics.totalImageBytes,
    size: metrics && metrics.size,
    endpoint: metrics && metrics.endpoint,
    model: metrics && metrics.model,
    upstreamHttpStatus: result.upstreamHttpStatus ?? (metrics && metrics.upstreamHttpStatus),
    connectMs: durationFromStart(metrics && metrics.upstreamConnectedAt),
    firstImageMs: durationFromStart(metrics && metrics.firstImageAt),
    completedMs: durationFromStart(metrics && metrics.completedAt),
    durationMs: Math.max(0, endedAt - startedAt),
    httpStatus: result.httpStatus,
    outcome: result.outcome || "unknown",
    errorStage: result.errorStage,
  };

  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function finishImageRequestMetric(req, result) {
  const metrics = req.imageRequestMetrics;
  if (!metrics || metrics.logged) {
    return;
  }

  metrics.logged = true;
  console.info(JSON.stringify(createImageRequestMetric(metrics, result)));
}

function enrichImageRequestMetrics(req, request) {
  if (!req.imageRequestMetrics) {
    return;
  }

  Object.assign(req.imageRequestMetrics, {
    operation: request.operation,
    imageCount: request.referenceImages.length,
    totalImageBytes: request.totalImageBytes,
    size: request.size,
    endpoint: request.endpoint,
    model: imageModel,
  });
}

function createImagesStreamContext(request, res, metrics) {
  return {
    completed: false,
    failed: false,
    finalImage: "",
    operation: request.operation,
    endpoint: request.endpoint,
    requestId: metrics && metrics.requestId ? metrics.requestId : "",
    metrics,
    res,
  };
}

async function consumeImagesSseResponse(upstreamResponse, context) {
  if (!upstreamResponse.body) {
    sendImagesStreamError(context, "图片服务没有返回可读取的响应流");
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = { buffer: "" };

  try {
    while (!context.completed) {
      const { done, value } = await reader.read();
      if (value) {
        processImagesSseChunk(decoder.decode(value, { stream: !done }), state, context);
      }

      if (done) {
        break;
      }
    }

    if (!context.completed) {
      const remainder = decoder.decode();
      if (remainder) {
        processImagesSseChunk(remainder, state, context);
      }
      flushImagesSseBuffer(state, context);
    }
  } finally {
    if (context.completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  if (!context.completed) {
    sendImagesStreamError(context, "图片生成流已结束，但未返回最终图片");
  }
}

async function readUpstreamResponseText(upstreamResponse) {
  try {
    return await upstreamResponse.text();
  } catch (error) {
    return "";
  }
}

async function streamImagesApi(request, res, metrics) {
  const url = new URL(`${request.provider.baseUrl}${request.endpoint}`);
  const controller = new AbortController();
  const context = createImagesStreamContext(request, res, metrics);
  let timedOut = false;
  let clientClosed = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, IMAGE_REQUEST_TIMEOUT_MS);
  const closeUpstream = () => {
    clientClosed = true;
    controller.abort();
  };
  res.once("close", closeUpstream);

  sendSseEventIfWritable(res, "status", {
    message: request.operation === "edit" ? "正在上传参考图并连接图片编辑服务..." : "正在连接图片生成服务...",
    ...getStreamImageMetadata(context),
  });

  try {
    const headers = {
      Authorization: `Bearer ${request.provider.apiKey}`,
      Accept: "text/event-stream, application/json",
    };
    let body;

    if (request.operation === "edit") {
      body = createImageEditFormData(request.prompt, request.size, request.referenceImages);
    } else {
      body = JSON.stringify(createImageGenerationPayload(request.prompt, request.size));
      headers["Content-Type"] = "application/json";
    }

    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    metrics.upstreamConnectedAt = Date.now();
    metrics.upstreamHttpStatus = upstreamResponse.status;
    sendSseEventIfWritable(res, "status", {
      message: "图片服务已响应，正在读取结果...",
      ...getStreamImageMetadata(context),
    });
    const contentType = upstreamResponse.headers.get("content-type") || "";

    if (!upstreamResponse.ok) {
      const body = (await readUpstreamResponseText(upstreamResponse)).slice(0, 500);
      const upstreamError = getBadUpstreamImageError(upstreamResponse.status, contentType, body);
      sendImagesStreamError(context, upstreamError.message, upstreamError);
      return {
        outcome: "upstream_error",
        httpStatus: 502,
        upstreamHttpStatus: upstreamResponse.status,
        errorStage: "upstream_http",
      };
    }

    sendSseEventIfWritable(res, "status", {
      message: "已连接图片服务，正在等待模型返回...",
      ...getStreamImageMetadata(context),
    });

    if (contentType.includes("text/event-stream")) {
      await consumeImagesSseResponse(upstreamResponse, context);
    } else {
      const responseText = await readUpstreamResponseText(upstreamResponse);
      let payload;

      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        sendImagesStreamError(context, getBadUpstreamImageMessage(upstreamResponse.status, contentType), {
          detail: responseText.slice(0, 500),
        });
      }

      if (!context.completed) {
        if (payload) {
          processImagesJsonResponse(payload, context);
        } else {
          sendImagesStreamError(context, "图片服务已完成，但未返回可展示的图片");
        }
      }
    }

    return {
      outcome: context.failed ? "upstream_error" : "success",
      httpStatus: context.failed ? 502 : 200,
      upstreamHttpStatus: upstreamResponse.status,
      ...(context.failed ? { errorStage: "upstream_response" } : {}),
    };
  } catch (error) {
    if (clientClosed) {
      return {
        outcome: "cancelled",
        httpStatus: 499,
        errorStage: "client_disconnect",
      };
    }

    const message = timedOut
      ? "图片生成请求超时，请稍后重试"
      : error instanceof Error && error.message
        ? error.message
        : "图片生成请求失败";
    sendImagesStreamError(context, message);
    return {
      outcome: timedOut ? "timeout" : "upstream_error",
      httpStatus: timedOut ? 504 : 502,
      errorStage: timedOut ? "timeout" : "upstream_request",
    };
  } finally {
    clearTimeout(timeout);
    res.off("close", closeUpstream);
  }
}

const imageRateLimiter = createImageRateLimiter();

app.post(IMAGE_STREAM_ROUTE, imageRateLimiter, parseStreamImageRequest, async (req, res) => {
  let referenceImages = [];
  let heartbeatTimer;
  let metricResult = {
    outcome: "server_error",
    httpStatus: 500,
    errorStage: "server",
  };

  try {
    try {
      referenceImages = getRequestImageInput(req);
    } catch (error) {
      writeSseHead(res, 400);
      sendSseEvent(res, "error", {
        message: error.message,
        requestId: getImageRequestId(req),
      });
      metricResult = {
        outcome: "rejected",
        httpStatus: 400,
        errorStage: "upload",
      };
      return;
    }

    const request = getImageStreamRequest(req, referenceImages);
    enrichImageRequestMetrics(req, request);
    const validationError = validateImageStreamRequest(request);

    if (validationError) {
      writeSseHead(res, validationError.statusCode);
      sendSseEvent(res, "error", {
        message: validationError.message,
        requestId: getImageRequestId(req),
      });
      metricResult = {
        outcome: validationError.statusCode === 400 ? "rejected" : "configuration_error",
        httpStatus: validationError.statusCode,
        errorStage: validationError.errorStage,
      };
      return;
    }

    writeSseHead(res);
    heartbeatTimer = startSseHeartbeat(res);
    metricResult = await streamImagesApi(request, res, req.imageRequestMetrics);
  } catch (error) {
    if (!res.headersSent) {
      writeSseHead(res, 500);
    }

    sendSseEventIfWritable(res, "error", {
      message: error instanceof Error ? error.message : "图片生成请求失败",
      requestId: getImageRequestId(req),
    });
    metricResult = {
      outcome: "server_error",
      httpStatus: 500,
      errorStage: "server",
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    finishImageRequestMetric(req, metricResult);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

// JSON 解析失败发生在路由前，单独转换成同一套 SSE 错误格式。
app.use((error, req, res, next) => {
  if (req.method !== "POST" || req.path !== IMAGE_STREAM_ROUTE) {
    next(error);
    return;
  }

  const isTooLarge = error && error.type === "entity.too.large";
  const message = isTooLarge ? "JSON 请求体过大，请缩小参考图后重试" : "请求内容不是有效的 JSON";
  writeSseHead(res, 400);
  sendSseEvent(res, "error", {
    message,
    requestId: getImageRequestId(req),
  });
  finishImageRequestMetric(req, {
    outcome: "rejected",
    httpStatus: 400,
    errorStage: isTooLarge ? "upload" : "json",
  });
  res.end();
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
  normalizeUploadedFiles,
  validateReferenceImages,
  getRequestImageInput,
  createImageGenerationPayload,
  createImageEditFormData,
  getImagesApiPath,
  getImageStreamRequest,
  validateImageStreamRequest,
  getImageStreamValidationError,
  processImagesSseBlock,
  processImagesJsonResponse,
  createImageRequestMetric,
  getMultipartContentLengthError,
  getBadUpstreamImageMessage,
  parseUpstreamImageError,
  getBadUpstreamImageError,
  getMaxUploadImages,
  isAllowedImageSize,
  MAX_UPLOAD_IMAGES,
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  getMaxMultipartRequestBytes,
  JSON_BODY_LIMIT,
  allowedUploadMimeTypes,
};
