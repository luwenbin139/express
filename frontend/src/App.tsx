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

const API_ENDPOINT = "/api/generate-image-stream";
const MAX_IMAGES = 4;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_IMAGE_SIZE = "auto";
const IMAGE_SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024", "1920x1080"];
const PROVIDER_OPTIONS = [
  { value: "default", label: "默认运营商" },
  { value: "iai", label: "IAI" },
];

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
  const [images, setImages] = useState<ImageFile[]>([]);
  const [provider, setProvider] = useState("default");
  const [size, setSize] = useState(DEFAULT_IMAGE_SIZE);
  const [validationMessage, setValidationMessage] = useState("");
  const [state, setState] = useState<GenerationState>("idle");
  const [status, setStatus] = useState("准备上传参考图并开始生成。");
  const [heartbeatAt, setHeartbeatAt] = useState<string | null>(null);
  const [partialImage, setPartialImage] = useState<string | null>(null);
  const [finalImage, setFinalImage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const imagesRef = useRef<ImageFile[]>([]);

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
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      abortRef.current?.abort();
    };
  }, []);

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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setState("generating");
    setElapsed(0);
    setErrorMessage("");
    setPartialImage(null);
    setFinalImage(null);
    setHeartbeatAt(null);
    setStatus("正在上传 multipart/form-data 到 /api/generate-image-stream…");

    const formData = new FormData();
    formData.append("prompt", prompt);
    formData.append("provider", provider);
    formData.append("mode", images.length > 0 ? "edit" : "generate");
    formData.append("size", size || DEFAULT_IMAGE_SIZE);
    if (images.length > 0) {
      images.forEach((image) => formData.append("images", image.file));
    }

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
        return;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `请求失败：HTTP ${response.status}`);
      }

      setState("success");
      setStatus("请求完成，但服务器没有返回 SSE 图片事件。");
    } catch (error) {
      if (controller.signal.aborted) {
        setState("cancelled");
        setStatus("已取消当前请求。你可以随时重新生成。");
        return;
      }
      setState("error");
      setStatus("生成失败，请检查输入或稍后重试。");
      setErrorMessage(error instanceof Error ? error.message : "未知错误");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const canSubmit = state !== "generating" && images.length <= MAX_IMAGES;
  const isGenerating = state === "generating";
  const visibleResult = finalImage ?? partialImage;

  return (
    <main className="app-shell">
      <div className="workspace">
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

          <label className="field-label size-label" htmlFor="provider">
            运营商
          </label>
          <select id="provider" value={provider} onChange={(event) => setProvider(event.target.value)} disabled={isGenerating}>
            {PROVIDER_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
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
                <img src={image.previewUrl} alt={`${image.file.name} preview`} />
                <div>
                  <strong title={image.file.name}>{image.file.name}</strong>
                  <span>{formatBytes(image.file.size)}</span>
                </div>
                <button type="button" onClick={() => removeImage(image.id)} aria-label={`移除 ${image.file.name}`} disabled={isGenerating}>
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
                <img src={visibleResult} alt={finalImage ? "最终生成结果" : "阶段性生成预览"} />
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
        </section>
      </div>
    </main>
  );
}
