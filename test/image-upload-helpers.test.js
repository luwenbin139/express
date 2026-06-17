const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { isImageDataUrl, normalizeImagePayload } = require("../index");

const {
  collectJsonImageDataUrls,
  validateImageDataUrls,
  convertUploadedFilesToDataUrls,
  parseAllowedCorsOrigins,
  createCorsOptions,
  getImageRateLimitPerHour,
  createImageRateLimiter,
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

test("validateImageDataUrls enforces maximum count", () => {
  const images = Array.from({ length: MAX_UPLOAD_IMAGES + 1 }, () => "data:image/png;base64,QUJD");
  assert.throws(() => validateImageDataUrls(images), /最多上传 4 张图片/);
});

test("validateImageDataUrls rejects invalid data url", () => {
  assert.throws(() => validateImageDataUrls(["data:image/gif;base64,QUJD"]), /仅支持 PNG、JPG 或 WebP 图片/);
});

test("validateImageDataUrls rejects oversized JSON data url", () => {
  const image = `data:image/png;base64,${Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES + 1).toString("base64")}`;

  assert.throws(() => validateImageDataUrls([image]), /单张图片最大 10MB/);
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

test("createImageRateLimiter returns JSON 429 for limited non-stream requests", () => {
  const previous = process.env.IMAGE_RATE_LIMIT_PER_HOUR;
  process.env.IMAGE_RATE_LIMIT_PER_HOUR = "1";
  const limiter = createImageRateLimiter();
  let nextCount = 0;
  const req = { ip: "127.0.0.1", path: "/api/generate-image", connection: {} };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  };

  try {
    limiter(req, res, () => {
      nextCount += 1;
    });
    limiter(req, res, () => {
      nextCount += 1;
    });

    assert.strictEqual(nextCount, 1);
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.code, 1);
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
