import { MAX_EMBEDDED_IMAGE, compositeMaskedPixels, homographyForQuad, rectangleQuad, validateProject } from './english-refinement.mjs';

export type Point = { x: number; y: number };
export type Layer = { id: string; name: string; image: string; visible: boolean; locked: boolean; opacity: number; quad: Point[]; replacementMask?: string };
export type Landmark = { id: string; name: string; original: Point | null; result: Point | null };
export type Project = { version: 1; width: number; height: number; layers: Layer[]; reference: string; landmarks: Landmark[] };

export function canvas(width: number, height: number) {
  const item = document.createElement('canvas'); item.width = width; item.height = height; return item;
}
export function context(item: HTMLCanvasElement) {
  const result = item.getContext('2d', { willReadFrequently: true });
  if (!result) throw new Error('浏览器无法使用画布');
  return result;
}
const images = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(source: string): Promise<HTMLImageElement> {
  if (images.has(source)) return images.get(source)!;
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image); image.onerror = () => { images.delete(source); reject(new Error('图片读取失败，请使用本地 PNG、JPG 或 WebP 文件')); }; image.src = source;
  });
  images.set(source, promise);
  if (images.size > 40) images.delete(images.keys().next().value!);
  return promise;
}
export function fileData(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('图片仅支持 PNG、JPG、WebP，单张最大 20MB');
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file); });
}
export async function normalizedImage(source: string) {
  const image = await loadImage(source);
  if (!image.naturalWidth || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 16_777_216) throw new Error('图片最大边长为 8192，且不能超过 1600 万像素');
  const output = canvas(image.naturalWidth, image.naturalHeight); context(output).drawImage(image, 0, 0);
  const normalized = output.toDataURL('image/png');
  if (normalized.length >= MAX_EMBEDDED_IMAGE) throw new Error('图片标准化后超过64MB，请先降低分辨率');
  return { image: normalized, width: output.width, height: output.height };
}
export async function newProject(source: string): Promise<Project> {
  const image = await normalizedImage(source);
  return { version: 1, width: image.width, height: image.height, layers: [{ id: crypto.randomUUID(), name: '底图', image: image.image, visible: true, locked: true, opacity: 1, quad: rectangleQuad(0, 0, image.width, image.height) }], reference: '', landmarks: [] };
}

const warped = new Map<string, { key: string; image: HTMLCanvasElement }>();
// Inverse projection samples each destination pixel once, avoiding seams between triangles.
function warp(image: HTMLImageElement, layer: Layer, width: number, height: number) {
  const key = JSON.stringify([layer.image, layer.quad, width, height]);
  const cached = warped.get(layer.id); if (cached?.key === key) return cached.image;
  const output = canvas(width, height), source = canvas(image.width, image.height);
  context(source).drawImage(image, 0, 0);
  const data = context(source).getImageData(0, 0, source.width, source.height).data;
  const out = context(output).createImageData(width, height);
  const m = homographyForQuad(layer.quad);
  const [a, b, c, d, e, f, g, h, i] = m;
  const inv = [e*i-f*h, c*h-b*i, b*f-c*e, f*g-d*i, a*i-c*g, c*d-a*f, d*h-e*g, b*g-a*h, a*e-b*d];
  const left = Math.max(0, Math.floor(Math.min(...layer.quad.map(p => p.x)))), right = Math.min(width, Math.ceil(Math.max(...layer.quad.map(p => p.x))));
  const top = Math.max(0, Math.floor(Math.min(...layer.quad.map(p => p.y)))), bottom = Math.min(height, Math.ceil(Math.max(...layer.quad.map(p => p.y))));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const px = x + .5, py = y + .5, denominator = inv[6]*px + inv[7]*py + inv[8];
    const u = (inv[0]*px + inv[1]*py + inv[2]) / denominator, v = (inv[3]*px + inv[4]*py + inv[5]) / denominator;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    const sx = Math.max(0, Math.min(image.width - 1, u * image.width - .5)), sy = Math.max(0, Math.min(image.height - 1, v * image.height - .5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
    const dx = sx - x0, dy = sy - y0;
    const samples = [[(y0*image.width+x0)*4, (1-dx)*(1-dy)], [(y0*image.width+x1)*4, dx*(1-dy)], [(y1*image.width+x0)*4, (1-dx)*dy], [(y1*image.width+x1)*4, dx*dy]];
    const alpha = samples.reduce((sum, [index, weight]) => sum + data[index + 3] * weight, 0), at = (y*width+x)*4;
    for (let channel = 0; channel < 3; channel++) out.data[at+channel] = alpha ? samples.reduce((sum, [index, weight]) => sum + data[index+channel]*data[index+3]*weight, 0) / alpha : 0;
    out.data[at+3] = alpha;
  }
  context(output).putImageData(out, 0, 0); warped.set(layer.id, { key, image: output });
  if (warped.size > 4) warped.delete(warped.keys().next().value!);
  return output;
}
export async function renderProject(project: Project) {
  const output = canvas(project.width, project.height), ctx = context(output);
  for (const layer of project.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const image = await loadImage(layer.image), [a, b, c, d] = layer.quad;
    if (layer.replacementMask) {
      const coverage = await loadImage(layer.replacementMask);
      const transformed = warp(image, layer, project.width, project.height);
      const transformedMask = warp(coverage, { ...layer, id: `${layer.id}-mask`, image: layer.replacementMask }, project.width, project.height);
      const alpha = context(transformedMask).getImageData(0, 0, project.width, project.height).data;
      const selected = new Uint8ClampedArray(project.width * project.height);
      for (let p = 0; p < selected.length; p++) selected[p] = alpha[p*4+3] * layer.opacity;
      const base = ctx.getImageData(0, 0, project.width, project.height);
      const edited = context(transformed).getImageData(0, 0, project.width, project.height);
      ctx.putImageData(new ImageData(compositeMaskedPixels(base.data, edited.data, selected), project.width, project.height), 0, 0);
      continue;
    }
    ctx.save(); ctx.globalAlpha = layer.opacity;
    if (Math.abs(a.x+c.x-b.x-d.x) < .00001 && Math.abs(a.y+c.y-b.y-d.y) < .00001) {
      ctx.setTransform((b.x-a.x)/image.width, (b.y-a.y)/image.width, (d.x-a.x)/image.height, (d.y-a.y)/image.height, a.x, a.y); ctx.drawImage(image, 0, 0);
    } else ctx.drawImage(warp(image, layer, project.width, project.height), 0, 0);
    ctx.restore();
  }
  return output;
}
export function maskBounds(mask: HTMLCanvasElement) {
  const data = context(mask).getImageData(0, 0, mask.width, mask.height).data;
  let left = mask.width, top = mask.height, right = -1, bottom = -1;
  for (let y=0; y<mask.height; y++) for (let x=0; x<mask.width; x++) if (data[(y*mask.width+x)*4+3]) { left=Math.min(left,x); top=Math.min(top,y); right=Math.max(right,x); bottom=Math.max(bottom,y); }
  return right < left ? null : { x: left, y: top, width: right-left+1, height: bottom-top+1 };
}
export function upstreamMask(mask: HTMLCanvasElement) {
  const output=canvas(mask.width,mask.height), ctx=context(output); ctx.fillStyle='#000'; ctx.fillRect(0,0,output.width,output.height); ctx.globalCompositeOperation='destination-out'; ctx.drawImage(mask,0,0); return output;
}
export function regionalLayer(source: HTMLCanvasElement, mask: HTMLCanvasElement, name: string, replace = false): Layer {
  const bounds=maskBounds(mask); if (!bounds) throw new Error('请先圈选需要处理的区域');
  const output=canvas(bounds.width,bounds.height), ctx=context(output);
  ctx.drawImage(source,bounds.x,bounds.y,bounds.width,bounds.height,0,0,bounds.width,bounds.height);
  let replacementMask: string | undefined;
  if (replace) { const crop=canvas(bounds.width,bounds.height);context(crop).drawImage(mask,bounds.x,bounds.y,bounds.width,bounds.height,0,0,bounds.width,bounds.height);replacementMask=crop.toDataURL('image/png'); }
  else { ctx.globalCompositeOperation='destination-in'; ctx.drawImage(mask,bounds.x,bounds.y,bounds.width,bounds.height,0,0,bounds.width,bounds.height); }
  return { id:crypto.randomUUID(),name,image:output.toDataURL('image/png'),visible:true,locked:false,opacity:1,quad:rectangleQuad(bounds.x,bounds.y,bounds.width,bounds.height),...(replacementMask?{replacementMask}:{}) };
}
export function downloadBlob(blob: Blob, filename: string) {
  const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function pngBlob(image: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve,reject)=>image.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG 导出失败')),'image/png'));
}
export async function readImageStream(response: Response, onStatus: (text: string)=>void, signal: AbortSignal) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    let message=`请求失败（${response.status}）`; try { const body=await response.json(); message=body.message||message; } catch { /* keep status */ } throw new Error(message);
  }
  if (!response.body) throw new Error('服务未返回图片流');
  const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='', result='', error='';
  const handle=(block:string)=>{
    const lines=block.split(/\r?\n/), event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();
    const raw=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'); if(!raw)return;
    let data;try{data=JSON.parse(raw);}catch{return;}
    if((event==='final_image'||event==='done')&&data.image)result=/^(data:|https?:|blob:)/.test(data.image)?data.image:`data:image/png;base64,${data.image}`;
    if(event==='error')error=[data.message,data.detail,data.requestId?`请求 ID：${data.requestId}`:''].filter(Boolean).join(' ');
    if((event==='status'||event==='heartbeat')&&data.message)onStatus(data.message);
  };
  try {
    while(true){if(signal.aborted)throw new DOMException('已取消','AbortError');const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let match;while((match=/\r?\n\r?\n/.exec(buffer))){handle(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);}if(done)break;}
    if(buffer.trim())handle(buffer);if(error)throw new Error(error);if(!result)throw new Error('图片服务未返回最终结果');return result;
  } finally {reader.releaseLock();}
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{const request=indexedDB.open('english-refinement',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
export async function saveDraft(project: Project) {
  validateProject(project);
  const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(project,'draft');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
export async function loadDraft(): Promise<Project|null> {
  const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readonly'), request=tx.objectStore('projects').get('draft');request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);});}finally{db.close();}
}
