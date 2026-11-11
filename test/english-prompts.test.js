const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = () => import('../frontend/src/english-prompts.mjs');
test('scene prompt preserves mapping, reference order, and the user override', async () => {
  const { buildScenePrompt } = await source();
  const result = buildScenePrompt('映射：{角色位置映射}\n比例：{画幅}\n要求：{特别要求}', ['左边女孩', '右边男孩'], true, '保留 HELLO');
  assert.match(result, /图片2.*左边女孩/);
  assert.match(result, /图片3.*右边男孩/);
  assert.match(result, /图片4.*背景参考/);
  assert.match(result, /16:9/);
  assert.match(result, /保留 HELLO/);
});
test('scene generation never guesses a missing role mapping', async () => {
  const { buildScenePrompt } = await source();
  assert.throws(() => buildScenePrompt('{角色位置映射}', [''], false, ''), /填写.*对应/);
});
test('character prompt includes the reviewed description and species-specific detail', async () => {
  const { buildCharacterPrompt } = await source();
  const animal = buildCharacterPrompt('黑白猫', 'animal');
  assert.match(animal, /黑白猫/);
  assert.match(animal, /动物毛发/);
  assert.doesNotMatch(animal, /头发极致细节/);
});
test('scene prompt reflects the selected output ratio', async () => {
  const { buildScenePrompt } = await source();
  const result = buildScenePrompt('比例：{画幅}', [], false, '', '1:1');
  assert.match(result, /比例：1:1/);
});
