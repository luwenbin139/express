const CLOTHING = '衣物面料柔软细腻，褶皱自然松弛，垂坠感真实，整体穿搭柔和舒适，无生硬刻板质感。';
const HAIR = '头发极致细节，清晰发丝纹理，根根分明，层次丰富，整体蓬松饱满，质感轻盈自然，无僵硬结块。';
const FUR = '动物毛发真实细腻、层次分明、蓬松浓密，绒毛纹理清晰立体，光影过渡自然，具备真实毛绒触感，整体毛发不死板、不扁平。';
export function buildCharacterPrompt(description, species) {
  if (!description.trim()) throw new Error('请先填写并审核人物特征描述。');
  return `参考图1生成3D皮克斯卡通风格角色三视图，包含正面、纯侧面和背面完整站姿，人物主体置于纯白背景，三视图的身份、衣着、材质和光影保持一致。严格依据参考图和以下经人工审核的特征，不擅自添加未展示的装饰：\n${description.trim()}\n##💡 特别注意\n-${species === 'animal' ? FUR : HAIR}\n-${CLOTHING}`;
}
export function buildScenePrompt(template, mappings, hasBackground, special, ratio = '16:9') {
  if (mappings.some(value => !value.trim())) throw new Error('请为每张角色图填写与场景人物的对应关系。');
  const mapping = mappings.length ? mappings.map((value, index) => `图片${index + 2}：${value.trim()}`).join('；') : '没有提供角色参考图；场景内角色依据原图统一转为3D卡通形象。';
  const background = hasBackground ? `图片${mappings.length + 2}：背景参考图，仅参考环境连续性，不引入其中的角色或专属道具。` : '未提供背景参考图。';
  const requirements = [
    '用户特别要求具有最高优先级：' + (special.trim() || '无。'),
    '角色身份和外貌参考角色图，服装、穿戴物及动作按场景原图；背景中的未映射人物依据原图转成3D卡通。',
    '默认去除教材文字与对话框；文字类道具保留大概形状和色块但模糊文字；用户要求保留的文字除外。保留思考气泡及剧情内容。',
    '不要遮挡原图中可见的红领巾；删除运动轨迹与状态图标；保持跨场景色调、物品与人物身高比例，符合近大远小。2D太阳不必画出，可保留阳光。',
    HAIR, CLOTHING,
  ].join('\n');
  return template.replaceAll('{角色位置映射}', mapping).replaceAll('{画幅}', ratio).replaceAll('{特别要求}', requirements) + `\n【图片编号】图片1：场景原图；${mapping}；${background}\n【优先级】用户特别要求优先，角色服装以场景原图为准。`;
}
export function buildPropPrompt(instruction, hasReference) {
  if (!instruction.trim()) throw new Error('请填写需要替换或补充的内容。');
  return `编辑图片1中的场景。${hasReference ? '图片2是道具参考图，只参考其道具，不改变场景其余内容。' : ''}仅按要求替换或补充道具，保持其他角色、场景、构图、光影和画风一致。\n修改要求：${instruction.trim()}\n${CLOTHING}`;
}
