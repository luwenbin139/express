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

test('formal scene standards require identical expression and scene clothing without turnaround conflicts', async () => {
  const fs = require('node:fs');
  const template = fs.readFileSync(require('node:path').join(__dirname, '../frontend/src/english-scene-prompt.txt'), 'utf8');
  const { buildScenePrompt } = await source();
  const prompt = buildScenePrompt(template, ['左边老师'], false, '老师左手提桶');
  assert.match(prompt, /表情必须与图1完全一致/);
  assert.match(prompt, /服装.*配饰.*以图1为准/);
  assert.match(prompt, /胡须数量/);
  assert.match(prompt, /侧脸.*五官/);
  assert.doesNotMatch(prompt, /表情不必与图1完全一致|不得擅改发型、服装、配色/);
  assert.doesNotMatch(prompt, /2D太阳不必画出/);
  assert.match(prompt, /老师左手提桶/);
  assert.doesNotMatch(prompt, /黄色拼图|紫色上衣|校门口户外场景/);
});

test('character standards retain document clothing, crop and animal anatomy rules', async () => {
  const { buildCharacterPrompt } = await source();
  const person = buildCharacterPrompt('棕发老师', 'human');
  assert.match(person, /左侧面/);
  assert.match(person, /鞋子未展示.*小腿/);
  assert.match(person, /服装保持宽松/);
  assert.match(person, /弱化胸型和臀线/);
  assert.match(person, /雀斑/);
  assert.match(person, /不换脸/);
  const animal = buildCharacterPrompt('灰色老鼠', 'animal');
  assert.match(animal, /胡须.*数量/);
  assert.match(animal, /趾头.*肉垫/);
  assert.match(animal, /查证/);
});
