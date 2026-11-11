const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../index');
const server = app.listen(0, '127.0.0.1');
after(() => server.close());
const upstreamFetch = global.fetch;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function base() { if (!server.listening) await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }
function form(count, prompt = '测试提示词') {
  const data = new FormData();
  data.append('prompt', prompt);
  data.append('model', 'gpt-image-2.5-flare');
  data.append('size', 'auto');
  for (let i = 0; i < count; i++) data.append('images', new Blob([png], { type: 'image/png' }), `${i}.png`);
  return data;
}
test('independent workbench accepts five reference images and long prompts while the original API rejects them', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let received;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return upstreamFetch(url, options);
    received = options.body;
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.alloc(100, 1).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const root = await base();
    const response = await upstreamFetch(`${root}/api/english/generate-image-stream`, { method: 'POST', body: form(5, '场景'.repeat(1200)) });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: final_image/);
    assert.equal(received.getAll('image[]').length, 5);
    assert.equal(received.get('prompt').length, 2400);
    const original = await upstreamFetch(`${root}/api/generate-image-stream`, { method: 'POST', body: form(5) });
    assert.equal(original.status, 400);
    assert.match(await original.text(), /最多上传 4 张/);
  } finally {
    global.fetch = upstreamFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
test('feature extraction returns reviewable text from the configured vision model', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return upstreamFetch(url, options);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'gpt-5.6');
    assert.equal(payload.input[0].content[1].type, 'input_image');
    return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '黑发，穿蓝色上衣' }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const data = new FormData();
    data.append('images', new Blob([png], { type: 'image/png' }), 'source.png');
    const response = await upstreamFetch(`${await base()}/api/english/extract-character`, { method: 'POST', body: data });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).description, '黑发，穿蓝色上衣');
  } finally {
    global.fetch = upstreamFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
test('independent upload rejects excessive or forged reference images', async () => {
  const root = await base();
  const tooMany = await upstreamFetch(`${root}/api/english/generate-image-stream`, { method: 'POST', body: form(17) });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).message, /16/);
  const bad = new FormData();
  bad.append('images', new Blob(['not an image'], { type: 'image/png' }), 'bad.png');
  const invalid = await upstreamFetch(`${root}/api/english/extract-character`, { method: 'POST', body: bad });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).message, /PNG/);
});
test('feature extraction exposes a useful error when the vision provider fails', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    const data = new FormData(); data.append('images', new Blob([png], { type: 'image/png' }), 'source.png');
    const response = await upstreamFetch(`${await base()}/api/english/extract-character`, { method: 'POST', body: data });
    assert.equal(response.status, 502);
    assert.match((await response.json()).message, /手动填写/);
  } finally {
    global.fetch = upstreamFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
test('upload storage rejects aggregate bytes as they arrive across files', async () => {
  const { PassThrough } = require('node:stream');
  const { createEnglishUploadStorage } = require('../english-api');
  assert.equal(typeof createEnglishUploadStorage, 'function');
  const storage = createEnglishUploadStorage(10);
  const request = {};
  const first = new PassThrough();
  const stored = new Promise((resolve, reject) => storage._handleFile(request, { stream: first }, (error, result) => error ? reject(error) : resolve(result)));
  first.end(Buffer.alloc(7));
  assert.equal((await stored).size, 7);
  const second = new PassThrough();
  const rejected = new Promise(resolve => storage._handleFile(request, { stream: second }, error => resolve(error)));
  second.write(Buffer.alloc(4));
  const error = await rejected;
  assert.match(error.message, /合计最大/);
  second.end();
});
