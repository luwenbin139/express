import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

type ImageFile = {
  id: string;
  file: File;
  previewUrl: string;
};

type GenerationState = "idle" | "generating" | "cancelled" | "success" | "error";

type SseMessage = {
  event: string;
  data: string;
};

type SseMessageResult = {
  successfulImage?: boolean;
  generationError?: GenerationError;
};

type GenerationError = {
  message: string;
  detail?: string;
  requestId?: string;
  retryable?: boolean;
};

type LightboxImage = {
  src: string;
  alt: string;
};

type TransparentPreview = {
  name: string;
  previewUrl: string;
  size?: number;
};

type CompressedImageResult = {
  blob: Blob;
  reachedTarget: boolean;
};

type BorderTrimResult = {
  blob: Blob;
  wasTrimmed: boolean;
};

type PdfImageOutput = {
  name: string;
  downloadUrl: string;
  previewUrl: string;
  size: number;
  pageCount: number;
  isArchive: boolean;
};

type PdfOutput = {
  name: string;
  downloadUrl: string;
  size: number;
  pageCount: number;
};

type GenerationHistoryEntry = {
  id: string;
  image: string;
  prompt: string;
  size: string;
  createdAt: number;
};

type IdPhotoSpec = {
  id: string;
  label: string;
  width: number;
  height: number;
  millimeters: string;
};

type IdPhotoBackground = {
  id: string;
  label: string;
  color: string;
};

const API_ENDPOINT = "/api/generate-image-stream";
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_FILE_SIZE = 20 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_SIZE = 40 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 2000;
const REFINEMENT_PROMPT_PREFIX = "请基于当前最终图继续修改，只按下面的追加要求调整，其余画面尽量保持一致。\n追加要求：";
const MAX_REFINEMENT_PROMPT_LENGTH = MAX_PROMPT_LENGTH - REFINEMENT_PROMPT_PREFIX.length;
const MAX_TRANSPARENT_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOOL_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PDF_MIME_TYPE = "application/pdf";
const DEFAULT_IMAGE_SIZE = "auto";
const IMAGE_SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024", "2048x1152", "1152x2048"];
const ID_PHOTO_SPECS: IdPhotoSpec[] = [
  { id: "one-inch", label: "一寸", width: 295, height: 413, millimeters: "25 x 35 mm" },
  { id: "small-one-inch", label: "小一寸", width: 260, height: 378, millimeters: "22 x 32 mm" },
  { id: "two-inch", label: "二寸", width: 413, height: 579, millimeters: "35 x 49 mm" },
];
const ID_PHOTO_BACKGROUNDS: IdPhotoBackground[] = [
  { id: "blue", label: "蓝底", color: "#438EDB" },
  { id: "white", label: "白底", color: "#FFFFFF" },
  { id: "red", label: "红底", color: "#C8222A" },
];
const COMPRESSION_TARGETS = [
  { label: "1 MB", value: 1 * 1024 * 1024 },
  { label: "5 MB", value: 5 * 1024 * 1024 },
  { label: "10 MB", value: 10 * 1024 * 1024 },
  { label: "100 MB", value: 100 * 1024 * 1024 },
];
const MAX_COMPRESSION_DIMENSION = 4096;
const BORDER_ANALYSIS_MAX_DIMENSION = 1600;
const BORDER_WHITE_LUMA = 247;
const BORDER_WHITE_CHROMA = 14;
const BORDER_ACTIVE_RATIO = 0.18;
const BORDER_MAX_INACTIVE_GAP = 4;
const PDF_RENDER_SCALE = 2;
const PDF_RENDER_MAX_DIMENSION = 4096;
const LIGHTBOX_MIN_ZOOM = 1;
const LIGHTBOX_MAX_ZOOM = 4;
const LIGHTBOX_ZOOM_STEP = 0.25;
const HISTORY_DB_NAME = "ai-image-studio";
const HISTORY_STORE_NAME = "generation-history";
const MAX_HISTORY_ITEMS = 12;

const loadPdfImageTools = (() => {
  let toolsPromise: Promise<{
    getDocument: typeof import("pdfjs-dist").getDocument;
    JSZip: typeof import("jszip").default;
  }> | null = null;

  return () => {
    if (!toolsPromise) {
      toolsPromise = Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        import("jszip"),
      ]).then(([pdfjs, worker, zip]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return { getDocument: pdfjs.getDocument, JSZip: zip.default };
      });
    }

    return toolsPromise;
  };
})();

const loadPdfWriter = (() => {
  let writerPromise: Promise<typeof import("jspdf").jsPDF> | null = null;
  return () => writerPromise ??= import("jspdf").then(({ jsPDF }) => jsPDF);
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatHistoryTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function getFinalImageFileName() {
  return `ai-image-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

function openHistoryDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(HISTORY_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const store = database.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地生成历史。"));
  });
}

async function getGenerationHistory() {
  const database = await openHistoryDatabase();

  return new Promise<GenerationHistoryEntry[]>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE_NAME, "readonly");
    const request = transaction.objectStore(HISTORY_STORE_NAME).getAll();
    request.onsuccess = () => {
      database.close();
      resolve((request.result as GenerationHistoryEntry[]).sort((first, second) => second.createdAt - first.createdAt));
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("无法读取本地生成历史。"));
    };
  });
}

async function saveGenerationHistory(entry: GenerationHistoryEntry) {
  const database = await openHistoryDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(HISTORY_STORE_NAME);
    store.put(entry);
    const listRequest = store.getAll();

    listRequest.onsuccess = () => {
      const expiredItems = (listRequest.result as GenerationHistoryEntry[])
        .sort((first, second) => second.createdAt - first.createdAt)
        .slice(MAX_HISTORY_ITEMS);
      expiredItems.forEach((item) => store.delete(item.id));
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("无法保存本地生成历史。"));
    };
  });
}

async function deleteGenerationHistory(id: string) {
  const database = await openHistoryDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE_NAME, "readwrite");
    transaction.objectStore(HISTORY_STORE_NAME).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("无法删除本地生成历史。"));
    };
  });
}

async function clearGenerationHistory() {
  const database = await openHistoryDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE_NAME, "readwrite");
    transaction.objectStore(HISTORY_STORE_NAME).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("无法清空本地生成历史。"));
    };
  });
}

function clampLightboxZoom(value: number) {
  return Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, Math.round(value * 100) / 100));
}

function normalizeLightboxRotation(value: number) {
  return ((Math.round(value) % 360) + 360) % 360;
}

function normalizeImageSource(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const image = value.trim();
  if (image.startsWith("http") || image.startsWith("data:image") || image.startsWith("blob:")) {
    return image;
  }
  return `data:image/png;base64,${image}`;
}

function extractPayload(data: string): unknown {
  const trimmed = data.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function getTextFromPayload(payload: unknown, fallbacks: string[]) {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";
  for (const key of fallbacks) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(payload);
}

function getGenerationErrorFromPayload(payload: unknown): GenerationError {
  if (typeof payload === "string") {
    return { message: payload || "图片生成流连接失败" };
  }

  if (!isRecord(payload)) {
    return { message: "图片生成流连接失败" };
  }

  return {
    message: getTextFromPayload(payload, ["error", "message"]) || "图片生成流连接失败",
    detail: typeof payload.detail === "string" && payload.detail.trim() ? payload.detail.trim() : undefined,
    requestId: typeof payload.requestId === "string" && payload.requestId.trim() ? payload.requestId.trim() : undefined,
    retryable: payload.retryable === true,
  };
}

function getImageFromPayload(payload: unknown) {
  if (typeof payload === "string") return normalizeImageSource(payload);
  if (!isRecord(payload)) return null;
  const keys = ["image", "image_url", "imageUrl", "url", "data", "b64_json", "base64"];
  for (const key of keys) {
    const image = normalizeImageSource(payload[key]);
    if (image) return image;
  }
  return null;
}

function createImageFormData(prompt: string, size: string, images: File[]) {
  const formData = new FormData();
  formData.append("prompt", prompt);
  formData.append("size", size || DEFAULT_IMAGE_SIZE);
  images.forEach((image) => formData.append("images", image));
  return formData;
}

function getDataUrlMimeType(source: string) {
  const match = source.match(/^data:(image\/(?:png|jpe?g|webp));base64,/i);
  if (!match) return "";
  return match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
}

function getImageFileExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function createImageFileFromSource(source: string) {
  const response = await fetch(source);

  if (!response.ok) {
    throw new Error("无法读取当前生成图片，请重新生成后再追加提示词。");
  }

  const blob = await response.blob();
  const mimeType = blob.type || getDataUrlMimeType(source) || "image/png";

  if (!ALLOWED_TYPES.has(mimeType)) {
    throw new Error("当前生成图片格式不支持追加编辑。");
  }

  return new File([blob], `generated-result-${Date.now()}.${getImageFileExtension(mimeType)}`, {
    type: mimeType,
  });
}

function createRefinementPrompt(refinementPrompt: string) {
  return `${REFINEMENT_PROMPT_PREFIX}${refinementPrompt.trim()}`;
}

function createTransparentFileName(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}-transparent.png`;
}

function createCompressedFileName(fileName: string, mimeType: string) {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}-compressed.${getImageFileExtension(mimeType)}`;
}

function createBorderlessFileName(fileName: string, mimeType: string) {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}-no-border.${getImageFileExtension(mimeType)}`;
}

function createIdPhotoFileName(fileName: string, spec: IdPhotoSpec, background: IdPhotoBackground) {
  return `${getFileBaseName(fileName)}-${background.id}-${spec.id}-${spec.width}x${spec.height}.png`;
}

function createIdPhotoPrompt(spec: IdPhotoSpec, background: IdPhotoBackground) {
  return [
    "Use case: identity-preserve.",
    "Create a standard Chinese ID photo from this reference image.",
    "Keep exactly the same person, face, glasses, hairstyle, pose, expression, clothing, and natural facial features.",
    `Replace only the background with a uniform solid ${background.label} background (${background.color}), with no gradient, texture, shadow, border, watermark, or text.`,
    `Use a ${spec.width}:${spec.height} vertical portrait composition. Center the head and shoulders, preserve appropriate top headroom, and keep the shoulders visible.`,
    "Use clean, even studio lighting. Do not beautify, change identity, alter facial features, or add accessories.",
  ].join("\n");
}

function getFileBaseName(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

function createPdfPageImageName(fileName: string, pageNumber: number) {
  return `${getFileBaseName(fileName)}-page-${pageNumber}.png`;
}

function createImagesPdfFileName(files: File[]) {
  return files.length === 1 ? `${getFileBaseName(files[0].name)}.pdf` : "images-to-pdf.pdf";
}

function isPdfFile(file: File) {
  return file.type === PDF_MIME_TYPE || file.name.toLowerCase().endsWith(".pdf");
}

function loadImageElement(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败，请换一张 PNG、JPG 或 WebP 图片。"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("图片导出失败，请换一张图片重试。"));
    }, type, quality);
  });
}

async function createStandardIdPhotoBlob(source: string, spec: IdPhotoSpec) {
  const imageFile = await createImageFileFromSource(source);
  const image = await loadImageElement(imageFile);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) throw new Error("当前浏览器不支持证件照尺寸处理。");

  canvas.width = spec.width;
  canvas.height = spec.height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const scale = Math.max(spec.width / image.naturalWidth, spec.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (spec.width - width) / 2, (spec.height - height) / 2, width, height);

  return canvasToBlob(canvas, "image/png");
}

function isNearWhiteBorderPixel(data: Uint8ClampedArray, index: number) {
  const alpha = data[index + 3];
  if (alpha < 16) return true;

  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const maxChannel = Math.max(red, green, blue);
  const minChannel = Math.min(red, green, blue);
  const chroma = maxChannel - minChannel;
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

  return luma >= BORDER_WHITE_LUMA && chroma <= BORDER_WHITE_CHROMA;
}

function findLargestContentRange(activity: boolean[]) {
  let bestStart = 0;
  let bestEnd = 0;
  let currentStart = -1;
  let lastActive = -1;

  const commitCurrentRange = () => {
    if (currentStart >= 0 && lastActive + 1 - currentStart > bestEnd - bestStart) {
      bestStart = currentStart;
      bestEnd = lastActive + 1;
    }
    currentStart = -1;
    lastActive = -1;
  };

  activity.forEach((isActive, index) => {
    if (isActive) {
      if (currentStart < 0) currentStart = index;
      lastActive = index;
      return;
    }

    if (currentStart >= 0 && index - lastActive > BORDER_MAX_INACTIVE_GAP) {
      commitCurrentRange();
    }
  });
  commitCurrentRange();

  return bestEnd > bestStart ? { start: bestStart, end: bestEnd } : null;
}

function getNonWhiteActivity(data: Uint8ClampedArray, width: number, height: number, isRow: boolean, start: number, end: number) {
  const activity: boolean[] = [];

  for (let outer = 0; outer < (isRow ? height : width); outer += 1) {
    let samples = 0;
    let contentPixels = 0;

    for (let inner = start; inner < end; inner += 2) {
      const x = isRow ? inner : outer;
      const y = isRow ? outer : inner;
      const index = (y * width + x) * 4;
      samples += 1;
      if (!isNearWhiteBorderPixel(data, index)) contentPixels += 1;
    }

    activity.push(samples > 0 && contentPixels / samples >= BORDER_ACTIVE_RATIO);
  }

  return activity;
}

function findBorderContentBounds(imageData: ImageData) {
  const { data, width, height } = imageData;
  const rows = findLargestContentRange(getNonWhiteActivity(data, width, height, true, 0, width));
  if (!rows) return null;

  const columns = findLargestContentRange(getNonWhiteActivity(data, width, height, false, rows.start, rows.end));
  if (!columns) return null;

  return {
    x: columns.start,
    y: rows.start,
    width: columns.end - columns.start,
    height: rows.end - rows.start,
  };
}

async function createBorderlessImageBlob(file: File): Promise<BorderTrimResult> {
  const image = await loadImageElement(file);
  const analysisScale = Math.min(1, BORDER_ANALYSIS_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const analysisCanvas = document.createElement("canvas");
  const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });

  if (!analysisContext) throw new Error("当前浏览器不支持图片边框识别。");

  analysisCanvas.width = Math.max(1, Math.round(image.naturalWidth * analysisScale));
  analysisCanvas.height = Math.max(1, Math.round(image.naturalHeight * analysisScale));
  analysisContext.drawImage(image, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const detectedBounds = findBorderContentBounds(analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height));

  if (!detectedBounds) throw new Error("未识别到可裁切的图片内容。");

  const sourceX = Math.max(0, Math.floor(detectedBounds.x / analysisScale));
  const sourceY = Math.max(0, Math.floor(detectedBounds.y / analysisScale));
  const sourceRight = Math.min(image.naturalWidth, Math.ceil((detectedBounds.x + detectedBounds.width) / analysisScale));
  const sourceBottom = Math.min(image.naturalHeight, Math.ceil((detectedBounds.y + detectedBounds.height) / analysisScale));
  const sourceWidth = Math.max(1, sourceRight - sourceX);
  const sourceHeight = Math.max(1, sourceBottom - sourceY);
  const wasTrimmed = sourceX > 2 || sourceY > 2 || sourceRight < image.naturalWidth - 2 || sourceBottom < image.naturalHeight - 2;
  const outputCanvas = document.createElement("canvas");
  const outputContext = outputCanvas.getContext("2d");

  if (!outputContext) throw new Error("当前浏览器不支持图片裁切。");

  outputCanvas.width = sourceWidth;
  outputCanvas.height = sourceHeight;
  outputContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  const outputType = getCompressionMimeType(file);

  return {
    blob: await canvasToBlob(outputCanvas, outputType, outputType === "image/png" ? undefined : 0.96),
    wasTrimmed,
  };
}

function applyTransparentMatte(imageData: ImageData) {
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const existingAlpha = data[index + 3] / 255;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const chroma = maxChannel - minChannel;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const inkFromDark = Math.max(0, Math.min(1, (248 - luma) / 118));
    const inkFromColor = Math.max(0, Math.min(1, (chroma - 9) / 42));
    let alpha = Math.max(inkFromDark, inkFromColor);

    if (luma > 236 && chroma < 14) {
      alpha = 0;
    }

    if (luma < 170 || chroma > 72) {
      alpha = 1;
    }

    data[index + 3] = Math.round(Math.min(existingAlpha, Math.max(0, Math.min(1, alpha ** 0.82))) * 255);
  }
}

async function createTransparentPngBlob(file: File) {
  const image = await loadImageElement(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("当前浏览器不支持图片透明处理。");
  }

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  context.drawImage(image, 0, 0);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  applyTransparentMatte(imageData);
  context.putImageData(imageData, 0, 0);

  return canvasToBlob(canvas, "image/png");
}

function getCompressionMimeType(file: File) {
  return file.type === "image/png" ? "image/png" : file.type === "image/webp" ? "image/webp" : "image/jpeg";
}

async function createCompressedImageBlob(file: File, targetBytes: number): Promise<CompressedImageResult> {
  const image = await loadImageElement(file);
  const outputType = getCompressionMimeType(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("当前浏览器不支持图片压缩。");
  }

  const initialScale = Math.min(1, MAX_COMPRESSION_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  let width = Math.max(1, Math.round(image.naturalWidth * initialScale));
  let height = Math.max(1, Math.round(image.naturalHeight * initialScale));
  let quality = 0.92;
  let smallestBlob: Blob | null = null;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, outputType, outputType === "image/png" ? undefined : quality);
    if (!smallestBlob || blob.size < smallestBlob.size) smallestBlob = blob;
    if (blob.size <= targetBytes) return { blob, reachedTarget: true };

    if (outputType !== "image/png" && quality > 0.5) {
      quality = Math.max(0.5, quality - 0.08);
      continue;
    }

    const targetScale = Math.max(0.58, Math.min(0.86, Math.sqrt(targetBytes / blob.size) * 0.94));
    const minimumScale = Math.min(1, 320 / Math.max(width, height));
    const scale = Math.max(minimumScale, targetScale);
    const nextWidth = Math.max(1, Math.round(width * scale));
    const nextHeight = Math.max(1, Math.round(height * scale));

    if (nextWidth === width && nextHeight === height) break;
    width = nextWidth;
    height = nextHeight;
    quality = 0.92;
  }

  if (!smallestBlob) throw new Error("图片压缩失败，请换一张图片重试。");
  return { blob: smallestBlob, reachedTarget: false };
}

async function createPdfImageOutput(file: File, onProgress: (pageNumber: number, pageCount: number) => void): Promise<PdfImageOutput> {
  const [{ getDocument, JSZip }, fileData] = await Promise.all([
    loadPdfImageTools(),
    file.arrayBuffer(),
  ]);
  const loadingTask = getDocument({ data: new Uint8Array(fileData) });
  const pdfDocument = await loadingTask.promise;
  const pageCount = pdfDocument.numPages;
  const zip = new JSZip();
  let firstPageBlob: Blob | null = null;

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      onProgress(pageNumber, pageCount);
      const page = await pdfDocument.getPage(pageNumber);
      const initialViewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const scale = Math.min(1, PDF_RENDER_MAX_DIMENSION / Math.max(initialViewport.width, initialViewport.height));
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE * scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) throw new Error("当前浏览器不支持 PDF 页面渲染。");

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const pageBlob = await canvasToBlob(canvas, "image/png");
      if (!firstPageBlob) firstPageBlob = pageBlob;
      zip.file(createPdfPageImageName(file.name, pageNumber), pageBlob);
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  if (!firstPageBlob) throw new Error("PDF 中没有可转换的页面。");

  const previewUrl = URL.createObjectURL(firstPageBlob);
  if (pageCount === 1) {
    return {
      name: createPdfPageImageName(file.name, 1),
      downloadUrl: previewUrl,
      previewUrl,
      size: firstPageBlob.size,
      pageCount: 1,
      isArchive: false,
    };
  }

  const archiveBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return {
    name: `${getFileBaseName(file.name)}-images.zip`,
    downloadUrl: URL.createObjectURL(archiveBlob),
    previewUrl,
    size: archiveBlob.size,
    pageCount,
    isArchive: true,
  };
}

async function createPdfFromImages(files: File[]) {
  const [firstImage, jsPDF] = await Promise.all([
    loadImageElement(files[0]),
    loadPdfWriter(),
  ]);
  const pdf = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: firstImage.naturalWidth > firstImage.naturalHeight ? "landscape" : "portrait",
    compress: true,
  });

  for (let index = 0; index < files.length; index += 1) {
    const image = index === 0 ? firstImage : await loadImageElement(files[index]);
    const imageScale = Math.min(1, MAX_COMPRESSION_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * imageScale));
    const height = Math.max(1, Math.round(image.naturalHeight * imageScale));
    const orientation = width > height ? "landscape" : "portrait";

    if (index > 0) pdf.addPage("a4", orientation);
    if (index === 0) pdf.setPage(1);

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 36;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持图片转 PDF。");

    canvas.width = width;
    canvas.height = height;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const drawScale = Math.min((pageWidth - margin * 2) / width, (pageHeight - margin * 2) / height);
    const drawWidth = width * drawScale;
    const drawHeight = height * drawScale;
    pdf.addImage(dataUrl, "JPEG", (pageWidth - drawWidth) / 2, (pageHeight - drawHeight) / 2, drawWidth, drawHeight, undefined, "FAST");
    canvas.width = 1;
    canvas.height = 1;
  }

  return pdf.output("blob");
}

// 后端返回标准 SSE 文本流；这里按空行切块并还原 event/data。
async function parseSseStream(
  response: Response,
  onMessage: (message: SseMessage) => void,
  signal: AbortSignal,
) {
  if (!response.body) throw new Error("服务器没有返回可读取的响应流。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emit = (rawEvent: string) => {
    const lines = rawEvent.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      if (field === "data") dataLines.push(value);
    }

    if (dataLines.length || event !== "message") onMessage({ event, data: dataLines.join("\n") });
  };

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        const match = buffer.match(/\r?\n\r?\n/);
        buffer = buffer.slice((match?.index ?? boundary) + (match?.[0].length ?? 2));
        emit(rawEvent);
        boundary = buffer.search(/\r?\n\r?\n/);
      }

      if (done) break;
    }

    if (buffer.trim()) emit(buffer);
  } finally {
    reader.releaseLock();
  }
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [refinementPrompt, setRefinementPrompt] = useState("");
  const [images, setImages] = useState<ImageFile[]>([]);
  const [size, setSize] = useState(DEFAULT_IMAGE_SIZE);
  const [validationMessage, setValidationMessage] = useState("");
  const [refinementMessage, setRefinementMessage] = useState("");
  const [state, setState] = useState<GenerationState>("idle");
  const [status, setStatus] = useState("准备上传参考图并开始生成。");
  const [heartbeatAt, setHeartbeatAt] = useState<string | null>(null);
  const [partialImage, setPartialImage] = useState<string | null>(null);
  const [finalImage, setFinalImage] = useState<string | null>(null);
  const [generationHistory, setGenerationHistory] = useState<GenerationHistoryEntry[]>([]);
  const [historyMessage, setHistoryMessage] = useState("");
  const [resultActionMessage, setResultActionMessage] = useState("");
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [lightboxZoom, setLightboxZoom] = useState(LIGHTBOX_MIN_ZOOM);
  const [lightboxPan, setLightboxPan] = useState({ x: 0, y: 0 });
  const [lightboxRotation, setLightboxRotation] = useState(0);
  const [isLightboxDragging, setIsLightboxDragging] = useState(false);
  const [idPhotoSource, setIdPhotoSource] = useState<TransparentPreview | null>(null);
  const [idPhotoPartial, setIdPhotoPartial] = useState<string | null>(null);
  const [idPhotoOutput, setIdPhotoOutput] = useState<TransparentPreview | null>(null);
  const [idPhotoSpecId, setIdPhotoSpecId] = useState(ID_PHOTO_SPECS[0].id);
  const [idPhotoBackgroundId, setIdPhotoBackgroundId] = useState(ID_PHOTO_BACKGROUNDS[0].id);
  const [idPhotoMessage, setIdPhotoMessage] = useState("");
  const [isIdPhotoProcessing, setIsIdPhotoProcessing] = useState(false);
  const [transparentSource, setTransparentSource] = useState<TransparentPreview | null>(null);
  const [transparentOutput, setTransparentOutput] = useState<TransparentPreview | null>(null);
  const [transparentMessage, setTransparentMessage] = useState("");
  const [isTransparencyProcessing, setIsTransparencyProcessing] = useState(false);
  const [borderTrimSource, setBorderTrimSource] = useState<TransparentPreview | null>(null);
  const [borderTrimOutput, setBorderTrimOutput] = useState<TransparentPreview | null>(null);
  const [borderTrimMessage, setBorderTrimMessage] = useState("");
  const [isBorderTrimming, setIsBorderTrimming] = useState(false);
  const [compressionSource, setCompressionSource] = useState<TransparentPreview | null>(null);
  const [compressionOutput, setCompressionOutput] = useState<TransparentPreview | null>(null);
  const [compressionMessage, setCompressionMessage] = useState("");
  const [compressionTarget, setCompressionTarget] = useState(COMPRESSION_TARGETS[3].value);
  const [isCompressionProcessing, setIsCompressionProcessing] = useState(false);
  const [pdfSource, setPdfSource] = useState<TransparentPreview | null>(null);
  const [pdfImageOutput, setPdfImageOutput] = useState<PdfImageOutput | null>(null);
  const [pdfToImageMessage, setPdfToImageMessage] = useState("");
  const [isPdfConverting, setIsPdfConverting] = useState(false);
  const [pdfImages, setPdfImages] = useState<ImageFile[]>([]);
  const [imagePdfOutput, setImagePdfOutput] = useState<PdfOutput | null>(null);
  const [imageToPdfMessage, setImageToPdfMessage] = useState("");
  const [isImagePdfProcessing, setIsImagePdfProcessing] = useState(false);
  const [generationError, setGenerationError] = useState<GenerationError | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const imagesRef = useRef<ImageFile[]>([]);
  const pdfImagesRef = useRef<ImageFile[]>([]);
  const idPhotoFileRef = useRef<File | null>(null);
  const idPhotoAbortRef = useRef<AbortController | null>(null);
  const idPhotoSourceUrlRef = useRef<string | null>(null);
  const idPhotoOutputUrlRef = useRef<string | null>(null);
  const transparentSourceUrlRef = useRef<string | null>(null);
  const transparentOutputUrlRef = useRef<string | null>(null);
  const borderTrimSourceUrlRef = useRef<string | null>(null);
  const borderTrimOutputUrlRef = useRef<string | null>(null);
  const compressionFileRef = useRef<File | null>(null);
  const compressionSourceUrlRef = useRef<string | null>(null);
  const compressionOutputUrlRef = useRef<string | null>(null);
  const pdfSourceUrlRef = useRef<string | null>(null);
  const pdfImagePreviewUrlRef = useRef<string | null>(null);
  const pdfImageDownloadUrlRef = useRef<string | null>(null);
  const imagePdfOutputUrlRef = useRef<string | null>(null);
  const historyRequestRef = useRef({ prompt: "", size: DEFAULT_IMAGE_SIZE, hasStoredImage: false });
  const lightboxPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const lightboxPinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const lightboxPanRef = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const lightboxZoomValueRef = useRef(LIGHTBOX_MIN_ZOOM);
  const lightboxPanValueRef = useRef({ x: 0, y: 0 });
  const lightboxRotationValueRef = useRef(0);

  const updateLightboxPan = (pan: { x: number; y: number }) => {
    lightboxPanValueRef.current = pan;
    setLightboxPan(pan);
  };

  const updateLightboxZoom = (zoom: number) => {
    const nextZoom = clampLightboxZoom(zoom);
    lightboxZoomValueRef.current = nextZoom;
    setLightboxZoom(nextZoom);

    if (nextZoom === LIGHTBOX_MIN_ZOOM) updateLightboxPan({ x: 0, y: 0 });
  };

  const updateLightboxRotation = (rotation: number) => {
    const nextRotation = normalizeLightboxRotation(rotation);
    lightboxRotationValueRef.current = nextRotation;
    setLightboxRotation(nextRotation);
  };

  const resetLightboxTransform = () => {
    updateLightboxZoom(LIGHTBOX_MIN_ZOOM);
    updateLightboxPan({ x: 0, y: 0 });
    updateLightboxRotation(0);
  };

  useEffect(() => {
    if (state !== "generating") return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    if (state !== "generating") return undefined;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [state]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    pdfImagesRef.current = pdfImages;
  }, [pdfImages]);

  useEffect(() => {
    let isMounted = true;

    void getGenerationHistory()
      .then((entries) => {
        if (isMounted) setGenerationHistory(entries);
      })
      .catch(() => {
        if (isMounted) setHistoryMessage("本地生成历史暂时不可用。");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!lightboxImage) return undefined;

    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightboxImage(null);
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        updateLightboxZoom(lightboxZoomValueRef.current + LIGHTBOX_ZOOM_STEP);
      }

      if (event.key === "-") {
        event.preventDefault();
        updateLightboxZoom(lightboxZoomValueRef.current - LIGHTBOX_ZOOM_STEP);
      }

      if (event.key === "0") {
        event.preventDefault();
        resetLightboxTransform();
      }

      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        updateLightboxRotation(lightboxRotationValueRef.current + 90);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lightboxImage]);

  useEffect(() => {
    resetLightboxTransform();
    lightboxPointersRef.current.clear();
    lightboxPinchRef.current = null;
    lightboxPanRef.current = null;
    setIsLightboxDragging(false);
  }, [lightboxImage?.src]);

  useEffect(() => {
    if (lightboxZoom === LIGHTBOX_MIN_ZOOM) {
      updateLightboxPan({ x: 0, y: 0 });
    }
  }, [lightboxZoom]);

  useEffect(() => {
    if (finalImage) return;
    setLightboxImage((current) => (current?.alt === "最终生成结果" ? null : current));
  }, [finalImage]);

  useEffect(() => {
    setLightboxImage((current) => {
      if (!current || current.alt === "最终生成结果") return current;
      return images.some((image) => image.previewUrl === current.src) ? current : null;
    });
  }, [images]);

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      if (idPhotoSourceUrlRef.current) URL.revokeObjectURL(idPhotoSourceUrlRef.current);
      if (idPhotoOutputUrlRef.current) URL.revokeObjectURL(idPhotoOutputUrlRef.current);
      if (transparentSourceUrlRef.current) URL.revokeObjectURL(transparentSourceUrlRef.current);
      if (transparentOutputUrlRef.current) URL.revokeObjectURL(transparentOutputUrlRef.current);
      if (borderTrimSourceUrlRef.current) URL.revokeObjectURL(borderTrimSourceUrlRef.current);
      if (borderTrimOutputUrlRef.current) URL.revokeObjectURL(borderTrimOutputUrlRef.current);
      if (compressionSourceUrlRef.current) URL.revokeObjectURL(compressionSourceUrlRef.current);
      if (compressionOutputUrlRef.current) URL.revokeObjectURL(compressionOutputUrlRef.current);
      if (pdfSourceUrlRef.current) URL.revokeObjectURL(pdfSourceUrlRef.current);
      if (pdfImagePreviewUrlRef.current) URL.revokeObjectURL(pdfImagePreviewUrlRef.current);
      if (pdfImageDownloadUrlRef.current && pdfImageDownloadUrlRef.current !== pdfImagePreviewUrlRef.current) URL.revokeObjectURL(pdfImageDownloadUrlRef.current);
      if (imagePdfOutputUrlRef.current) URL.revokeObjectURL(imagePdfOutputUrlRef.current);
      pdfImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      abortRef.current?.abort();
      idPhotoAbortRef.current?.abort();
    };
  }, []);

  // 上传和粘贴最终都走这里，保证数量、格式、单图大小和总大小限制一致。
  const addImageFiles = (files: File[], source: "upload" | "paste") => {
    if (state === "generating") return;
    if (!files.length) return;

    const nextImages: ImageFile[] = [];
    const messages: string[] = [];
    let nextCount = images.length;
    let nextTotalSize = images.reduce((total, image) => total + image.file.size, 0);

    files.forEach((file) => {
      if (!ALLOWED_TYPES.has(file.type)) {
        messages.push(`${file.name} 不是支持的 png/jpeg/webp 格式。`);
        return;
      }
      if (file.size > MAX_REFERENCE_FILE_SIZE) {
        messages.push(`${file.name} 超过 20MB。`);
        return;
      }
      if (nextCount >= MAX_REFERENCE_IMAGES) {
        messages.push(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图。`);
        return;
      }
      if (nextTotalSize + file.size > MAX_REFERENCE_TOTAL_SIZE) {
        messages.push("参考图合计不能超过 40MB。");
        return;
      }

      nextImages.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl: URL.createObjectURL(file),
      });
      nextCount += 1;
      nextTotalSize += file.size;
    });

    setImages((current) => [...current, ...nextImages]);
    const successMessage = source === "paste" && nextImages.length > 0 ? `已从粘贴内容添加 ${nextImages.length} 张参考图。` : "";
    setValidationMessage([successMessage, ...new Set(messages)].filter(Boolean).join(" "));
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    addImageFiles(selected, "upload");
  };

  const handlePromptPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (state === "generating") return;
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (!pastedImages.length) return;

    event.preventDefault();
    addImageFiles(pastedImages, "paste");
  };

  const removeImage = (id: string) => {
    if (state === "generating") return;
    setImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const handleIdPhotoFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;

    if (!ALLOWED_TYPES.has(file.type)) {
      setIdPhotoMessage(`${file.name} 不是支持的 PNG、JPG 或 WebP 图片。`);
      return;
    }

    if (file.size > MAX_REFERENCE_FILE_SIZE) {
      setIdPhotoMessage(`${file.name} 超过 20MB，无法上传到证件照编辑服务。`);
      return;
    }

    const sourceUrl = URL.createObjectURL(file);
    if (idPhotoSourceUrlRef.current) URL.revokeObjectURL(idPhotoSourceUrlRef.current);
    if (idPhotoOutputUrlRef.current) URL.revokeObjectURL(idPhotoOutputUrlRef.current);
    idPhotoFileRef.current = file;
    idPhotoSourceUrlRef.current = sourceUrl;
    idPhotoOutputUrlRef.current = null;
    setIdPhotoSource({ name: file.name, previewUrl: sourceUrl, size: file.size });
    setIdPhotoPartial(null);
    setIdPhotoOutput(null);
    setIdPhotoMessage("已载入原图。选择规格和底色后生成证件照。");
  };

  const createIdPhoto = async () => {
    const sourceFile = idPhotoFileRef.current;
    const spec = ID_PHOTO_SPECS.find((item) => item.id === idPhotoSpecId) ?? ID_PHOTO_SPECS[0];
    const background = ID_PHOTO_BACKGROUNDS.find((item) => item.id === idPhotoBackgroundId) ?? ID_PHOTO_BACKGROUNDS[0];
    if (!sourceFile || isIdPhotoProcessing) return;

    idPhotoAbortRef.current?.abort();
    const controller = new AbortController();
    idPhotoAbortRef.current = controller;
    setIsIdPhotoProcessing(true);
    setIdPhotoPartial(null);
    setIdPhotoOutput(null);
    setIdPhotoMessage("正在上传原图并生成证件照…");

    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        body: createImageFormData(createIdPhotoPrompt(spec, background), "auto", [sourceFile]),
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const message = await response.text();
        throw new Error(message || `证件照请求失败：HTTP ${response.status}`);
      }

      let generatedImage: string | null = null;
      let streamError: GenerationError | null = null;
      await parseSseStream(
        response,
        (message) => {
          const payload = extractPayload(message.data);
          if (message.event === "status" || message.event === "heartbeat") {
            setIdPhotoMessage(getTextFromPayload(payload, ["status", "message", "detail"]) || "正在生成证件照…");
            return;
          }
          if (message.event === "partial_image") {
            const image = getImageFromPayload(payload);
            if (image) setIdPhotoPartial(image);
            setIdPhotoMessage("已收到阶段性预览，正在生成最终证件照…");
            return;
          }
          if (message.event === "final_image" || message.event === "done") {
            const image = getImageFromPayload(payload);
            if (image) generatedImage = image;
            return;
          }
          if (message.event === "error") streamError = getGenerationErrorFromPayload(payload);
        },
        controller.signal,
      );

      if (streamError) throw new Error(streamError.detail || streamError.message);
      if (!generatedImage) throw new Error("图片服务未返回证件照结果。");

      const outputBlob = await createStandardIdPhotoBlob(generatedImage, spec);
      const outputUrl = URL.createObjectURL(outputBlob);
      if (idPhotoOutputUrlRef.current) URL.revokeObjectURL(idPhotoOutputUrlRef.current);
      idPhotoOutputUrlRef.current = outputUrl;
      setIdPhotoPartial(null);
      setIdPhotoOutput({
        name: createIdPhotoFileName(sourceFile.name, spec, background),
        previewUrl: outputUrl,
        size: outputBlob.size,
      });
      setIdPhotoMessage(`已生成 ${spec.label} ${background.label}证件照，并标准化为 ${spec.width} x ${spec.height}px PNG。`);
    } catch (error) {
      if (controller.signal.aborted) {
        setIdPhotoMessage("已取消证件照生成。");
      } else {
        setIdPhotoMessage(error instanceof Error ? error.message : "证件照生成失败。请更换正面清晰的原图后重试。");
      }
    } finally {
      if (idPhotoAbortRef.current === controller) idPhotoAbortRef.current = null;
      setIsIdPhotoProcessing(false);
    }
  };

  const convertTransparentImage = async (file: File) => {
    setIsTransparencyProcessing(true);
    setTransparentMessage("正在本地生成透明 PNG…");

    try {
      const outputBlob = await createTransparentPngBlob(file);
      const outputUrl = URL.createObjectURL(outputBlob);

      if (transparentOutputUrlRef.current) URL.revokeObjectURL(transparentOutputUrlRef.current);
      transparentOutputUrlRef.current = outputUrl;
      setTransparentOutput({
        name: createTransparentFileName(file.name),
        previewUrl: outputUrl,
        size: outputBlob.size,
      });
      setTransparentMessage("已生成透明 PNG，可以预览或下载。");
    } catch (error) {
      if (transparentOutputUrlRef.current) URL.revokeObjectURL(transparentOutputUrlRef.current);
      transparentOutputUrlRef.current = null;
      setTransparentOutput(null);
      setTransparentMessage(error instanceof Error ? error.message : "透明 PNG 生成失败。");
    } finally {
      setIsTransparencyProcessing(false);
    }
  };

  const handleTransparentFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file) return;

    if (!ALLOWED_TYPES.has(file.type)) {
      setTransparentMessage(`${file.name} 不是支持的 png/jpeg/webp 格式。`);
      return;
    }

    if (file.size > MAX_TRANSPARENT_FILE_SIZE) {
      setTransparentMessage(`${file.name} 超过 10MB。`);
      return;
    }

    const sourceUrl = URL.createObjectURL(file);

    if (transparentSourceUrlRef.current) URL.revokeObjectURL(transparentSourceUrlRef.current);
    if (transparentOutputUrlRef.current) URL.revokeObjectURL(transparentOutputUrlRef.current);
    transparentSourceUrlRef.current = sourceUrl;
    transparentOutputUrlRef.current = null;
    setTransparentSource({
      name: file.name,
      previewUrl: sourceUrl,
      size: file.size,
    });
    setTransparentOutput(null);
    void convertTransparentImage(file);
  };

  const trimImageBorder = async (file: File) => {
    setIsBorderTrimming(true);
    setBorderTrimMessage("正在本地识别白色边框…");

    try {
      const { blob, wasTrimmed } = await createBorderlessImageBlob(file);
      const outputUrl = URL.createObjectURL(blob);

      if (borderTrimOutputUrlRef.current) URL.revokeObjectURL(borderTrimOutputUrlRef.current);
      borderTrimOutputUrlRef.current = outputUrl;
      setBorderTrimOutput({
        name: createBorderlessFileName(file.name, blob.type || getCompressionMimeType(file)),
        previewUrl: outputUrl,
        size: blob.size,
      });
      setBorderTrimMessage(wasTrimmed ? "已去除检测到的白色边框、页眉或页脚，可以预览或下载。" : "未检测到明显外框，已保留原始画面。");
    } catch (error) {
      if (borderTrimOutputUrlRef.current) URL.revokeObjectURL(borderTrimOutputUrlRef.current);
      borderTrimOutputUrlRef.current = null;
      setBorderTrimOutput(null);
      setBorderTrimMessage(error instanceof Error ? error.message : "图片去边框失败。");
    } finally {
      setIsBorderTrimming(false);
    }
  };

  const loadBorderTrimFile = (file: File) => {
    if (!ALLOWED_TYPES.has(file.type)) {
      setBorderTrimMessage(`${file.name} 不是支持的 png/jpeg/webp 格式。`);
      return false;
    }

    if (file.size > MAX_TOOL_FILE_SIZE) {
      setBorderTrimMessage(`${file.name} 超过 ${formatBytes(MAX_TOOL_FILE_SIZE)}。`);
      return false;
    }

    const sourceUrl = URL.createObjectURL(file);
    if (borderTrimSourceUrlRef.current) URL.revokeObjectURL(borderTrimSourceUrlRef.current);
    if (borderTrimOutputUrlRef.current) URL.revokeObjectURL(borderTrimOutputUrlRef.current);
    borderTrimSourceUrlRef.current = sourceUrl;
    borderTrimOutputUrlRef.current = null;
    setBorderTrimSource({ name: file.name, previewUrl: sourceUrl, size: file.size });
    setBorderTrimOutput(null);
    void trimImageBorder(file);
    return true;
  };

  const handleBorderTrimFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file) loadBorderTrimFile(file);
  };

  const compressImage = async (file: File, targetBytes: number) => {
    setIsCompressionProcessing(true);
    setCompressionMessage(`正在本地压缩到 ${formatBytes(targetBytes)} 以内…`);

    try {
      const { blob, reachedTarget } = await createCompressedImageBlob(file, targetBytes);
      const outputUrl = URL.createObjectURL(blob);

      if (compressionOutputUrlRef.current) URL.revokeObjectURL(compressionOutputUrlRef.current);
      compressionOutputUrlRef.current = outputUrl;
      setCompressionOutput({
        name: createCompressedFileName(file.name, blob.type || getCompressionMimeType(file)),
        previewUrl: outputUrl,
        size: blob.size,
      });
      setCompressionMessage(
        reachedTarget
          ? `已压缩至 ${formatBytes(blob.size)}，可以预览或下载。`
          : `已尽量压缩至 ${formatBytes(blob.size)}，仍未达到 ${formatBytes(targetBytes)}。`,
      );
    } catch (error) {
      if (compressionOutputUrlRef.current) URL.revokeObjectURL(compressionOutputUrlRef.current);
      compressionOutputUrlRef.current = null;
      setCompressionOutput(null);
      setCompressionMessage(error instanceof Error ? error.message : "图片压缩失败。");
    } finally {
      setIsCompressionProcessing(false);
    }
  };

  const handleCompressionFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file) return;

    if (!ALLOWED_TYPES.has(file.type)) {
      setCompressionMessage(`${file.name} 不是支持的 png/jpeg/webp 格式。`);
      return;
    }

    if (file.size > MAX_TOOL_FILE_SIZE) {
      setCompressionMessage(`${file.name} 超过 ${formatBytes(MAX_TOOL_FILE_SIZE)}。`);
      return;
    }

    const sourceUrl = URL.createObjectURL(file);
    if (compressionSourceUrlRef.current) URL.revokeObjectURL(compressionSourceUrlRef.current);
    if (compressionOutputUrlRef.current) URL.revokeObjectURL(compressionOutputUrlRef.current);

    compressionFileRef.current = file;
    compressionSourceUrlRef.current = sourceUrl;
    compressionOutputUrlRef.current = null;
    setCompressionSource({ name: file.name, previewUrl: sourceUrl, size: file.size });
    setCompressionOutput(null);
    void compressImage(file, compressionTarget);
  };

  const handleCompressionTargetChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const targetBytes = Number(event.target.value);
    setCompressionTarget(targetBytes);
    if (compressionFileRef.current) void compressImage(compressionFileRef.current, targetBytes);
  };

  const convertPdfToImages = async (file: File) => {
    setIsPdfConverting(true);
    setPdfToImageMessage("正在读取 PDF 页面…");

    try {
      const output = await createPdfImageOutput(file, (pageNumber, pageCount) => {
        setPdfToImageMessage(`正在转换第 ${pageNumber}/${pageCount} 页…`);
      });
      pdfImagePreviewUrlRef.current = output.previewUrl;
      pdfImageDownloadUrlRef.current = output.downloadUrl;
      setPdfImageOutput(output);
      setPdfToImageMessage(output.isArchive ? `已转换 ${output.pageCount} 页，已打包为 ZIP。` : "已转换为 PNG，可以预览或下载。");
    } catch (error) {
      setPdfImageOutput(null);
      setPdfToImageMessage(error instanceof Error ? error.message : "PDF 转图片失败。");
    } finally {
      setIsPdfConverting(false);
    }
  };

  const handlePdfFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;

    if (!isPdfFile(file)) {
      setPdfToImageMessage(`${file.name} 不是 PDF 文件。`);
      return;
    }
    if (file.size > MAX_TOOL_FILE_SIZE) {
      setPdfToImageMessage(`${file.name} 超过 ${formatBytes(MAX_TOOL_FILE_SIZE)}。`);
      return;
    }

    if (pdfSourceUrlRef.current) URL.revokeObjectURL(pdfSourceUrlRef.current);
    if (pdfImagePreviewUrlRef.current) URL.revokeObjectURL(pdfImagePreviewUrlRef.current);
    if (pdfImageDownloadUrlRef.current && pdfImageDownloadUrlRef.current !== pdfImagePreviewUrlRef.current) URL.revokeObjectURL(pdfImageDownloadUrlRef.current);
    pdfSourceUrlRef.current = URL.createObjectURL(file);
    pdfImagePreviewUrlRef.current = null;
    pdfImageDownloadUrlRef.current = null;
    setPdfSource({ name: file.name, previewUrl: pdfSourceUrlRef.current, size: file.size });
    setPdfImageOutput(null);
    void convertPdfToImages(file);
  };

  const addPdfImageFiles = (files: File[]) => {
    const accepted: ImageFile[] = [];
    const messages: string[] = [];

    files.forEach((file) => {
      if (!ALLOWED_TYPES.has(file.type)) {
        messages.push(`${file.name} 不是支持的 png/jpeg/webp 格式。`);
        return;
      }
      if (file.size > MAX_TOOL_FILE_SIZE) {
        messages.push(`${file.name} 超过 ${formatBytes(MAX_TOOL_FILE_SIZE)}。`);
        return;
      }
      accepted.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl: URL.createObjectURL(file),
      });
    });

    setPdfImages((current) => [...current, ...accepted]);
    setImageToPdfMessage(messages.join(" "));
  };

  const handlePdfImages = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    addPdfImageFiles(files);
  };

  const removePdfImage = (id: string) => {
    setPdfImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const convertImagesToPdf = async () => {
    if (!pdfImages.length) return;

    setIsImagePdfProcessing(true);
    setImageToPdfMessage(`正在生成包含 ${pdfImages.length} 页的 PDF…`);
    try {
      const outputBlob = await createPdfFromImages(pdfImages.map((image) => image.file));
      const outputUrl = URL.createObjectURL(outputBlob);
      if (imagePdfOutputUrlRef.current) URL.revokeObjectURL(imagePdfOutputUrlRef.current);
      imagePdfOutputUrlRef.current = outputUrl;
      setImagePdfOutput({
        name: createImagesPdfFileName(pdfImages.map((image) => image.file)),
        downloadUrl: outputUrl,
        size: outputBlob.size,
        pageCount: pdfImages.length,
      });
      setImageToPdfMessage("PDF 已生成，可以下载。");
    } catch (error) {
      setImagePdfOutput(null);
      setImageToPdfMessage(error instanceof Error ? error.message : "图片转 PDF 失败。");
    } finally {
      setIsImagePdfProcessing(false);
    }
  };

  const recordFinalImage = (image: string) => {
    if (historyRequestRef.current.hasStoredImage) return;

    historyRequestRef.current.hasStoredImage = true;
    const entry: GenerationHistoryEntry = {
      id: crypto.randomUUID(),
      image,
      prompt: historyRequestRef.current.prompt,
      size: historyRequestRef.current.size,
      createdAt: Date.now(),
    };

    void saveGenerationHistory(entry)
      .then(() => {
        setGenerationHistory((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, MAX_HISTORY_ITEMS));
      })
      .catch(() => {
        setHistoryMessage("结果已生成，但未能保存到本地历史。");
      });
  };

  const restoreHistoryEntry = (entry: GenerationHistoryEntry) => {
    setPrompt(entry.prompt);
    setSize(entry.size);
    setPartialImage(null);
    setFinalImage(entry.image);
    setState("success");
    setGenerationError(null);
    setRefinementMessage("");
    setStatus("已从本地历史恢复结果，可以继续追加生成或使用图片工具。");
    setHistoryMessage(`已恢复 ${formatHistoryTime(entry.createdAt)} 的结果。`);
  };

  const removeHistoryEntry = async (id: string) => {
    try {
      await deleteGenerationHistory(id);
      setGenerationHistory((current) => current.filter((item) => item.id !== id));
      setHistoryMessage("已从本地历史删除该结果。");
    } catch (error) {
      setHistoryMessage(error instanceof Error ? error.message : "删除本地历史失败。");
    }
  };

  const removeAllHistory = async () => {
    try {
      await clearGenerationHistory();
      setGenerationHistory([]);
      setHistoryMessage("本地生成历史已清空。");
    } catch (error) {
      setHistoryMessage(error instanceof Error ? error.message : "清空本地历史失败。");
    }
  };

  const downloadFinalImage = () => {
    if (!finalImage) return;

    const link = document.createElement("a");
    link.href = finalImage;
    link.download = getFinalImageFileName();
    link.click();
    setResultActionMessage("已开始下载最终图片。");
  };

  const copyFinalImage = async () => {
    if (!finalImage) return;

    try {
      const response = await fetch(finalImage);
      if (!response.ok) throw new Error("无法读取最终图片。");
      const image = await response.blob();

      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ [image.type || "image/png"]: image })]);
        setResultActionMessage("最终图片已复制到剪贴板。");
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(finalImage);
        setResultActionMessage("当前浏览器不支持复制图片，已复制图片链接。");
        return;
      }

      throw new Error("当前浏览器不支持剪贴板操作，请改用下载。");
    } catch (error) {
      setResultActionMessage(error instanceof Error ? error.message : "复制图片失败，请改用下载。");
    }
  };

  const sendFinalImageToTool = async (tool: "transparent" | "border" | "compress" | "pdf") => {
    if (!finalImage) return;

    try {
      const file = await createImageFileFromSource(finalImage);

      if (tool === "transparent") {
        const sourceUrl = URL.createObjectURL(file);
        if (transparentSourceUrlRef.current) URL.revokeObjectURL(transparentSourceUrlRef.current);
        if (transparentOutputUrlRef.current) URL.revokeObjectURL(transparentOutputUrlRef.current);
        transparentSourceUrlRef.current = sourceUrl;
        transparentOutputUrlRef.current = null;
        setTransparentSource({ name: file.name, previewUrl: sourceUrl, size: file.size });
        setTransparentOutput(null);
        setTransparentMessage("已载入当前最终图，正在本地生成透明 PNG…");
        navigate("/tools");
        void convertTransparentImage(file);
      }

      if (tool === "border") {
        if (loadBorderTrimFile(file)) {
          navigate("/tools");
        }
      }

      if (tool === "compress") {
        const sourceUrl = URL.createObjectURL(file);
        if (compressionSourceUrlRef.current) URL.revokeObjectURL(compressionSourceUrlRef.current);
        if (compressionOutputUrlRef.current) URL.revokeObjectURL(compressionOutputUrlRef.current);
        compressionFileRef.current = file;
        compressionSourceUrlRef.current = sourceUrl;
        compressionOutputUrlRef.current = null;
        setCompressionSource({ name: file.name, previewUrl: sourceUrl, size: file.size });
        setCompressionOutput(null);
        setCompressionMessage(`已载入当前最终图，正在本地压缩到 ${formatBytes(compressionTarget)} 以内…`);
        navigate("/tools");
        void compressImage(file, compressionTarget);
      }

      if (tool === "pdf") {
        const previewUrl = URL.createObjectURL(file);
        const image: ImageFile = {
          id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
          file,
          previewUrl,
        };
        if (imagePdfOutputUrlRef.current) URL.revokeObjectURL(imagePdfOutputUrlRef.current);
        imagePdfOutputUrlRef.current = null;
        setImagePdfOutput(null);
        setPdfImages((current) => [...current, image]);
        setImageToPdfMessage("已将当前最终图加入图片转 PDF 队列。");
        navigate("/tools");
      }

      setResultActionMessage("已将最终图片送入本地工具。");
    } catch (error) {
      setResultActionMessage(error instanceof Error ? error.message : "无法将最终图片送入工具。");
    }
  };

  // 后端只暴露少量事件，前端在这里集中更新状态和图片预览。
  const handleSseMessage = (message: SseMessage): SseMessageResult => {
    const payload = extractPayload(message.data);

    if (message.event === "status") {
      setStatus(getTextFromPayload(payload, ["status", "message", "detail"]) || "图片生成状态已更新。");
      return {};
    }

    if (message.event === "heartbeat") {
      setHeartbeatAt(new Date().toLocaleTimeString());
      setStatus((current) => current || "任务仍在运行，正在等待模型返回结果。");
      return {};
    }

    if (message.event === "partial_image") {
      const image = getImageFromPayload(payload);
      if (image) setPartialImage(image);
      setStatus("已收到阶段性预览，继续等待最终图片。");
      return {};
    }

    if (message.event === "final_image") {
      const image = getImageFromPayload(payload);
      if (image) {
        setFinalImage(image);
        recordFinalImage(image);
      }
      setStatus("最终图片已返回。正在完成任务…");
      return { successfulImage: Boolean(image) };
    }

    if (message.event === "done") {
      const image = getImageFromPayload(payload);
      if (image) {
        setFinalImage(image);
        recordFinalImage(image);
      }
      setStatus("生成完成，可以保存结果或再次尝试。");
      setState("success");
      return { successfulImage: Boolean(image) };
    }

    if (message.event === "error") {
      const nextError = getGenerationErrorFromPayload(payload);
      setGenerationError(nextError);
      setStatus(nextError.retryable ? "图片服务暂时繁忙，请稍后重试。" : "生成失败，请检查输入后重试。");
      setState("error");
      return { generationError: nextError };
    }

    return {};
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState("cancelled");
    setStatus("已取消当前请求。你可以修改提示词或图片后重新开始。");
  };

  const runImageRequest = async (formData: FormData, initialStatus: string, historyPrompt: string) => {
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setState("generating");
    setElapsed(0);
    setGenerationError(null);
    setPartialImage(null);
    setFinalImage(null);
    setHeartbeatAt(null);
    setLightboxImage(null);
    setRefinementMessage("");
    setResultActionMessage("");
    setStatus(initialStatus);
    historyRequestRef.current = { prompt: historyPrompt, size, hasStoredImage: false };

    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        let sawSuccessfulFinalOrDoneImage = false;
        let bestSseError: GenerationError | null = null;

        await parseSseStream(
          response,
          (message) => {
            const result = handleSseMessage(message);
            if (result.successfulImage) sawSuccessfulFinalOrDoneImage = true;
            if (result.generationError) bestSseError = result.generationError;
          },
          controller.signal,
        );

        if (!sawSuccessfulFinalOrDoneImage) {
          if (bestSseError) return false;
          throw new Error("图片生成流连接失败");
        }

        setState((current) => (current === "generating" ? "success" : current));
        setStatus((current) => current || "响应流已结束。");
        return true;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `请求失败：HTTP ${response.status}`);
      }

      setState("success");
      setStatus("请求完成，但服务器没有返回 SSE 图片事件。");
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        setState("cancelled");
        setStatus("已取消当前请求。你可以随时重新生成。");
        return false;
      }
      const message = error instanceof Error ? error.message : "未知错误";
      setState("error");
      setStatus("生成失败，请检查输入或稍后重试。");
      setGenerationError({ message });
      return false;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  // 只调用流式接口；生成/编辑由是否上传参考图自动决定。
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = createImageFormData(prompt, size, images.map((image) => image.file));
    await runImageRequest(formData, "正在上传 multipart/form-data 到 /api/generate-image-stream…", prompt);
  };

  const refineGeneratedImage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (state === "generating") return;

    const nextPrompt = refinementPrompt.trim();
    if (!nextPrompt) {
      setRefinementMessage("请输入追加提示词。");
      return;
    }

    if (!finalImage) {
      setRefinementMessage("请先生成最终图片。");
      return;
    }

    try {
      const generatedImageFile = await createImageFileFromSource(finalImage);
      const refinementRequest = createRefinementPrompt(nextPrompt);
      const formData = createImageFormData(refinementRequest, size, [generatedImageFile]);
      const isSuccessful = await runImageRequest(formData, "正在基于当前最终图追加生成…", refinementRequest);

      if (isSuccessful) {
        setRefinementPrompt("");
        setRefinementMessage("已根据追加提示词生成新图片。");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "追加生成失败";
      setState("error");
      setGenerationError({ message });
      setRefinementMessage(message);
      setStatus("追加生成失败，请稍后重试。");
    }
  };

  const isGenerating = state === "generating";
  const canSubmit = Boolean(prompt.trim()) && prompt.length <= MAX_PROMPT_LENGTH && !isGenerating;
  const visibleResult = finalImage ?? partialImage;
  const canRefine = Boolean(finalImage && refinementPrompt.trim()) && refinementPrompt.length <= MAX_REFINEMENT_PROMPT_LENGTH && !isGenerating;
  const isToolsPage = location.pathname === "/tools";
  const adjustLightboxZoom = (amount: number) => {
    updateLightboxZoom(lightboxZoomValueRef.current + amount);
  };
  const getPointerDistance = (pointers: { x: number; y: number }[]) => {
    const [first, second] = pointers;
    return Math.hypot(second.x - first.x, second.y - first.y);
  };
  const handleLightboxPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    lightboxPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pointers = [...lightboxPointersRef.current.values()];

    if (pointers.length === 2) {
      lightboxPanRef.current = null;
      lightboxPinchRef.current = { distance: getPointerDistance(pointers), zoom: lightboxZoomValueRef.current };
      setIsLightboxDragging(true);
      return;
    }

    if (pointers.length === 1 && lightboxZoomValueRef.current > LIGHTBOX_MIN_ZOOM) {
      lightboxPanRef.current = { x: event.clientX, y: event.clientY, pan: lightboxPanValueRef.current };
      setIsLightboxDragging(true);
    }
  };
  const handleLightboxPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!lightboxPointersRef.current.has(event.pointerId)) return;
    lightboxPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pointers = [...lightboxPointersRef.current.values()];

    if (pointers.length === 2 && lightboxPinchRef.current) {
      event.preventDefault();
      const distance = getPointerDistance(pointers);
      updateLightboxZoom(lightboxPinchRef.current.zoom * (distance / lightboxPinchRef.current.distance));
      return;
    }

    if (pointers.length !== 1 || !lightboxPanRef.current) return;
    event.preventDefault();
    updateLightboxPan({
      x: lightboxPanRef.current.pan.x + event.clientX - lightboxPanRef.current.x,
      y: lightboxPanRef.current.pan.y + event.clientY - lightboxPanRef.current.y,
    });
  };
  const handleLightboxPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    lightboxPointersRef.current.delete(event.pointerId);
    const pointers = [...lightboxPointersRef.current.values()];
    lightboxPinchRef.current = null;

    if (pointers.length === 1 && lightboxZoomValueRef.current > LIGHTBOX_MIN_ZOOM) {
      const [pointer] = pointers;
      lightboxPanRef.current = { x: pointer.x, y: pointer.y, pan: lightboxPanValueRef.current };
      return;
    }

    lightboxPanRef.current = null;
    setIsLightboxDragging(false);
  };
  const handleLightboxWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    adjustLightboxZoom(event.deltaY < 0 ? LIGHTBOX_ZOOM_STEP : -LIGHTBOX_ZOOM_STEP);
  };

  return (
    <main className={`app-shell ${isToolsPage ? "page-tools" : "page-generator"}`}>
      <header className="app-topbar">
        <NavLink className="app-brand" to="/generator" aria-label="前往图片生成">
          <span className="app-brand-mark" aria-hidden="true" />
          <strong>AI Image Studio</strong>
        </NavLink>
        <nav className="app-nav" aria-label="主导航">
          <NavLink className={({ isActive }) => `app-nav-link ${isActive || location.pathname === "/" ? "is-active" : ""}`} to="/generator">
            图片生成
          </NavLink>
          <NavLink className={({ isActive }) => `app-nav-link ${isActive ? "is-active" : ""}`} to="/tools">
            图片工具
          </NavLink>
        </nav>
      </header>
      <div className="workspace">
        <div className="left-stack">
          <form className="panel config-panel" onSubmit={submit}>
            <div className="panel-heading">
              <span>01</span>
              <div>
                <h2>配置输入</h2>
                <p>最多 4 张参考图，每张 20MB，合计不超过 40MB。</p>
              </div>
            </div>

            <label className="field-label" htmlFor="prompt">
              生成提示词
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={handlePromptPaste}
              placeholder="描述画面、风格、材质、构图或任何限制条件…"
              rows={6}
              required
              maxLength={MAX_PROMPT_LENGTH}
              disabled={isGenerating}
            />

            <label className="field-label size-label" htmlFor="size">
              输出尺寸
            </label>
            <select id="size" value={size} onChange={(event) => setSize(event.target.value)} disabled={isGenerating}>
              {IMAGE_SIZE_OPTIONS.map((option) => (
                <option value={option} key={option}>
                  {option}
                </option>
              ))}
            </select>

            <label className={`upload-zone ${isGenerating ? "is-disabled" : ""}`} htmlFor="images">
              <input id="images" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={handleFiles} disabled={isGenerating} />
              <span>可选：上传或粘贴参考图</span>
              <strong>不上传直接生成 · 最多 4 张 / 单张 20MB / 合计 40MB</strong>
            </label>
            {validationMessage && <p className="validation-message" aria-live="polite">{validationMessage}</p>}

            <div className="preview-grid">
              {images.map((image) => (
                <article className="preview-card" key={image.id}>
                  <button
                    className="preview-open-button"
                    type="button"
                    onClick={() => setLightboxImage({ src: image.previewUrl, alt: image.file.name })}
                    aria-label={`放大查看 ${image.file.name}`}
                  >
                    <img src={image.previewUrl} alt={`${image.file.name} preview`} />
                  </button>
                  <div>
                    <strong title={image.file.name}>{image.file.name}</strong>
                    <span>{formatBytes(image.file.size)}</span>
                  </div>
                  <button className="remove-image-button" type="button" onClick={() => removeImage(image.id)} aria-label={`移除 ${image.file.name}`} disabled={isGenerating}>
                    移除
                  </button>
                </article>
              ))}
            </div>

            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={!canSubmit}>
                {state === "generating" ? "生成中…" : "开始生成"}
              </button>
              {state === "generating" && (
                <button className="secondary-button" type="button" onClick={cancelGeneration}>
                  取消请求
                </button>
              )}
            </div>
          </form>

          <div className="toolkit" aria-label="本地图片与 PDF 工具">
          <section className="panel id-photo-panel">
            <div className="panel-heading">
              <span>03</span>
              <div>
                <h2>证件照制作</h2>
                <p>保留人物与服装，自动换底并导出标准像素尺寸。</p>
              </div>
            </div>

            <label className={`upload-zone ${isIdPhotoProcessing ? "is-disabled" : ""}`} htmlFor="id-photo-image">
              <input id="id-photo-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleIdPhotoFile} disabled={isIdPhotoProcessing} />
              <span>选择正面清晰的人像</span>
              <strong>支持 PNG、JPG、WebP，单张不超过 20MB。</strong>
            </label>

            <div className="id-photo-options">
              <label className="field-label" htmlFor="id-photo-spec">照片规格</label>
              <select id="id-photo-spec" value={idPhotoSpecId} onChange={(event) => setIdPhotoSpecId(event.target.value)} disabled={isIdPhotoProcessing}>
                {ID_PHOTO_SPECS.map((spec) => (
                  <option key={spec.id} value={spec.id}>{spec.label} · {spec.width} x {spec.height}px · {spec.millimeters}</option>
                ))}
              </select>

              <fieldset className="id-photo-backgrounds" disabled={isIdPhotoProcessing}>
                <legend>背景颜色</legend>
                <div>
                  {ID_PHOTO_BACKGROUNDS.map((background) => (
                    <button
                      className={`id-photo-background ${idPhotoBackgroundId === background.id ? "is-active" : ""}`}
                      type="button"
                      key={background.id}
                      onClick={() => setIdPhotoBackgroundId(background.id)}
                      aria-pressed={idPhotoBackgroundId === background.id}
                    >
                      <span style={{ backgroundColor: background.color }} aria-hidden="true" />
                      {background.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="form-actions">
              <button className="primary-button" type="button" onClick={() => void createIdPhoto()} disabled={!idPhotoSource || isIdPhotoProcessing}>
                {isIdPhotoProcessing ? "正在生成…" : "生成证件照"}
              </button>
              {isIdPhotoProcessing && <button className="secondary-button" type="button" onClick={() => idPhotoAbortRef.current?.abort()}>取消</button>}
            </div>

            {idPhotoMessage && <p className="validation-message" aria-live="polite">{idPhotoMessage}</p>}

            {(idPhotoSource || idPhotoPartial || idPhotoOutput) && (
              <div className="transparent-preview-grid id-photo-preview-grid">
                {idPhotoSource && (
                  <article className="transparent-preview-card">
                    <span>原图</span>
                    <button type="button" onClick={() => setLightboxImage({ src: idPhotoSource.previewUrl, alt: idPhotoSource.name })} aria-label={`放大查看 ${idPhotoSource.name}`}>
                      <img src={idPhotoSource.previewUrl} alt={`${idPhotoSource.name} 原图`} />
                    </button>
                    <strong title={idPhotoSource.name}>{idPhotoSource.name}</strong>
                    {idPhotoSource.size && <small>{formatBytes(idPhotoSource.size)}</small>}
                  </article>
                )}

                {(idPhotoPartial || idPhotoOutput) && (
                  <article className="transparent-preview-card">
                    <span>{idPhotoOutput ? "成品" : "生成预览"}</span>
                    <button type="button" onClick={() => setLightboxImage({ src: idPhotoOutput?.previewUrl ?? idPhotoPartial ?? "", alt: idPhotoOutput?.name ?? "证件照生成预览" })} aria-label="放大查看证件照">
                      <img src={idPhotoOutput?.previewUrl ?? idPhotoPartial ?? ""} alt={idPhotoOutput ? "证件照成品" : "证件照生成预览"} />
                    </button>
                    <strong title={idPhotoOutput?.name}>{idPhotoOutput?.name ?? "正在生成"}</strong>
                    {idPhotoOutput?.size && <small>{formatBytes(idPhotoOutput.size)}</small>}
                    {idPhotoOutput && <a className="download-button" href={idPhotoOutput.previewUrl} download={idPhotoOutput.name}>下载 PNG</a>}
                  </article>
                )}
              </div>
            )}
          </section>

          <section className="panel border-trim-panel">
            <div className="panel-heading">
              <span>04</span>
              <div>
                <h2>智能去边框</h2>
                <p>识别白色留边，裁掉相框、页眉标识和页脚日期。</p>
              </div>
            </div>

            <label className={`upload-zone ${isBorderTrimming ? "is-disabled" : ""}`} htmlFor="border-trim-image">
              <input id="border-trim-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleBorderTrimFile} disabled={isBorderTrimming} />
              <span>选择带白色边框的图片</span>
              <strong>支持 PNG、JPG、WebP，单张不超过 50MB，仅在浏览器本地处理。</strong>
            </label>

            {borderTrimMessage && <p className="validation-message" aria-live="polite">{borderTrimMessage}</p>}

            {(borderTrimSource || borderTrimOutput) && (
              <div className="transparent-preview-grid">
                {borderTrimSource && (
                  <article className="transparent-preview-card">
                    <span>原图</span>
                    <button type="button" onClick={() => setLightboxImage({ src: borderTrimSource.previewUrl, alt: borderTrimSource.name })} aria-label={`放大查看 ${borderTrimSource.name}`}>
                      <img src={borderTrimSource.previewUrl} alt={`${borderTrimSource.name} 原图`} />
                    </button>
                    <strong title={borderTrimSource.name}>{borderTrimSource.name}</strong>
                    {borderTrimSource.size && <small>{formatBytes(borderTrimSource.size)}</small>}
                  </article>
                )}

                {borderTrimOutput && (
                  <article className="transparent-preview-card">
                    <span>去边框后</span>
                    <button type="button" onClick={() => setLightboxImage({ src: borderTrimOutput.previewUrl, alt: borderTrimOutput.name })} aria-label={`放大查看 ${borderTrimOutput.name}`}>
                      <img src={borderTrimOutput.previewUrl} alt={`${borderTrimOutput.name} 去边框结果`} />
                    </button>
                    <strong title={borderTrimOutput.name}>{borderTrimOutput.name}</strong>
                    {borderTrimOutput.size && <small>{formatBytes(borderTrimOutput.size)}</small>}
                    <a className="download-button" href={borderTrimOutput.previewUrl} download={borderTrimOutput.name}>
                      下载图片
                    </a>
                  </article>
                )}
              </div>
            )}
          </section>

          <section className="panel transparent-panel">
            <div className="panel-heading">
              <span>05</span>
              <div>
                <h2>透明 PNG</h2>
                <p>本地抠除假透明棋盘格或浅色背景。</p>
              </div>
            </div>

            <label className={`upload-zone ${isTransparencyProcessing ? "is-disabled" : ""}`} htmlFor="transparent-image">
              <input id="transparent-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleTransparentFile} disabled={isTransparencyProcessing} />
              <span>选择要转透明的图片</span>
              <strong>图片只在浏览器本地处理，不会上传到服务器。</strong>
            </label>

            {transparentMessage && (
              <p className="validation-message" aria-live="polite">
                {transparentMessage}
              </p>
            )}

            {(transparentSource || transparentOutput) && (
              <div className="transparent-preview-grid">
                {transparentSource && (
                  <article className="transparent-preview-card">
                    <span>原图</span>
                    <button type="button" onClick={() => setLightboxImage({ src: transparentSource.previewUrl, alt: transparentSource.name })} aria-label={`放大查看 ${transparentSource.name}`}>
                      <img src={transparentSource.previewUrl} alt={`${transparentSource.name} 原图`} />
                    </button>
                    <strong title={transparentSource.name}>{transparentSource.name}</strong>
                    {transparentSource.size && <small>{formatBytes(transparentSource.size)}</small>}
                  </article>
                )}

                {transparentOutput && (
                  <article className="transparent-preview-card">
                    <span>透明 PNG</span>
                    <button type="button" onClick={() => setLightboxImage({ src: transparentOutput.previewUrl, alt: transparentOutput.name })} aria-label={`放大查看 ${transparentOutput.name}`}>
                      <img src={transparentOutput.previewUrl} alt={`${transparentOutput.name} 透明结果`} />
                    </button>
                    <strong title={transparentOutput.name}>{transparentOutput.name}</strong>
                    <a className="download-button" href={transparentOutput.previewUrl} download={transparentOutput.name}>
                      下载 PNG
                    </a>
                  </article>
                )}
              </div>
            )}
          </section>

          <section className="panel compressor-panel">
            <div className="panel-heading">
              <span>06</span>
              <div>
                <h2>图片压缩</h2>
                <p>压缩至指定大小，图片只在浏览器本地处理。</p>
              </div>
            </div>

            <label className="field-label" htmlFor="compression-target">
              目标文件大小
            </label>
            <select id="compression-target" value={compressionTarget} onChange={handleCompressionTargetChange} disabled={isCompressionProcessing}>
              {COMPRESSION_TARGETS.map((target) => (
                <option value={target.value} key={target.value}>
                  {target.label} 以内
                </option>
              ))}
            </select>

            <label className={`upload-zone ${isCompressionProcessing ? "is-disabled" : ""}`} htmlFor="compression-image">
              <input id="compression-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleCompressionFile} disabled={isCompressionProcessing} />
              <span>选择要压缩的图片</span>
              <strong>支持 PNG、JPG、WebP，单张不超过 50MB。</strong>
            </label>

            {compressionMessage && (
              <p className="validation-message" aria-live="polite">
                {compressionMessage}
              </p>
            )}

            {(compressionSource || compressionOutput) && (
              <div className="transparent-preview-grid">
                {compressionSource && (
                  <article className="transparent-preview-card">
                    <span>原图</span>
                    <button type="button" onClick={() => setLightboxImage({ src: compressionSource.previewUrl, alt: compressionSource.name })} aria-label={`放大查看 ${compressionSource.name}`}>
                      <img src={compressionSource.previewUrl} alt={`${compressionSource.name} 原图`} />
                    </button>
                    <strong title={compressionSource.name}>{compressionSource.name}</strong>
                    {compressionSource.size && <small>{formatBytes(compressionSource.size)}</small>}
                  </article>
                )}

                {compressionOutput && (
                  <article className="transparent-preview-card">
                    <span>压缩结果</span>
                    <button type="button" onClick={() => setLightboxImage({ src: compressionOutput.previewUrl, alt: compressionOutput.name })} aria-label={`放大查看 ${compressionOutput.name}`}>
                      <img src={compressionOutput.previewUrl} alt={`${compressionOutput.name} 压缩结果`} />
                    </button>
                    <strong title={compressionOutput.name}>{compressionOutput.name}</strong>
                    {compressionOutput.size && <small>{formatBytes(compressionOutput.size)}</small>}
                    <a className="download-button" href={compressionOutput.previewUrl} download={compressionOutput.name}>
                      下载图片
                    </a>
                  </article>
                )}
              </div>
            )}
          </section>

          <section className="panel document-tool-panel">
            <div className="panel-heading">
              <span>07</span>
              <div>
                <h2>PDF 转图片</h2>
                <p>逐页转为 PNG，多页文件会自动打包。</p>
              </div>
            </div>

            <label className={`upload-zone ${isPdfConverting ? "is-disabled" : ""}`} htmlFor="pdf-to-images">
              <input id="pdf-to-images" type="file" accept="application/pdf,.pdf" onChange={handlePdfFile} disabled={isPdfConverting} />
              <span>选择要转换的 PDF</span>
              <strong>单个文件不超过 50MB，仅在浏览器本地处理。</strong>
            </label>

            {pdfToImageMessage && <p className="validation-message" aria-live="polite">{pdfToImageMessage}</p>}

            {(pdfSource || pdfImageOutput) && (
              <div className="document-output-grid">
                {pdfSource && (
                  <article className="document-output-card">
                    <span>源文件</span>
                    <strong title={pdfSource.name}>{pdfSource.name}</strong>
                    {pdfSource.size && <small>{formatBytes(pdfSource.size)}</small>}
                  </article>
                )}
                {pdfImageOutput && (
                  <article className="document-output-card">
                    <span>{pdfImageOutput.isArchive ? "图片压缩包" : "PNG 图片"}</span>
                    <button type="button" onClick={() => setLightboxImage({ src: pdfImageOutput.previewUrl, alt: `${pdfSource?.name ?? "PDF"} 第 1 页` })} aria-label="放大查看 PDF 第一页">
                      <img src={pdfImageOutput.previewUrl} alt="PDF 第一页预览" />
                    </button>
                    <strong title={pdfImageOutput.name}>{pdfImageOutput.name}</strong>
                    <small>{pdfImageOutput.pageCount} 页 · {formatBytes(pdfImageOutput.size)}</small>
                    <a className="download-button" href={pdfImageOutput.downloadUrl} download={pdfImageOutput.name}>
                      下载{pdfImageOutput.isArchive ? " ZIP" : " PNG"}
                    </a>
                  </article>
                )}
              </div>
            )}
          </section>

          <section className="panel document-tool-panel">
            <div className="panel-heading">
              <span>08</span>
              <div>
                <h2>图片转 PDF</h2>
                <p>按上传顺序，每张图片生成一页自适应方向的 A4。</p>
              </div>
            </div>

            <label className={`upload-zone ${isImagePdfProcessing ? "is-disabled" : ""}`} htmlFor="images-to-pdf">
              <input id="images-to-pdf" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={handlePdfImages} disabled={isImagePdfProcessing} />
              <span>选择要合并的图片</span>
              <strong>支持 PNG、JPG、WebP，单张不超过 50MB。</strong>
            </label>

            {imageToPdfMessage && <p className="validation-message" aria-live="polite">{imageToPdfMessage}</p>}

            {pdfImages.length > 0 && (
              <div className="preview-grid document-image-grid">
                {pdfImages.map((image, index) => (
                  <article className="preview-card" key={image.id}>
                    <button className="preview-open-button" type="button" onClick={() => setLightboxImage({ src: image.previewUrl, alt: image.file.name })} aria-label={`放大查看 ${image.file.name}`}>
                      <img src={image.previewUrl} alt={`${image.file.name} PDF 第 ${index + 1} 页`} />
                    </button>
                    <div>
                      <strong title={image.file.name}>第 {index + 1} 页 · {image.file.name}</strong>
                      <span>{formatBytes(image.file.size)}</span>
                    </div>
                    <button className="remove-image-button" type="button" onClick={() => removePdfImage(image.id)} disabled={isImagePdfProcessing}>
                      移除
                    </button>
                  </article>
                ))}
              </div>
            )}

            <div className="form-actions">
              <button className="primary-button" type="button" onClick={convertImagesToPdf} disabled={isImagePdfProcessing || pdfImages.length === 0}>
                {isImagePdfProcessing ? "生成 PDF 中…" : "生成 PDF"}
              </button>
            </div>

            {imagePdfOutput && (
              <article className="document-output-card document-output-download">
                <span>PDF 文件</span>
                <strong title={imagePdfOutput.name}>{imagePdfOutput.name}</strong>
                <small>{imagePdfOutput.pageCount} 页 · {formatBytes(imagePdfOutput.size)}</small>
                <a className="download-button" href={imagePdfOutput.downloadUrl} download={imagePdfOutput.name}>
                  下载 PDF
                </a>
              </article>
            )}
          </section>
          </div>
        </div>

        <section className="panel result-panel">
          <div className="panel-heading">
            <span>02</span>
            <div>
              <h2>状态与结果</h2>
              <p>生成通常需要 5–10 分钟，请保持页面打开。</p>
            </div>
          </div>

          <div className={`status-card ${state}`}>
            <div>
              <span className="status-label">当前状态</span>
              <strong aria-live="polite">{status}</strong>
            </div>
            <div className="timer" aria-label="已用时间">
              {formatElapsed(elapsed)}
            </div>
          </div>

          <div className="meta-grid">
            <div>
              <span>最新心跳</span>
              <strong>{heartbeatAt ?? "尚未收到"}</strong>
            </div>
            <div>
              <span>连接方式</span>
              <strong>SSE 流式响应</strong>
            </div>
          </div>

          {isGenerating && (
            <p className="persistence-note">
              关闭或刷新页面会中断当前任务；请等待 final_image 或 done 后再离开。
            </p>
          )}

          {generationError && (
            <div className="error-box" role="alert">
              <strong>生成遇到问题</strong>
              <p>{generationError.message}</p>
              {generationError.detail && generationError.detail !== generationError.message && (
                <span className="error-detail">服务返回：{generationError.detail}</span>
              )}
              <span>{generationError.retryable ? "当前输入已保留，请稍后再次点击“开始生成”。" : "你可以保留当前输入，调整后再次点击“开始生成”。"}</span>
              {generationError.requestId && <small>请求 ID：{generationError.requestId}</small>}
            </div>
          )}

          <div className={`image-stage ${visibleResult ? "has-image" : ""}`}>
            {visibleResult ? (
              <>
                {finalImage ? (
                  <button
                    className="image-open-button"
                    type="button"
                    onClick={() => setLightboxImage({ src: visibleResult, alt: "最终生成结果" })}
                    aria-label="放大查看最终生成结果"
                  >
                    <img src={visibleResult} alt="最终生成结果" />
                  </button>
                ) : (
                  <img src={visibleResult} alt="阶段性生成预览" />
                )}
                <span>{finalImage ? "Final image" : "Partial preview"}</span>
              </>
            ) : (
              <div className="empty-state">
                <span />
                <strong>等待图片事件</strong>
                <p>收到 partial_image 时会先显示预览，final_image / done 后展示最终图。</p>
              </div>
            )}
          </div>

          {finalImage && (
            <>
              <div className="result-actions" aria-label="最终图片操作">
                <button className="secondary-button" type="button" onClick={downloadFinalImage}>下载</button>
                <button className="secondary-button" type="button" onClick={() => void copyFinalImage()}>复制</button>
                <button className="secondary-button" type="button" onClick={() => void sendFinalImageToTool("transparent")}>转透明 PNG</button>
                <button className="secondary-button" type="button" onClick={() => void sendFinalImageToTool("border")}>去边框</button>
                <button className="secondary-button" type="button" onClick={() => void sendFinalImageToTool("compress")}>压缩</button>
                <button className="secondary-button" type="button" onClick={() => void sendFinalImageToTool("pdf")}>加入 PDF</button>
              </div>
              {resultActionMessage && <p className="result-action-message" aria-live="polite">{resultActionMessage}</p>}

              <form className="refine-form" onSubmit={refineGeneratedImage}>
                <label className="field-label" htmlFor="refinement-prompt">
                  追加提示词
                </label>
                <textarea
                  id="refinement-prompt"
                  value={refinementPrompt}
                  onChange={(event) => setRefinementPrompt(event.target.value)}
                  placeholder="例如：把背景换成纯白、整体更亮、保留人物姿势..."
                  rows={3}
                  required
                  maxLength={MAX_REFINEMENT_PROMPT_LENGTH}
                  disabled={isGenerating}
                />
                <div className="refine-actions">
                  <button className="primary-button" type="submit" disabled={!canRefine}>
                    {isGenerating ? "生成中…" : "追加生成"}
                  </button>
                  {refinementMessage && (
                    <p className="refinement-message" aria-live="polite">
                      {refinementMessage}
                    </p>
                  )}
                </div>
              </form>
            </>
          )}

          <section className="history-panel" aria-labelledby="history-heading">
            <div className="history-heading">
              <div>
                <h3 id="history-heading">本地生成历史</h3>
                <p>最近保存 12 条结果，仅存于当前浏览器。</p>
              </div>
              {generationHistory.length > 0 && (
                <button className="history-clear-button" type="button" onClick={() => void removeAllHistory()}>
                  清空
                </button>
              )}
            </div>
            {historyMessage && <p className="history-message" aria-live="polite">{historyMessage}</p>}
            {generationHistory.length > 0 ? (
              <div className="history-list">
                {generationHistory.map((entry) => (
                  <article className="history-item" key={entry.id}>
                    <button className="history-preview-button" type="button" onClick={() => restoreHistoryEntry(entry)} aria-label={`恢复 ${formatHistoryTime(entry.createdAt)} 的生成结果`}>
                      <img src={entry.image} alt={`${formatHistoryTime(entry.createdAt)} 的生成结果`} />
                    </button>
                    <div>
                      <strong>{formatHistoryTime(entry.createdAt)}</strong>
                      <span>{entry.size}</span>
                      <p title={entry.prompt}>{entry.prompt || "未填写提示词"}</p>
                    </div>
                    <button className="history-delete-button" type="button" onClick={() => void removeHistoryEntry(entry.id)} aria-label={`删除 ${formatHistoryTime(entry.createdAt)} 的历史记录`}>
                      删除
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="history-empty">生成成功后的结果会自动保存在这里。</p>
            )}
          </section>
        </section>
      </div>
      {lightboxImage && (
        <div
          className="result-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${lightboxImage.alt}预览`}
          onClick={(event) => {
            if (event.target === event.currentTarget) setLightboxImage(null);
          }}
          onWheel={handleLightboxWheel}
        >
          <div className="result-lightbox-controls" role="group" aria-label="图片预览操作">
            <button type="button" onClick={(event) => { event.stopPropagation(); updateLightboxRotation(lightboxRotationValueRef.current - 90); }} aria-label="向左旋转图片" title="向左旋转图片">
              ↺
            </button>
            <button type="button" onClick={(event) => { event.stopPropagation(); adjustLightboxZoom(-LIGHTBOX_ZOOM_STEP); }} disabled={lightboxZoom <= LIGHTBOX_MIN_ZOOM} aria-label="缩小图片" title="缩小图片">
              -
            </button>
            <button type="button" onClick={(event) => { event.stopPropagation(); resetLightboxTransform(); }} disabled={lightboxZoom === LIGHTBOX_MIN_ZOOM && lightboxPan.x === 0 && lightboxPan.y === 0 && lightboxRotation === 0} aria-label="重置图片预览" title="重置图片预览">
              {Math.round(lightboxZoom * 100)}%
            </button>
            <button type="button" onClick={(event) => { event.stopPropagation(); adjustLightboxZoom(LIGHTBOX_ZOOM_STEP); }} disabled={lightboxZoom >= LIGHTBOX_MAX_ZOOM} aria-label="放大图片" title="放大图片">
              +
            </button>
            <button type="button" onClick={(event) => { event.stopPropagation(); updateLightboxRotation(lightboxRotationValueRef.current + 90); }} aria-label="向右旋转图片" title="向右旋转图片">
              ↻
            </button>
          </div>
          <button className="result-lightbox-close" type="button" onClick={() => setLightboxImage(null)} aria-label="关闭图片预览">
            关闭
          </button>
          <div
            className="result-lightbox-stage"
            onPointerDown={handleLightboxPointerDown}
            onPointerMove={handleLightboxPointerMove}
            onPointerUp={handleLightboxPointerEnd}
            onPointerCancel={handleLightboxPointerEnd}
          >
            <img
              className={`result-lightbox-image ${lightboxZoom > LIGHTBOX_MIN_ZOOM ? "is-zoomed" : ""} ${isLightboxDragging ? "is-dragging" : ""}`}
              src={lightboxImage.src}
              alt={lightboxImage.alt}
              draggable={false}
              style={{ transform: `translate3d(${lightboxPan.x}px, ${lightboxPan.y}px, 0) scale(${lightboxZoom}) rotate(${lightboxRotation}deg)` } as CSSProperties}
            />
          </div>
        </div>
      )}
    </main>
  );
}
