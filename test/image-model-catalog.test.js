const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../index');
const server = app.listen(0, '127.0.0.1');
const realFetch = global.fetch;
after(() => server.close());
async function base() {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const rows = [
  { id: 'gpt-6.1-sol', supported_endpoint_types: ['openai-response'] },
  { id: 'wan2.7-image', supported_endpoint_types: ['image-generation', 'openai'] },
  { id: 'gpt-image-2.6-flare', supported_endpoint_types: ['image-generation', 'openai-response'] },
  { id: 'gpt-image-2.6-flare', supported_endpoint_types: ['image-generation'] },
  { id: 'looks-like-image-but-is-text', supported_endpoint_types: ['openai'] },
];
function modelsResponse(data = rows) {
  return new Response(JSON.stringify({ object: 'list', data }), { headers: { 'content-type': 'application/json' } });
}
test('catalog reflects the authenticated upstream image models and omits text-only models', async () => {
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/models');
    assert.match(options.headers.Authorization, /^Bearer /);
    return modelsResponse();
  };
  try {
    const response = await realFetch(`${await base()}/api/image-models`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const catalog = await response.json();
    assert.deepEqual(catalog.models, ['wan2.7-image', 'gpt-image-2.6-flare']);
    assert.equal(catalog.defaultModel, 'gpt-image-2.6-flare');
    assert.equal(catalog.source, 'upstream');
  } finally { global.fetch = realFetch; }
});
test('catalog failure is exposed instead of returning a fictional local model list', async () => {
  global.fetch = async () => new Response('bad gateway', { status: 504 });
  try {
    const response = await realFetch(`${await base()}/api/image-models`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.message, /504/);
    assert.equal(body.models, undefined);
  } finally { global.fetch = realFetch; }
});
test('catalog reports missing image capability rather than guessing from model names', async () => {
  global.fetch = async () => modelsResponse([{ id: 'gpt-image-2.6-flare', supported_endpoint_types: ['openai-response'] }]);
  try {
    const response = await realFetch(`${await base()}/api/image-models`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).message, /图片模型/);
  } finally { global.fetch = realFetch; }
});
test('catalog falls back to known image model families when the gateway omits capability fields', async () => {
  // vibe.soyoung.com returns {id, object, created, owned_by, type, display_name} only.
  global.fetch = async () => modelsResponse([
    { id: 'gpt-6.1-terra' },
    { id: 'gpt-image-2.6-flare' },
    { id: 'gpt-image-2.6-sunburst' },
    { id: 'qwen-image-3.0-pro' },
    { id: 'wan2.7-image' },
    { id: 'wan2.7-image-pro' },
    { id: 'wan3.0-video' },
  ]);
  try {
    const response = await realFetch(`${await base()}/api/image-models`);
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(catalog.models, ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'qwen-image-3.0-pro', 'wan2.7-image', 'wan2.7-image-pro']);
    assert.equal(catalog.defaultModel, 'gpt-image-2.6-flare');
  } finally { global.fetch = realFetch; }
});
test('catalog with mixed capability declarations still trusts the declared field', async () => {
  // One item declaring types makes the declaration authoritative for the whole list.
  global.fetch = async () => modelsResponse([
    { id: 'gpt-image-2.6-flare', supported_endpoint_types: ['openai-response'] },
    { id: 'gpt-6.1-sol' },
    { id: 'wan2.7-image', supported_endpoint_types: ['image-generation'] },
  ]);
  try {
    const response = await realFetch(`${await base()}/api/image-models`);
    const catalog = await response.json();
    assert.deepEqual(response.status === 200 ? catalog.models : catalog.message, ['wan2.7-image']);
  } finally { global.fetch = realFetch; }
});
test('catalog fails explicitly when the upstream payload is malformed', async () => {
  for (const body of ['not-json', JSON.stringify({ object: 'list' })]) {
    global.fetch = async () => new Response(body, { headers: { 'content-type': 'application/json' } });
    try {
      const response = await realFetch(`${await base()}/api/image-models`);
      assert.equal(response.status, 502);
      assert.equal((await response.json()).models, undefined);
    } finally { global.fetch = realFetch; }
  }
});
test('a missing configured default falls back to an actual discovered model on submission', async () => {
  global.fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/models') return modelsResponse([rows[1]]);
    assert.equal(JSON.parse(options.body).model, 'wan2.7-image');
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.alloc(100, 1).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const catalogResponse = await realFetch(`${await base()}/api/image-models`);
    assert.equal((await catalogResponse.json()).defaultModel, 'wan2.7-image');
    const response = await realFetch(`${await base()}/api/generate-image-stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'draw', size: 'auto' }),
    });
    assert.match(await response.text(), /event: final_image/);
  } finally { global.fetch = realFetch; }
});
test('a discovered image model can be submitted and a text model is rejected before generation', async () => {
  let imageCalls = 0;
  global.fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/models') return modelsResponse();
    imageCalls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'wan2.7-image');
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.alloc(100, 1).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const [model, status] of [['wan2.7-image', 200], ['gpt-6.1-sol', 400]]) {
      const response = await realFetch(`${await base()}/api/generate-image-stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: 'draw', size: 'auto' }),
      });
      assert.equal(response.status, status);
      const body = await response.text();
      assert.match(body, status === 200 ? /event: final_image/ : /图片模型/);
    }
    assert.equal(imageCalls, 1);
  } finally { global.fetch = realFetch; }
});
