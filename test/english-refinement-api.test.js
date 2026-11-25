const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../index');
const server = app.listen(0, '127.0.0.1');
after(() => server.close());
const realFetch = global.fetch;
function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
async function base() { if (!server.listening) await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }
function form(maskSize = [32, 32]) {
  const data = new FormData();
  data.append('prompt', '只修正手与桶把'); data.append('model', 'gpt-image-2.6-sunburst'); data.append('size', 'auto');
  data.append('images', new Blob([png(32, 32)], { type: 'image/png' }), 'base.png');
  if (maskSize) data.append('mask', new Blob([png(...maskSize)], { type: 'image/png' }), 'mask.png');
  return data;
}
test('regional refinement forwards one alpha mask separately from reference images', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  let received;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-image-2.6-sunburst', supported_endpoint_types: ['image-generation'] }] }), { headers: { 'content-type': 'application/json' } });
    received = options.body;
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.alloc(100, 1).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const response = await realFetch(`${await base()}/api/english/refine-image-stream`, { method: 'POST', body: form() });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: final_image/);
    assert.equal(received.getAll('image[]').length, 1);
    assert.equal(received.get('mask').type, 'image/png');
    assert.deepEqual(Buffer.from(await received.get('mask').arrayBuffer()), png(32, 32));
  } finally {
    global.fetch = realFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
test('regional refinement requires a mask matching the first PNG and never falls back to unmasked generation', async () => {
  for (const body of [form(null), form([16, 32])]) {
    const response = await realFetch(`${await base()}/api/english/refine-image-stream`, { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /蒙版|尺寸/);
  }
});
