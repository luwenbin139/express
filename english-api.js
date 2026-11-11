const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const MAX_FILES = 16;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_PROMPT_CHARS = 16000;
const CONTENT_LENGTH_LIMIT = MAX_TOTAL_BYTES + 128 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

function createEnglishUploadStorage(maxBytes = MAX_TOTAL_BYTES) {
  return {
    _handleFile(req, file, callback) {
      let chunks = [];
      let size = 0;
      let finished = false;
      file.stream.on('data', chunk => {
        if (finished) return;
        req.englishTotalBytes = (req.englishTotalBytes || 0) + chunk.length;
        if (req.englishTotalBytes > maxBytes) {
          finished = true;
          chunks = [];
          callback(new Error('参考图合计最大 40MB'));
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      file.stream.on('end', () => {
        if (finished) return;
        finished = true;
        callback(null, { buffer: Buffer.concat(chunks, size), size });
        chunks = [];
      });
      // Multer handles stream errors and decrements its pending-write counter.
      file.stream.on('error', () => { finished = true; chunks = []; });
    },
    _removeFile(req, file, callback) {
      delete file.buffer;
      callback(null);
    },
  };
}

function createEnglishRouter(deps) {
  const router = express.Router();
  const limiter = deps.createImageRateLimiter();
  const upload = multer({
    storage: createEnglishUploadStorage(),
    limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 4, fieldSize: MAX_PROMPT_CHARS * 4, parts: MAX_FILES + 4 },
    fileFilter(req, file, callback) {
      if (file.fieldname !== 'images' || !ALLOWED.has(file.mimetype)) return callback(new Error('仅支持 images 字段的 PNG、JPG 或 WebP 图片'));
      callback(null, true);
    },
  }).array('images', MAX_FILES);

  function parseUpload(req, res, next) {
    if (!req.is('multipart/form-data')) return res.status(400).json({ message: '请使用 multipart/form-data 上传图片' });
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > CONTENT_LENGTH_LIMIT) return res.status(400).json({ message: '参考图合计最大 40MB' });
    upload(req, res, error => {
      if (error) {
        const message = error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? '最多上传 16 张图片' : error.code === 'LIMIT_FILE_SIZE' ? '单张图片最大 20MB' : error.message || '图片上传失败';
        return res.status(400).json({ message });
      }
      try {
        req.englishImages = deps.normalizeUploadedFiles(req.files, { maxImages: MAX_FILES, maxImageBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
        return next();
      } catch (validationError) {
        return res.status(400).json({ message: validationError.message });
      }
    });
  }

  router.post('/generate-image-stream', limiter, parseUpload, async (req, res) => {
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ message: `提示词最多 ${MAX_PROMPT_CHARS} 个字符` });
    const request = deps.getImageStreamRequest(req, req.englishImages);
    const invalid = deps.validateImageStreamRequest({ ...request, prompt: prompt.slice(0, 2000) });
    if (invalid) return res.status(invalid.statusCode).json({ message: invalid.message });
    const requestId = crypto.randomUUID();
    const metrics = { requestId, startedAt: Date.now() };
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
    deps.writeSseHead(res);
    const heartbeat = deps.startSseHeartbeat(res);
    try {
      await deps.streamImagesApi(request, res, metrics);
    } catch (error) {
      deps.sendSseEventIfWritable(res, 'error', { message: '图片生成失败，请稍后重试', requestId });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  router.post('/extract-character', limiter, parseUpload, async (req, res) => {
    if (req.englishImages.length !== 1) return res.status(400).json({ message: '请上传一张教材人物截图' });
    const provider = deps.resolveImageProvider();
    if (!provider.apiKey) return res.status(500).json({ message: `服务端缺少 ${provider.missingKeyEnv} 环境变量` });
    const model = process.env.ENGLISH_VISION_MODEL || 'gpt-5.6';
    if (!model) return res.status(500).json({ message: '服务端未配置人物识别模型 ENGLISH_VISION_MODEL' });
    const image = req.englishImages[0];
    const instruction = '请观察教材图片中需要制作角色的主要人物或动物，仅描述画面中能看到的特征，不确定或未展示的内容请标明。按基础信息、体型、发型发色、五官、特殊印记、上衣、下装、鞋袜、配饰和道具分项列出，准确描述颜色、材质与细节。不要臆测年龄或被遮挡部分。只输出供人工审核的中文特征描述。';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      const response = await fetch(`${provider.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }, { type: 'input_image', image_url: `data:${image.mimetype};base64,${image.buffer.toString('base64')}` }] }] }),
        signal: controller.signal,
      });
      if (!response.ok) return res.status(502).json({ message: response.status === 404 ? `人物识别模型 ${model} 不可用，请检查 ENGLISH_VISION_MODEL 配置或手动填写描述。` : `人物特征提取服务暂不可用（上游状态 ${response.status}），请检查视觉模型配置或手动填写描述。` });
      const payload = await response.json();
      const description = typeof payload.output_text === 'string' ? payload.output_text : (payload.output || []).flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n');
      if (!description.trim()) return res.status(502).json({ message: '人物特征提取服务未返回描述，请重试或手动填写。' });
      return res.json({ description: description.trim() });
    } catch (error) {
      if (!res.destroyed) return res.status(502).json({ message: error.name === 'AbortError' ? '人物特征提取超时，请重试或手动填写。' : '无法连接人物特征提取服务，请重试或手动填写。' });
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
    }
  });
  return router;
}
module.exports = { createEnglishRouter, createEnglishUploadStorage };
