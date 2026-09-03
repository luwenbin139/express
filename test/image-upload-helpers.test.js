const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
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
  parseAllowedCorsOrigins,
  createCorsOptions,
  getImageRateLimitPerHour,
  createImageRateLimiter,
  resolveImageProvider,
  MAX_UPLOAD_IMAGES,
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  getMaxMultipartRequestBytes,
} = require("../index");

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function createPngBuffer(size = 8) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return size <= signature.length ? signature.subarray(0, size) : Buffer.concat([signature, Buffer.alloc(size - signature.length)]);
}

function createReferenceImage(size = 8, mimetype = "image/png") {
  const buffer = mimetype === "image/png"
    ? createPngBuffer(size)
    : mimetype === "image/jpeg"
      ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(Math.max(0, size - 3))])
      : Buffer.concat([Buffer.from("RIFFxxxxWEBP", "ascii"), Buffer.alloc(Math.max(0, size - 12))]);

  return {
    mimetype,
    buffer,
    size: buffer.length,
  };
}

function toDataUrl(image) {
  return `data:${image.mimetype};base64,${image.buffer.toString("base64")}`;
}

function createSseResponse() {
  return {
    body: "",
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      this.body += chunk;
    },
  };
}

function createStreamContext(operation = "generate") {
  return {
    completed: false,
    failed: false,
    finalImage: "",
    operation,
    endpoint: getImagesApiPath(operation),
    requestId: "request-test",
    metrics: { startedAt: 1000 },
    res: createSseResponse(),
  };
}

const longBase64 = Buffer.alloc(96, 1).toString("base64");

test("isImageDataUrl accepts png jpeg jpg and webp data urls", () => {
  assert.strictEqual(isImageDataUrl("data:image/png;base64,QUJD"), true);
  assert.strictEqual(isImageDataUrl("data:image/jpeg;base64,QUJD"), true);
  assert.strictEqual(isImageDataUrl("data:image/jpg;base64,QUJD"), true);
  assert.strictEqual(isImageDataUrl("data:image/webp;base64,QUJD"), true);
});

test("isImageDataUrl rejects unsupported image formats", () => {
  assert.strictEqual(isImageDataUrl("data:image/gif;base64,QUJD"), false);
  assert.strictEqual(isImageDataUrl("not-an-image"), false);
});

test("normalizeImagePayload returns the first nested image payload", () => {
  assert.strictEqual(
    normalizeImagePayload({ data: [{ b64_json: longBase64 }] }),
    `data:image/png;base64,${longBase64}`
  );
});

test("collectJsonImageDataUrls supports legacy image and current images fields", () => {
  assert.deepStrictEqual(
    collectJsonImageDataUrls({
      image: "data:image/png;base64,QUJD",
      images: ["", "data:image/jpeg;base64,REVG"],
    }),
    ["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG"]
  );
});

test("getImageDataUrlDecodedByteLength returns the decoded byte count", () => {
  const image = createReferenceImage(21);
  assert.strictEqual(getImageDataUrlDecodedByteLength(toDataUrl(image)), 21);
  assert.strictEqual(getImageDataUrlDecodedByteLength("not-an-image"), 0);
});

test("getMaxUploadImages defaults to 4 and accepts only Images API bounds", () => {
  assert.strictEqual(getMaxUploadImages(undefined), 4);
  assert.strictEqual(getMaxUploadImages(""), 4);
  assert.strictEqual(getMaxUploadImages("0"), 4);
  assert.strictEqual(getMaxUploadImages("17"), 4);
  assert.strictEqual(getMaxUploadImages("bad"), 4);
  assert.strictEqual(getMaxUploadImages("1"), 1);
  assert.strictEqual(getMaxUploadImages("16"), 16);
  assert.ok(MAX_UPLOAD_IMAGES >= 1 && MAX_UPLOAD_IMAGES <= 16);
});

test("validateImageDataUrls normalizes valid images to binary input", () => {
  const image = createReferenceImage();
  const result = validateImageDataUrls([toDataUrl(image)]);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].mimetype, "image/png");
  assert.deepStrictEqual(result[0].buffer, image.buffer);
  assert.strictEqual(result[0].size, image.buffer.length);
});

test("validateImageDataUrls rejects too many reference images", () => {
  const image = toDataUrl(createReferenceImage());
  assert.throws(
    () => validateImageDataUrls([image, image, image], { maxImages: 2 }),
    /最多上传 2 张图片/
  );
});

test("validateImageDataUrls rejects an oversized single image", () => {
  const image = toDataUrl(createReferenceImage(11));
  assert.throws(
    () => validateImageDataUrls([image], { maxImages: 4, maxImageBytes: 10, maxTotalBytes: 20 }),
    /单张图片最大/
  );
});

test("validateImageDataUrls rejects images over the aggregate limit", () => {
  const first = toDataUrl(createReferenceImage(9));
  const second = toDataUrl(createReferenceImage(9));

  assert.throws(
    () => validateImageDataUrls([first, second], { maxImages: 4, maxImageBytes: 10, maxTotalBytes: 16 }),
    /参考图合计最大/
  );
});

test("validateImageDataUrls rejects invalid data URLs and forged image headers", () => {
  assert.throws(() => validateImageDataUrls(["data:image/gif;base64,QUJD"]), /仅支持 PNG、JPG 或 WebP 图片/);
  assert.throws(
    () => validateImageDataUrls([`data:image/png;base64,${Buffer.from("not-an-image").toString("base64")}`]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
});

test("validateReferenceImages enforces the production 20MB and 40MB limits", () => {
  assert.strictEqual(MAX_UPLOAD_IMAGE_BYTES, 20 * 1024 * 1024);
  assert.strictEqual(MAX_UPLOAD_TOTAL_BYTES, 40 * 1024 * 1024);
});

test("normalizeUploadedFiles keeps binary buffers and supported MIME types", () => {
  const png = createReferenceImage(8, "image/png");
  const jpeg = createReferenceImage(8, "image/jpeg");
  const webp = createReferenceImage(12, "image/webp");
  const result = normalizeUploadedFiles([png, jpeg, webp]);

  assert.deepStrictEqual(result.map((image) => image.mimetype), ["image/png", "image/jpeg", "image/webp"]);
  assert.strictEqual(result[0].buffer, png.buffer);
  assert.deepStrictEqual(result.map((image) => image.size), [8, 8, 12]);
});

test("normalizeUploadedFiles rejects MIME and magic-byte mismatches", () => {
  assert.throws(
    () => normalizeUploadedFiles([{ mimetype: "image/png", buffer: Buffer.from([0xff, 0xd8, 0xff]), size: 3 }]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
  assert.throws(
    () => normalizeUploadedFiles([{ mimetype: "image/gif", buffer: Buffer.from("GIF89a"), size: 6 }]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
});

test("getRequestImageInput returns normalized multipart images", () => {
  const image = createReferenceImage();
  const request = {
    is: (type) => type === "multipart/form-data",
    files: { images: [image] },
  };
  const result = getRequestImageInput(request);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].mimetype, "image/png");
  assert.deepStrictEqual(result[0].buffer, image.buffer);
});

test("multipart content-length preflight rejects clearly oversized requests", () => {
  const maxRequestBytes = getMaxMultipartRequestBytes();
  const request = {
    is: (type) => type === "multipart/form-data",
    headers: { "content-length": String(maxRequestBytes + 1) },
  };
  const allowed = {
    ...request,
    headers: { "content-length": String(maxRequestBytes) },
  };

  assert.match(getMultipartContentLengthError(request), /参考图合计最大 40MB/);
  assert.strictEqual(getMultipartContentLengthError(allowed), "");
});

test("isAllowedImageSize applies one rule to presets and custom sizes", () => {
  for (const size of ["auto", "1024x1024", "1024x1536", "1536x1024", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "1024x640"]) {
    assert.strictEqual(isAllowedImageSize(size), true, `${size} should be allowed`);
  }

  for (const size of ["1920x1080", "1080x1920", "5760x3240", "3240x5760", "1537x864", "4096x1024", "1024x256", "512x512", "not-a-size"]) {
    assert.strictEqual(isAllowedImageSize(size), false, `${size} should be rejected`);
  }
});

test("getImageStreamRequest defaults an omitted size to auto and ignores client mode", () => {
  const noImage = getImageStreamRequest({ body: { prompt: " draw ", mode: "edit" } }, []);
  const image = createReferenceImage();
  const withImage = getImageStreamRequest({ body: { prompt: "edit", mode: "generate", size: "2048x1152" } }, [image]);

  assert.strictEqual(noImage.size, "auto");
  assert.strictEqual(noImage.operation, "generate");
  assert.strictEqual(noImage.endpoint, "/v1/images/generations");
  assert.strictEqual(withImage.operation, "edit");
  assert.strictEqual(withImage.endpoint, "/v1/images/edits");
  assert.strictEqual(withImage.size, "2048x1152");
  assert.strictEqual(withImage.totalImageBytes, image.size);
  assert.strictEqual(Object.hasOwn(noImage, "mode"), false);
});

test("explicit invalid sizes produce a validation error instead of falling back", () => {
  const request = getImageStreamRequest({ body: { prompt: "draw", size: "1920x1080" } }, []);
  request.provider.apiKey = "key";
  const error = validateImageStreamRequest(request);

  assert.strictEqual(request.size, "1920x1080");
  assert.strictEqual(error.statusCode, 400);
  assert.strictEqual(error.errorStage, "size");
  assert.match(getImageStreamValidationError(request), /输出尺寸不合法/);
});

test("image request validation checks prompt, size, and server configuration", () => {
  const valid = {
    referenceImages: [],
    operation: "generate",
    endpoint: "/v1/images/generations",
    prompt: "draw",
    provider: { apiKey: "key", missingKeyEnv: "OPENAI_API_KEY" },
    requestedSize: "",
    size: "auto",
    totalImageBytes: 0,
  };

  assert.strictEqual(validateImageStreamRequest(valid), null);
  assert.match(getImageStreamValidationError({ ...valid, prompt: "" }), /请输入图片提示词/);
  assert.match(getImageStreamValidationError({ ...valid, prompt: "x".repeat(2001) }), /最多 2000 个字符/);
  assert.match(getImageStreamValidationError({ ...valid, provider: { apiKey: "", missingKeyEnv: "OPENAI_API_KEY" } }), /服务端缺少 OPENAI_API_KEY/);
});

test("generation payload targets gpt-image-2 directly with streaming", () => {
  const payload = createImageGenerationPayload("draw", "1024x1024");

  assert.deepStrictEqual(payload, {
    model: "gpt-image-2",
    prompt: "draw",
    size: "1024x1024",
    stream: true,
    partial_images: 1,
  });
  assert.strictEqual(Object.hasOwn(payload, "tools"), false);
  assert.strictEqual(Object.hasOwn(payload, "input"), false);
});

test("edit form uses repeated image[] files and no client mode", () => {
  const first = createReferenceImage(8, "image/png");
  const second = createReferenceImage(12, "image/webp");
  const form = createImageEditFormData("edit", "1024x1024", [first, second]);
  const entries = [...form.entries()];
  const imageEntries = entries.filter(([key]) => key === "image[]");

  assert.strictEqual(form.get("model"), "gpt-image-2");
  assert.strictEqual(form.get("prompt"), "edit");
  assert.strictEqual(form.get("size"), "1024x1024");
  assert.strictEqual(form.get("stream"), "true");
  assert.strictEqual(form.get("partial_images"), "1");
  assert.strictEqual(form.has("mode"), false);
  assert.strictEqual(imageEntries.length, 2);
  assert.deepStrictEqual(imageEntries.map(([, file]) => file.name), ["reference-1.png", "reference-2.webp"]);
  assert.deepStrictEqual(imageEntries.map(([, file]) => file.type), ["image/png", "image/webp"]);
});

test("Images API path is selected only from the derived operation", () => {
  assert.strictEqual(getImagesApiPath("generate"), "/v1/images/generations");
  assert.strictEqual(getImagesApiPath("edit"), "/v1/images/edits");
});

test("generation partial and completed events map to the internal SSE protocol", () => {
  const context = createStreamContext("generate");
  processImagesSseBlock(
    `event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: longBase64, partial_image_index: 0 })}`,
    context
  );
  processImagesSseBlock(
    `event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: longBase64 })}`,
    context
  );

  assert.match(context.res.body, /event: partial_image/);
  assert.match(context.res.body, /event: final_image/);
  assert.match(context.res.body, /event: done/);
  assert.match(context.res.body, /"endpoint":"\/v1\/images\/generations"/);
  assert.strictEqual(context.completed, true);
  assert.strictEqual(context.failed, false);
});

test("edit partial and completed events map to the same internal SSE protocol", () => {
  const context = createStreamContext("edit");
  processImagesSseBlock(
    `event: image_edit.partial_image\ndata: ${JSON.stringify({ b64_json: longBase64, partial_image_index: 0 })}`,
    context
  );
  processImagesSseBlock(
    `event: image_edit.completed\ndata: ${JSON.stringify({ b64_json: longBase64 })}`,
    context
  );

  assert.match(context.res.body, /event: partial_image/);
  assert.match(context.res.body, /event: final_image/);
  assert.match(context.res.body, /event: done/);
  assert.match(context.res.body, /"endpoint":"\/v1\/images\/edits"/);
  assert.strictEqual(context.completed, true);
});

test("Images API error events become one internal error event", () => {
  const context = createStreamContext("generate");
  processImagesSseBlock(
    `event: error\ndata: ${JSON.stringify({ error: { message: "upstream failed" } })}`,
    context
  );

  assert.match(context.res.body, /event: error/);
  assert.match(context.res.body, /upstream failed/);
  assert.strictEqual(context.failed, true);
  assert.strictEqual(context.completed, true);
});

test("successful non-streaming Images JSON remains compatible", () => {
  const context = createStreamContext("generate");
  assert.strictEqual(processImagesJsonResponse({ data: [{ b64_json: longBase64 }] }, context), true);
  assert.match(context.res.body, /event: final_image/);
  assert.match(context.res.body, /event: done/);
  assert.strictEqual(context.completed, true);
});

test("non-streaming Images JSON without an image fails explicitly", () => {
  const context = createStreamContext("generate");
  assert.strictEqual(processImagesJsonResponse({ data: [] }, context), false);
  assert.match(context.res.body, /未返回可展示的图片/);
  assert.strictEqual(context.failed, true);
});

test("image request metrics contain only the approved non-sensitive fields", () => {
  const metrics = {
    requestId: "request-1",
    startedAt: 1000,
    operation: "edit",
    imageCount: 2,
    totalImageBytes: 1234,
    size: "1024x1024",
    endpoint: "/v1/images/edits",
    model: "gpt-image-2",
    upstreamConnectedAt: 1100,
    firstImageAt: 1200,
    completedAt: 1300,
    prompt: "private prompt",
    apiKey: "private key",
    image: longBase64,
  };
  const record = createImageRequestMetric(metrics, { outcome: "success", httpStatus: 200 }, 1400);
  const serialized = JSON.stringify(record);

  assert.strictEqual(record.connectMs, 100);
  assert.strictEqual(record.firstImageMs, 200);
  assert.strictEqual(record.completedMs, 300);
  assert.strictEqual(record.durationMs, 400);
  assert.strictEqual(Object.hasOwn(record, "prompt"), false);
  assert.strictEqual(Object.hasOwn(record, "apiKey"), false);
  assert.strictEqual(Object.hasOwn(record, "image"), false);
  assert.doesNotMatch(serialized, /private prompt|private key/);
  assert.doesNotMatch(serialized, new RegExp(longBase64));
});

test("upstream failures use the generic image service error", () => {
  assert.strictEqual(
    getBadUpstreamImageMessage(400, "application/json"),
    "图片服务返回异常：HTTP 400 application/json"
  );
});

test("upstream JSON errors expose their message and type safely", () => {
  assert.deepStrictEqual(
    parseUpstreamImageError(JSON.stringify({
      error: {
        message: "user requests-per-minute limit exceeded",
        type: "rate_limit_exceeded",
      },
    })),
    {
      code: "rate_limit_exceeded",
      message: "user requests-per-minute limit exceeded",
    }
  );
  assert.deepStrictEqual(parseUpstreamImageError("not-json"), { code: "", message: "" });
});

test("HTTP 429 becomes a readable retryable rate-limit error", () => {
  assert.deepStrictEqual(
    getBadUpstreamImageError(
      429,
      "application/json; charset=utf-8",
      JSON.stringify({
        error: {
          message: "user requests-per-minute limit exceeded",
          type: "rate_limit_exceeded",
        },
      })
    ),
    {
      message: "上游图片服务的每分钟请求次数已达上限，请稍后再试。",
      detail: "user requests-per-minute limit exceeded",
      errorCode: "rate_limit_exceeded",
      retryable: true,
    }
  );
});

test("other upstream failures keep a generic headline and parsed detail", () => {
  assert.deepStrictEqual(
    getBadUpstreamImageError(
      400,
      "application/json",
      JSON.stringify({ error: { message: "invalid size", type: "invalid_request_error" } })
    ),
    {
      message: "图片服务返回异常：HTTP 400 application/json",
      detail: "invalid size",
      errorCode: "invalid_request_error",
    }
  );
});

test("parseAllowedCorsOrigins trims comma-separated origins", () => {
  assert.deepStrictEqual([...parseAllowedCorsOrigins("https://a.example, https://b.example ,, ")], [
    "https://a.example",
    "https://b.example",
  ]);
});

test("createCorsOptions allows no-origin and configured origins only", () => {
  const previous = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = "https://allowed.example";
  const options = createCorsOptions();

  try {
    options.origin(undefined, (error, allowed) => {
      assert.ifError(error);
      assert.strictEqual(allowed, true);
    });
    options.origin("https://allowed.example", (error, allowed) => {
      assert.ifError(error);
      assert.strictEqual(allowed, true);
    });
    options.origin("https://blocked.example", (error, allowed) => {
      assert.ifError(error);
      assert.strictEqual(allowed, false);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = previous;
    }
  }
});

test("getImageRateLimitPerHour defaults to 20 and supports disable", () => {
  const previous = process.env.IMAGE_RATE_LIMIT_PER_HOUR;

  try {
    delete process.env.IMAGE_RATE_LIMIT_PER_HOUR;
    assert.strictEqual(getImageRateLimitPerHour(), 20);
    process.env.IMAGE_RATE_LIMIT_PER_HOUR = "0";
    assert.strictEqual(getImageRateLimitPerHour(), 0);
    process.env.IMAGE_RATE_LIMIT_PER_HOUR = "7";
    assert.strictEqual(getImageRateLimitPerHour(), 7);
    process.env.IMAGE_RATE_LIMIT_PER_HOUR = "bad";
    assert.strictEqual(getImageRateLimitPerHour(), 20);
  } finally {
    if (previous === undefined) {
      delete process.env.IMAGE_RATE_LIMIT_PER_HOUR;
    } else {
      process.env.IMAGE_RATE_LIMIT_PER_HOUR = previous;
    }
  }
});

test("createImageRateLimiter returns SSE 429 for limited stream requests", () => {
  const previous = process.env.IMAGE_RATE_LIMIT_PER_HOUR;
  process.env.IMAGE_RATE_LIMIT_PER_HOUR = "1";
  const limiter = createImageRateLimiter();
  const req = {
    ip: "127.0.0.2",
    path: "/api/generate-image-stream",
    connection: {},
    imageRequestMetrics: { requestId: "request-rate", startedAt: Date.now() },
  };
  const res = {
    statusCode: 200,
    body: "",
    ended: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk;
    },
    end() {
      this.ended = true;
    },
  };
  const originalInfo = console.info;
  console.info = () => {};

  try {
    limiter(req, res, () => {});
    limiter(req, res, () => {
      throw new Error("next should not be called after limit");
    });

    assert.strictEqual(res.statusCode, 429);
    assert.match(res.body, /event: error/);
    assert.match(res.body, /request-rate/);
    assert.strictEqual(res.ended, true);
  } finally {
    console.info = originalInfo;
    if (previous === undefined) {
      delete process.env.IMAGE_RATE_LIMIT_PER_HOUR;
    } else {
      process.env.IMAGE_RATE_LIMIT_PER_HOUR = previous;
    }
  }
});

test("resolveImageProvider always uses the configured OpenAI-compatible provider", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY = "default-key";
  process.env.OPENAI_BASE_URL = "https://default.example.com/";

  try {
    assert.deepStrictEqual(resolveImageProvider(), {
      id: "default",
      baseUrl: "https://default.example.com",
      apiKey: "default-key",
      missingKeyEnv: "OPENAI_API_KEY",
    });
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBaseUrl;
  }
});

test("frontend uses direct automatic operation selection and matching limits", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.match(appSource, /const MAX_REFERENCE_IMAGES = 4;/);
  assert.match(appSource, /const MAX_REFERENCE_TOTAL_SIZE = 40 \* 1024 \* 1024;/);
  assert.match(appSource, /const IMAGE_SIZE_OPTIONS = \["auto", "1024x1024", "1024x1536", "1536x1024", "2048x1152", "1152x2048"\];/);
  assert.doesNotMatch(appSource, /formData\.append\("mode"/);
  assert.doesNotMatch(appSource, /1920x1080/);
  assert.match(appSource, /required\s+maxLength=\{MAX_PROMPT_LENGTH\}/);
  assert.match(appSource, /required\s+maxLength=\{MAX_REFINEMENT_PROMPT_LENGTH\}/);
  assert.match(appSource, /const refinementRequest = createRefinementPrompt\(nextPrompt\);/);
  assert.match(appSource, /最多 4 张 \/ 单张 20MB \/ 合计 40MB/);
  assert.match(appSource, /setGenerationError\(nextError\)/);
  assert.match(appSource, /if \(bestSseError\) return false;/);
  assert.match(appSource, /generationError\.detail/);
  assert.match(appSource, /请求 ID：\{generationError\.requestId\}/);
  assert.match(appSource, /createImageFormData\(refinementRequest, size, \[generatedImageFile\]\)/);
});

test("runtime and docs no longer route image requests through Responses API", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const readmeSource = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");

  assert.doesNotMatch(serverSource, /\/v1\/responses|OPENAI_RESPONSES_MODEL|response\.image_generation_call/);
  assert.doesNotMatch(readmeSource, /Responses API|OPENAI_RESPONSES_MODEL/);
  assert.match(serverSource, /\/v1\/images\/generations/);
  assert.match(serverSource, /\/v1\/images\/edits/);
});

test("frontend no longer exposes local image editing and keeps reference-image refinement", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.doesNotMatch(appSource, /local-edit/i);
  assert.doesNotMatch(appSource, /图片局部编辑|局部修改|input_image_mask|maskFile/);
  assert.match(appSource, /可选：上传或粘贴参考图/);
  assert.match(appSource, /createImageFormData\(refinementRequest, size, \[generatedImageFile\]\)/);
});
