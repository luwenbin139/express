const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { isImageDataUrl, normalizeImagePayload } = require("../index");

const {
  collectJsonImageDataUrls,
  validateImageDataUrls,
  convertUploadedFilesToDataUrls,
  getRequestImageInput,
  createResponsesImagePayload,
  getImageStreamRequest,
  getImageStreamValidationError,
  getBadUpstreamImageMessage,
  isAllowedImageSize,
  parseAllowedCorsOrigins,
  createCorsOptions,
  getImageRateLimitPerHour,
  createImageRateLimiter,
  resolveImageProvider,
  MAX_UPLOAD_IMAGES,
  MAX_UPLOAD_IMAGE_BYTES,
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

test("normalizeImagePayload returns first nested image payload", () => {
  assert.strictEqual(
    normalizeImagePayload({ data: [{ b64_json: "QUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJD" }] }),
    "data:image/png;base64,QUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJDQUJD"
  );
});

test("collectJsonImageDataUrls supports old image and new images fields", () => {
  assert.deepStrictEqual(
    collectJsonImageDataUrls({
      image: "data:image/png;base64,QUJD",
      images: ["", "data:image/jpeg;base64,REVG"],
    }),
    ["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG"]
  );
});

test("validateImageDataUrls allows multiple valid images when the default limit is disabled", () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const images = Array.from({ length: MAX_UPLOAD_IMAGES > 0 ? MAX_UPLOAD_IMAGES + 1 : 5 }, () => image);

  if (MAX_UPLOAD_IMAGES > 0) {
    assert.throws(() => validateImageDataUrls(images), new RegExp(`最多上传 ${MAX_UPLOAD_IMAGES} 张图片`));
    return;
  }

  assert.deepStrictEqual(validateImageDataUrls(images), images);
});

test("validateImageDataUrls rejects invalid data url", () => {
  assert.throws(() => validateImageDataUrls(["data:image/gif;base64,QUJD"]), /仅支持 PNG、JPG 或 WebP 图片/);
});

test("validateImageDataUrls rejects oversized JSON data url", () => {
  const image = `data:image/png;base64,${Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES + 1).toString("base64")}`;

  assert.throws(() => validateImageDataUrls([image]), /单张图片最大 20MB/);
});

test("validateImageDataUrls accepts valid JSON PNG with full signature", () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = `data:image/png;base64,${pngBuffer.toString("base64")}`;

  assert.deepStrictEqual(validateImageDataUrls([image]), [image]);
});

test("validateImageDataUrls rejects forged JSON PNG data url", () => {
  const image = `data:image/png;base64,${Buffer.from("not-an-image", "ascii").toString("base64")}`;

  assert.throws(() => validateImageDataUrls([image]), /仅支持 PNG、JPG 或 WebP 图片/);
});

test("convertUploadedFilesToDataUrls converts supported buffers", () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff]);
  const webpBuffer = Buffer.from("RIFFxxxxWEBP", "ascii");

  assert.deepStrictEqual(
    convertUploadedFilesToDataUrls([
      {
        mimetype: "image/png",
        buffer: pngBuffer,
        size: pngBuffer.length,
      },
      {
        mimetype: "image/jpeg",
        buffer: jpegBuffer,
        size: jpegBuffer.length,
      },
      {
        mimetype: "image/webp",
        buffer: webpBuffer,
        size: webpBuffer.length,
      },
    ]),
    [
      `data:image/png;base64,${pngBuffer.toString("base64")}`,
      `data:image/jpeg;base64,${jpegBuffer.toString("base64")}`,
      `data:image/webp;base64,${webpBuffer.toString("base64")}`,
    ]
  );
});

test("convertUploadedFilesToDataUrls rejects mismatched magic bytes", () => {
  assert.throws(
    () => convertUploadedFilesToDataUrls([{ mimetype: "image/png", buffer: Buffer.from([0xff, 0xd8, 0xff]), size: 3 }]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
  assert.throws(
    () => convertUploadedFilesToDataUrls([{ mimetype: "image/jpeg", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), size: 4 }]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
  assert.throws(
    () => convertUploadedFilesToDataUrls([{ mimetype: "image/webp", buffer: Buffer.from("RIFFxxxxPNG ", "ascii"), size: 12 }]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
});

test("convertUploadedFilesToDataUrls rejects unsupported mimetype", () => {
  assert.throws(
    () => convertUploadedFilesToDataUrls([{ mimetype: "image/gif", buffer: Buffer.from("ABC"), size: 3 }]),
    /仅支持 PNG、JPG 或 WebP 图片/
  );
});

test("getRequestImageInput separates one PNG mask from source images", () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const request = {
    is: (type) => type === "multipart/form-data",
    files: {
      images: [{ mimetype: "image/png", buffer: pngBuffer, size: pngBuffer.length }],
      mask: [{ mimetype: "image/png", buffer: pngBuffer, size: pngBuffer.length }],
    },
  };

  assert.deepStrictEqual(getRequestImageInput(request), {
    imageDataUrls: [`data:image/png;base64,${pngBuffer.toString("base64")}`],
    maskDataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`,
  });
});

test("getRequestImageInput rejects invalid or duplicate masks", () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const createRequest = (mask) => ({
    is: (type) => type === "multipart/form-data",
    files: { images: [], mask },
  });

  assert.throws(
    () => getRequestImageInput(createRequest([{ mimetype: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff]), size: 3 }])),
    /遮罩必须是 PNG/
  );
  assert.throws(
    () => getRequestImageInput(createRequest([
      { mimetype: "image/png", buffer: pngBuffer, size: pngBuffer.length },
      { mimetype: "image/png", buffer: pngBuffer, size: pngBuffer.length },
    ])),
    /只能上传一个遮罩/
  );
});

test("createResponsesImagePayload keeps ordinary requests mask-free", () => {
  const image = "data:image/png;base64,QUJD";
  const payload = createResponsesImagePayload("draw", "1024x1024", [image], true);
  const tool = payload.tools[0];

  assert.strictEqual(tool.type, "image_generation");
  assert.strictEqual(tool.size, "1024x1024");
  assert.strictEqual(Object.hasOwn(tool, "input_image_mask"), false);
  assert.strictEqual(Object.hasOwn(tool, "action"), false);
  assert.strictEqual(payload.input[0].content[1].image_url, image);
});

test("createResponsesImagePayload adds exact mask only to the image tool", () => {
  const image = "data:image/png;base64,QUJD";
  const mask = "data:image/png;base64,REVG";
  const payload = createResponsesImagePayload("edit", "1536x864", [image], true, mask);
  const tool = payload.tools[0];

  assert.strictEqual(tool.action, "edit");
  assert.strictEqual(tool.input_fidelity, "high");
  assert.deepStrictEqual(tool.input_image_mask, { image_url: mask });
  assert.strictEqual(payload.input[0].content[1].image_url, image);
  assert.strictEqual(payload.input[0].content.some((part) => part.image_url === mask), false);
});

test("isAllowedImageSize accepts valid custom dimensions and rejects invalid boundaries", () => {
  assert.strictEqual(isAllowedImageSize("auto"), true);
  assert.strictEqual(isAllowedImageSize("1536x864"), true);
  assert.strictEqual(isAllowedImageSize("1024x1024"), true);
  assert.strictEqual(isAllowedImageSize("1537x864"), false);
  assert.strictEqual(isAllowedImageSize("4096x1024"), false);
  assert.strictEqual(isAllowedImageSize("1024x256"), false);
  assert.strictEqual(isAllowedImageSize("512x512"), false);
  assert.strictEqual(isAllowedImageSize("not-a-size"), false);
});

test("getImageStreamRequest keeps valid custom size and defaults invalid size", () => {
  const image = "data:image/png;base64,QUJD";
  const valid = getImageStreamRequest({ body: { prompt: " edit ", mode: "edit", size: "1536x864" } }, [image], "mask");
  const invalid = getImageStreamRequest({ body: { prompt: "edit", mode: "edit", size: "1537x864" } }, [image]);

  assert.strictEqual(valid.size, "1536x864");
  assert.strictEqual(valid.requestedSize, "1536x864");
  assert.strictEqual(valid.maskDataUrl, "mask");
  assert.strictEqual(invalid.size, "1024x1024");
  assert.strictEqual(invalid.requestedSize, "1537x864");
});

test("getImageStreamValidationError enforces exact mask request shape", () => {
  const base = {
    imageDataUrls: ["image"],
    maskDataUrl: "mask",
    mode: "edit",
    prompt: "edit",
    provider: { apiKey: "key", missingKeyEnv: "OPENAI_API_KEY" },
    requestedSize: "1024x1024",
    size: "1024x1024",
  };

  assert.strictEqual(getImageStreamValidationError(base), "");
  assert.match(getImageStreamValidationError({ ...base, mode: "generate" }), /只能用于图片编辑模式/);
  assert.match(getImageStreamValidationError({ ...base, imageDataUrls: ["one", "two"] }), /只能上传一张原图/);
  assert.match(getImageStreamValidationError({ ...base, imageDataUrls: [] }), /需要上传 PNG、JPG 或 WebP 原图/);
  assert.match(getImageStreamValidationError({ ...base, requestedSize: "1537x864" }), /需要有效的自定义图片尺寸/);
});

test("mask upstream failures explain that exact local editing is unsupported", () => {
  assert.match(getBadUpstreamImageMessage(400, "application/json", true), /^当前图片服务不支持精确局部遮罩编辑/);
  assert.doesNotMatch(getBadUpstreamImageMessage(400, "application/json", false), /遮罩编辑/);
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
  const req = { ip: "127.0.0.2", path: "/api/generate-image-stream", connection: {} };
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

  try {
    limiter(req, res, () => {});
    limiter(req, res, () => {
      throw new Error("next should not be called after limit");
    });

    assert.strictEqual(res.statusCode, 429);
    assert.match(res.body, /event: error/);
    assert.strictEqual(res.ended, true);
  } finally {
    if (previous === undefined) {
      delete process.env.IMAGE_RATE_LIMIT_PER_HOUR;
    } else {
      process.env.IMAGE_RATE_LIMIT_PER_HOUR = previous;
    }
  }
});

test("frontend image size defaults to auto and includes auto option", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.match(appSource, /const DEFAULT_IMAGE_SIZE = "auto";/);
  assert.match(appSource, /const IMAGE_SIZE_OPTIONS = \["auto",/);
});

test("frontend does not render the hero header section", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.doesNotMatch(appSource, /className="hero"/);
});

test("frontend uses automatic image mode without a manual mode selector", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.doesNotMatch(appSource, /mode-selector/);
  assert.doesNotMatch(appSource, /name="mode"/);
  assert.match(appSource, /formData\.append\("mode", images\.length > 0 \? "edit" : "generate"\)/);
});

test("frontend supports pasting image files into the prompt field", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.match(appSource, /ClipboardEvent/);
  assert.match(appSource, /handlePromptPaste/);
  assert.match(appSource, /clipboardData\.items/);
  assert.match(appSource, /getAsFile\(\)/);
});

test("resolveImageProvider always uses the default OpenAI-compatible provider", () => {
  const originalOpenaiKey = process.env.OPENAI_API_KEY;
  const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalRetiredKey = process.env.RETIRED_PROVIDER_API_KEY;
  const originalRetiredBaseUrl = process.env.RETIRED_PROVIDER_BASE_URL;

  process.env.OPENAI_API_KEY = "default-key";
  process.env.OPENAI_BASE_URL = "https://default.example.com/";
  process.env.RETIRED_PROVIDER_API_KEY = "retired-key";
  process.env.RETIRED_PROVIDER_BASE_URL = "https://retired.example.com/";

  try {
    assert.deepStrictEqual(resolveImageProvider("retired"), {
      id: "default",
      baseUrl: "https://default.example.com",
      apiKey: "default-key",
      missingKeyEnv: "OPENAI_API_KEY",
    });
    assert.deepStrictEqual(resolveImageProvider("default"), {
      id: "default",
      baseUrl: "https://default.example.com",
      apiKey: "default-key",
      missingKeyEnv: "OPENAI_API_KEY",
    });
    assert.deepStrictEqual(resolveImageProvider("unknown"), {
      id: "default",
      baseUrl: "https://default.example.com",
      apiKey: "default-key",
      missingKeyEnv: "OPENAI_API_KEY",
    });
  } finally {
    process.env.OPENAI_API_KEY = originalOpenaiKey;
    process.env.OPENAI_BASE_URL = originalOpenaiBaseUrl;
    process.env.RETIRED_PROVIDER_API_KEY = originalRetiredKey;
    process.env.RETIRED_PROVIDER_BASE_URL = originalRetiredBaseUrl;
  }
});

test("frontend does not expose or submit a retired provider", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../frontend/src/App.tsx"), "utf8");

  assert.doesNotMatch(appSource, /const PROVIDER_OPTIONS = \[/);
  assert.doesNotMatch(appSource, /setProvider/);
  assert.doesNotMatch(appSource, /id="provider"/);
  assert.doesNotMatch(appSource, /formData\.append\("provider"/);
  assert.doesNotMatch(appSource, /htmlFor="provider"/);
});
