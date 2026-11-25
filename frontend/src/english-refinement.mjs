export function compositeMaskedPixels(base, edited, mask) {
  if (base.length !== edited.length || base.length !== mask.length * 4) throw new Error('图片与蒙版尺寸不一致');
  const output = new Uint8ClampedArray(base);
  for (let p = 0; p < mask.length; p++) {
    const amount = mask[p] / 255;
    if (!amount) continue;
    const i = p * 4;
    const a = (base[i + 3] / 255) * (1 - amount);
    const b = (edited[i + 3] / 255) * amount;
    const alpha = a + b;
    for (let c = 0; c < 3; c++) output[i + c] = alpha ? (base[i + c] * a + edited[i + c] * b) / alpha : 0;
    output[i + 3] = alpha * 255;
  }
  return output;
}

export function rectangleQuad(x, y, width, height) {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

export function editCanvasGeometry(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || Math.max(width/height,height/width) > 3) throw new Error('局部精修画幅须在1:3～3:1之间');
  const scale = Math.min(1, 3808/Math.max(width,height), Math.sqrt(8_000_000/(width*height)));
  const growth = Math.max(scale, Math.sqrt(660_000/(width*height)));
  const targetWidth = Math.ceil(width*growth/16)*16, targetHeight = Math.ceil(height*growth/16)*16;
  const fit = Math.min(targetWidth/width,targetHeight/height);
  const contentWidth=width*fit,contentHeight=height*fit;
  return {width:targetWidth,height:targetHeight,x:(targetWidth-contentWidth)/2,y:(targetHeight-contentHeight)/2,contentWidth,contentHeight};
}

export function isValidQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4 || quad.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const crosses = quad.map((a, i) => {
    const b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  return crosses.every(c => c > 0.01) || crosses.every(c => c < -0.01);
}

export function homographyForQuad(quad) {
  if (!isValidQuad(quad)) throw new Error('四角必须组成未交叉的有效区域');
  const [a, b, c, d] = quad;
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const divisor = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / divisor;
  const h = (dx1 * dy3 - dx3 * dy1) / divisor;
  return [b.x - a.x + g * b.x, d.x - a.x + h * d.x, a.x, b.y - a.y + g * b.y, d.y - a.y + h * d.y, a.y, g, h, 1];
}

export function projectPoint(matrix, point) {
  const divisor = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / divisor, y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / divisor };
}

export const MAX_EMBEDDED_IMAGE = 64 * 1024 * 1024;
const embeddedImage = value => typeof value === 'string' && value.length < MAX_EMBEDDED_IMAGE && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
export function validateProject(project) {
  if (!project || project.version !== 1 || !Number.isInteger(project.width) || !Number.isInteger(project.height) || project.width < 1 || project.height < 1 || project.width > 8192 || project.height > 8192 || project.width * project.height > 16_777_216) throw new Error('工程画布无效或超过 1600 万像素');
  if (!Array.isArray(project.layers) || !project.layers.length || project.layers.length > 24) throw new Error('工程应有 1～24 个图层');
  const ids = new Set();
  for (const layer of project.layers) {
    if (!layer || typeof layer.id !== 'string' || ids.has(layer.id) || typeof layer.name !== 'string' || layer.name.length > 100 || !embeddedImage(layer.image) || !isValidQuad(layer.quad) || layer.quad.some(p => Math.abs(p.x) > 32768 || Math.abs(p.y) > 32768) || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 || typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') throw new Error('工程图层内容无效');
    if (layer.replacementMask && !embeddedImage(layer.replacementMask)) throw new Error('工程替换蒙版无效');
    ids.add(layer.id);
  }
  if (project.reference && !embeddedImage(project.reference)) throw new Error('工程原图必须为内嵌图片');
  const imageBytes = project.layers.reduce((sum, layer) => sum + layer.image.length + (layer.replacementMask?.length || 0), 0) + (project.reference?.length || 0);
  if (imageBytes > 72 * 1024 * 1024) throw new Error('工程图片总量超过72MB，请先合并图层或降低图片分辨率');
  if (!Array.isArray(project.landmarks) || project.landmarks.length > 100) throw new Error('工程关键点无效');
  for (const item of project.landmarks) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || item.name.length > 100) throw new Error('工程关键点无效');
    for (const key of ['original', 'result']) if (item[key] !== null && (!item[key] || !Number.isFinite(item[key].x) || !Number.isFinite(item[key].y) || item[key].x < 0 || item[key].y < 0 || item[key].x > project.width || item[key].y > project.height)) throw new Error('关键点超出画布');
  }
  return project;
}

export function landmarkReport(landmarks, width, height) {
  const points = landmarks.filter(p => p.original && p.result).map(p => {
    const pixels = Math.hypot(p.original.x - p.result.x, p.original.y - p.result.y);
    return { id: p.id, name: p.name, pixels, percent: pixels / Math.max(width, height) * 100 };
  });
  return { total: landmarks.length, completed: points.length, points };
}
