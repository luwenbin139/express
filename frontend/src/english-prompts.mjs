const CLOTHING = '衣物面料柔软细腻，褶皱自然松弛，垂坠感真实，整体穿搭柔和舒适，无生硬刻板质感。';
const HAIR = '头发极致细节，清晰发丝纹理，根根分明，层次丰富，整体蓬松饱满，质感轻盈自然，无僵硬结块。';
const FUR = '动物毛发真实细腻、层次分明、蓬松浓密，绒毛纹理清晰立体，光影过渡自然，具备真实毛绒触感，整体毛发不死板、不扁平。';
const HUMAN_STANDARD = '严格保留教材人物的发型、肤色、瞳色、五官、面部雀斑及面部光影差异，不擅自美白或去除雀斑。统一牙齿、眼睛等五官的3D卡通风格，不混用写实与卡通五官。整体服装保持宽松；女性服装不显腰身、弱化胸型和臀线，同时保留原有款式、颜色和结构。同册次人物画风和白皙程度协调但保留肤色差异，同龄人不擅自拉开年龄感；跨册次同一人物不换脸，只在有依据时调整年龄感。';
const ANIMAL_STANDARD = '逐项还原动物毛色、花纹、瞳孔颜色与大小、五官形状、胡须颜色和数量、爪子趾头数量、肉垫颜色、尾巴和衣着细节，侧面与背面也保持一致。同种动物群体的毛发质感、画风及胡须颜色保持协调，保留原有个体差异。原图不清楚时先查证真实生物特征并确认适用性，不凭空决定数量；未查证的细节应列为待确认。';
export const ENGLISH_REVIEW_ITEMS = [
  '角色身份、发型、五官与角色表一致；服装配饰与当前分镜一致，未添加原图没有的红领巾。',
  '动作、表情、位置、透视、手脚与持物关系一致；侧脸可见五官必须还原。',
  '背景及道具的数量、颜色、样式、位置一致，没有多出或遗漏；连续镜头背景协调。',
  '动物胡须、毛发花纹、爪趾、肉垫与尾巴细节一致；看不清的细节已核实。',
  '检查穿帮、手部结构、遮挡和画幅；局部修正后重新对照，未验证项不得视为通过。',
];
export function buildCharacterPrompt(description, species) {
  if (!description.trim()) throw new Error('请先填写并审核人物特征描述。');
  return `参考图1生成3D皮克斯卡通风格角色三视图，包含正面、左侧面和背面，主体置于纯白背景，三视图的身份、衣着、材质和光影保持一致。三视图取景范围一致：鞋子已展示时三视图均保留完整鞋子；鞋子未展示时三视图统一裁到小腿，不凭空补鞋。严格依据参考图和以下经审核的特征，不擅自添加未展示的装饰：\n${description.trim()}\n【正式规范】\n${species === 'animal' ? ANIMAL_STANDARD : HUMAN_STANDARD}\n##💡 特别注意\n-${species === 'animal' ? FUR : HAIR}\n-${CLOTHING}`;
}
export function buildScenePrompt(template, mappings, hasBackground, special, ratio = '16:9') {
  if (mappings.some(value => !value.trim())) throw new Error('请为每张角色图填写与场景人物的对应关系。');
  const mapping = mappings.length ? mappings.map((value, index) => `图片${index + 2}：${value.trim()}`).join('；') : '没有提供角色参考图；场景内角色依据原图统一转为3D卡通形象。';
  const background = hasBackground ? `图片${mappings.length + 2}：背景参考图，仅参考环境连续性，不引入其中的角色或专属道具。` : '未提供背景参考图。';
  const requirements = [
    '用户特别要求具有最高优先级：' + (special.trim() || '无。'),
    '角色身份和外貌参考角色图，服装、穿戴物及动作按场景原图；背景中的未映射人物依据原图转成3D卡通。',
    '默认去除教材文字与对话框；文字类道具保留大概形状和色块但模糊文字；用户要求保留的文字除外。保留思考气泡及剧情内容。',
    '不要遮挡原图中可见的红领巾；原图未戴红领巾时去掉角色参考图的红领巾。保留原图实际存在的重要场景物体，不套用参考示例中的人物、衣服、道具或背景。',
    '动作、表情和侧脸五官必须与当前分镜一致；保持跨场景色调、物品与人物身高比例，符合近大远小。',
    HUMAN_STANDARD, ANIMAL_STANDARD, HAIR, FUR, CLOTHING,
    '【交付前逐项检查】\n' + ENGLISH_REVIEW_ITEMS.map((item, index) => `${index + 1}、${item}`).join('\n'),
  ].join('\n');
  return template.replaceAll('{角色位置映射}', mapping).replaceAll('{画幅}', ratio).replaceAll('{特别要求}', requirements) + `\n【图片编号】图片1：场景原图；${mapping}；${background}\n【优先级】用户特别要求优先，角色服装以场景原图为准。`;
}
export function buildPropPrompt(instruction, hasReference) {
  if (!instruction.trim()) throw new Error('请填写需要替换或补充的内容。');
  return `编辑图片1中的场景。${hasReference ? '图片2是道具参考图，只参考其道具，不改变场景其余内容。' : ''}仅按要求替换或补充道具，保持其他角色、场景、构图、光影和画风一致。\n修改要求：${instruction.trim()}\n${CLOTHING}`;
}
