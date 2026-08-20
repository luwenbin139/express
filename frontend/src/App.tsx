import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, FormEvent } from "react";

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
  errorMessage?: string;
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

const API_ENDPOINT = "/api/generate-image-stream";
const MAX_IMAGES = 4;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_IMAGE_SIZE = "auto";
const IMAGE_SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024", "1920x1080"];

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
  formData.append("mode", images.length > 0 ? "edit" : "generate");
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

function createRefinementPrompt(originalPrompt: string, refinementPrompt: string) {
  const basePrompt = originalPrompt.trim();
  const extraPrompt = refinementPrompt.trim();

  return [
    basePrompt ? `原始提示词：${basePrompt}` : "",
    "请基于当前最终图继续修改，只按下面的追加要求调整，其余画面尽量保持一致。",
    `追加要求：${extraPrompt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function createTransparentFileName(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}-transparent.png`;
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

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("透明 PNG 导出失败，请换一张图片重试。"));
    }, "image/png");
  });
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

  return canvasToPngBlob(canvas);
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
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [transparentSource, setTransparentSource] = useState<TransparentPreview | null>(null);
  const [transparentOutput, setTransparentOutput] = useState<TransparentPreview | null>(null);
  const [transparentMessage, setTransparentMessage] = useState("");
  const [isTransparencyProcessing, setIsTransparencyProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const imagesRef = useRef<ImageFile[]>([]);
  const transparentSourceUrlRef = useRef<string | null>(null);
  const transparentOutputUrlRef = useRef<string | null>(null);

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
    if (!lightboxImage) return undefined;

    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setLightboxImage(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lightboxImage]);

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
      if (transparentSourceUrlRef.current) URL.revokeObjectURL(transparentSourceUrlRef.current);
      if (transparentOutputUrlRef.current) URL.revokeObjectURL(transparentOutputUrlRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // 上传和粘贴最终都走这里，保证数量、格式和大小限制一致。
  const addImageFiles = (files: File[], source: "upload" | "paste") => {
    if (state === "generating") return;
    if (!files.length) return;

    const nextImages: ImageFile[] = [];
    const messages: string[] = [];
    const remainingSlots = MAX_IMAGES - images.length;

    if (files.length > remainingSlots) {
      messages.push(`最多只能上传 ${MAX_IMAGES} 张图片，已忽略多出的文件。`);
    }

    files.slice(0, Math.max(remainingSlots, 0)).forEach((file) => {
      if (!ALLOWED_TYPES.has(file.type)) {
        messages.push(`${file.name} 不是支持的 png/jpeg/webp 格式。`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        messages.push(`${file.name} 超过 10MB。`);
        return;
      }
      nextImages.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl: URL.createObjectURL(file),
      });
    });

    setImages((current) => [...current, ...nextImages]);
    const successMessage = source === "paste" && nextImages.length > 0 ? `已从粘贴内容添加 ${nextImages.length} 张参考图。` : "";
    setValidationMessage([successMessage, ...messages].filter(Boolean).join(" "));
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

    if (file.size > MAX_FILE_SIZE) {
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
      if (image) setFinalImage(image);
      setStatus("最终图片已返回。正在完成任务…");
      return { successfulImage: Boolean(image) };
    }

    if (message.event === "done") {
      const image = getImageFromPayload(payload);
      if (image) setFinalImage(image);
      setStatus("生成完成，可以保存结果或再次尝试。");
      setState("success");
      return { successfulImage: Boolean(image) };
    }

    if (message.event === "error") {
      const errorMessage = getTextFromPayload(payload, ["error", "message", "detail"]) || "图片生成流连接失败";
      setErrorMessage(errorMessage);
      setStatus("生成失败，请调整输入后重试。");
      setState("error");
      return { errorMessage };
    }

    return {};
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState("cancelled");
    setStatus("已取消当前请求。你可以修改提示词或图片后重新开始。");
  };

  const runImageRequest = async (formData: FormData, initialStatus: string) => {
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setState("generating");
    setElapsed(0);
    setErrorMessage("");
    setPartialImage(null);
    setFinalImage(null);
    setHeartbeatAt(null);
    setLightboxImage(null);
    setRefinementMessage("");
    setStatus(initialStatus);

    try {
      const response = await fetch(API_ENDPOINT, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        let sawSuccessfulFinalOrDoneImage = false;
        let bestSseErrorMessage = "";

        await parseSseStream(
          response,
          (message) => {
            const result = handleSseMessage(message);
            if (result.successfulImage) sawSuccessfulFinalOrDoneImage = true;
            if (result.errorMessage) {
              bestSseErrorMessage = result.errorMessage;
              throw new Error(result.errorMessage);
            }
          },
          controller.signal,
        );

        if (!sawSuccessfulFinalOrDoneImage) {
          throw new Error(!response.ok && bestSseErrorMessage ? bestSseErrorMessage : "图片生成流连接失败");
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
      setState("error");
      setStatus("生成失败，请检查输入或稍后重试。");
      setErrorMessage(error instanceof Error ? error.message : "未知错误");
      return false;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  // 只调用流式接口；生成/编辑由是否上传参考图自动决定。
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = createImageFormData(prompt, size, images.map((image) => image.file));
    await runImageRequest(formData, "正在上传 multipart/form-data 到 /api/generate-image-stream…");
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
      const formData = createImageFormData(createRefinementPrompt(prompt, nextPrompt), size, [generatedImageFile]);
      const isSuccessful = await runImageRequest(formData, "正在基于当前最终图追加生成…");

      if (isSuccessful) {
        setRefinementPrompt("");
        setRefinementMessage("已根据追加提示词生成新图片。");
      }
    } catch (error) {
      setState("error");
      setErrorMessage(error instanceof Error ? error.message : "追加生成失败");
      setRefinementMessage(error instanceof Error ? error.message : "追加生成失败");
      setStatus("追加生成失败，请稍后重试。");
    }
  };

  const canSubmit = state !== "generating" && images.length <= MAX_IMAGES;
  const isGenerating = state === "generating";
  const visibleResult = finalImage ?? partialImage;
  const canRefine = Boolean(finalImage && refinementPrompt.trim()) && !isGenerating;

  return (
    <main className="app-shell">
      <div className="workspace">
        <div className="left-stack">
          <form className="panel config-panel" onSubmit={submit}>
            <div className="panel-heading">
              <span>01</span>
              <div>
                <h2>配置输入</h2>
                <p>最多 4 张参考图，每张不超过 10MB。</p>
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
              <strong>不上传也能直接生成 · {MAX_IMAGES - images.length} 个名额可用</strong>
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

          <section className="panel transparent-panel">
            <div className="panel-heading">
              <span>03</span>
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

          <p className="persistence-note">
            关闭或刷新页面会中断当前任务；前端目前没有后端持久化恢复能力，请等待 final_image 或 done 后再离开。
          </p>

          {errorMessage && (
            <div className="error-box" role="alert">
              <strong>生成遇到问题</strong>
              <p>{errorMessage}</p>
              <span>你可以保留当前输入，调整后再次点击“开始生成”。</span>
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
          )}
        </section>
      </div>
      {lightboxImage && (
        <div className="result-lightbox" role="dialog" aria-modal="true" aria-label={`${lightboxImage.alt}预览`} onClick={() => setLightboxImage(null)}>
          <button className="result-lightbox-close" type="button" onClick={() => setLightboxImage(null)} aria-label="关闭图片预览">
            关闭
          </button>
          <img src={lightboxImage.src} alt={lightboxImage.alt} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </main>
  );
}
