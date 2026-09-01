export type LocalEditSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LocalEditBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageDimensions = {
  width: number;
  height: number;
};

export type LocalEditJob = {
  source: string;
  selection: LocalEditSelection;
  targetBounds: LocalEditBounds;
  contextBounds: LocalEditBounds;
  modelBounds: LocalEditBounds;
  modelContentBounds: LocalEditBounds;
  modelTargetBounds: LocalEditBounds;
  modelSize: string;
};

export type FeatherEdges = {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
};

export type LocalEditMaskContext = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  clearRect: (x: number, y: number, width: number, height: number) => void;
};

export const LOCAL_EDIT_MIN_SELECTION = 8;
export const LOCAL_EDIT_CONTEXT_RATIO = 0.2;
export const LOCAL_EDIT_FEATHER_RATIO = 0.08;
export const LOCAL_EDIT_MIN_MODEL_PIXELS = 655_360;
export const LOCAL_EDIT_MAX_MODEL_PIXELS = 8_294_400;
export const LOCAL_EDIT_MAX_MODEL_EDGE = 3_840;
const LOCAL_EDIT_SAFE_MODEL_EDGE = 2_560;
const LOCAL_EDIT_MIN_TARGET_PIXELS = 1024 * 1024;
const LOCAL_EDIT_MAX_TARGET_PIXELS = 2560 * 1440;
const LOCAL_EDIT_SAFE_MASK_PIXELS = 4_000_000;
const MODEL_DIMENSION_STEP = 16;
const MODEL_MIN_ASPECT_RATIO = 1 / 3;
const MODEL_MAX_ASPECT_RATIO = 3;

export const DEFAULT_LOCAL_EDIT_SELECTION: LocalEditSelection = { x: 25, y: 25, width: 50, height: 50 };

export function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createLocalEditSelection(first: { x: number; y: number }, second: { x: number; y: number }) {
  const left = clampNumber(Math.min(first.x, second.x), 0, 100 - LOCAL_EDIT_MIN_SELECTION);
  const top = clampNumber(Math.min(first.y, second.y), 0, 100 - LOCAL_EDIT_MIN_SELECTION);
  const right = clampNumber(Math.max(first.x, second.x), left + LOCAL_EDIT_MIN_SELECTION, 100);
  const bottom = clampNumber(Math.max(first.y, second.y), top + LOCAL_EDIT_MIN_SELECTION, 100);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function getLocalEditBounds(image: ImageDimensions, selection: LocalEditSelection) {
  const x = Math.floor((selection.x / 100) * image.width);
  const y = Math.floor((selection.y / 100) * image.height);
  const right = Math.min(image.width, Math.ceil(((selection.x + selection.width) / 100) * image.width));
  const bottom = Math.min(image.height, Math.ceil(((selection.y + selection.height) / 100) * image.height));

  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function getLocalEditContextBounds(targetBounds: LocalEditBounds, image: ImageDimensions) {
  const padding = Math.ceil(Math.max(targetBounds.width, targetBounds.height) * LOCAL_EDIT_CONTEXT_RATIO);
  const x = Math.max(0, targetBounds.x - padding);
  const y = Math.max(0, targetBounds.y - padding);
  const right = Math.min(image.width, targetBounds.x + targetBounds.width + padding);
  const bottom = Math.min(image.height, targetBounds.y + targetBounds.height + padding);

  return { x, y, width: right - x, height: bottom - y };
}

export function getLocalEditTargetInContext(targetBounds: LocalEditBounds, contextBounds: LocalEditBounds) {
  return {
    x: targetBounds.x - contextBounds.x,
    y: targetBounds.y - contextBounds.y,
    width: targetBounds.width,
    height: targetBounds.height,
  };
}

function roundToModelStep(value: number) {
  return Math.max(MODEL_DIMENSION_STEP, Math.round(value / MODEL_DIMENSION_STEP) * MODEL_DIMENSION_STEP);
}

function scaleModelDimensions(width: number, height: number, scale: number) {
  return {
    width: roundToModelStep(width * scale),
    height: roundToModelStep(height * scale),
  };
}

function clampModelAspectRatio(dimensions: ImageDimensions) {
  let { width, height } = dimensions;

  if (width > height * MODEL_MAX_ASPECT_RATIO) width = height * MODEL_MAX_ASPECT_RATIO;
  if (height > width / MODEL_MIN_ASPECT_RATIO) height = width / MODEL_MIN_ASPECT_RATIO;

  return { width: roundToModelStep(width), height: roundToModelStep(height) };
}

export function getLocalEditModelDimensions(contextBounds: ImageDimensions) {
  const sourceRatio = contextBounds.width / contextBounds.height;
  const ratio = clampNumber(sourceRatio, MODEL_MIN_ASPECT_RATIO, MODEL_MAX_ASPECT_RATIO);
  const desiredPixels = clampNumber(
    contextBounds.width * contextBounds.height,
    LOCAL_EDIT_MIN_TARGET_PIXELS,
    LOCAL_EDIT_MAX_TARGET_PIXELS,
  );
  let width = Math.sqrt(desiredPixels * ratio);
  let height = width / ratio;
  const edgeScale = Math.min(1, LOCAL_EDIT_SAFE_MODEL_EDGE / Math.max(width, height));

  ({ width, height } = scaleModelDimensions(width, height, edgeScale));
  ({ width, height } = clampModelAspectRatio({ width, height }));

  let pixels = width * height;
  if (pixels < LOCAL_EDIT_MIN_MODEL_PIXELS) {
    ({ width, height } = scaleModelDimensions(width, height, Math.sqrt(LOCAL_EDIT_MIN_MODEL_PIXELS / pixels)));
    ({ width, height } = clampModelAspectRatio({ width, height }));
  }

  pixels = width * height;
  const maximumScale = Math.min(
    1,
    LOCAL_EDIT_MAX_MODEL_EDGE / Math.max(width, height),
    Math.sqrt(Math.min(LOCAL_EDIT_MAX_MODEL_PIXELS, LOCAL_EDIT_SAFE_MASK_PIXELS) / pixels),
  );
  if (maximumScale < 1) {
    ({ width, height } = scaleModelDimensions(width, height, maximumScale));
    ({ width, height } = clampModelAspectRatio({ width, height }));
  }

  return { width, height };
}

export function getContainedImageBounds(source: ImageDimensions, destination: ImageDimensions) {
  const scale = Math.min(destination.width / source.width, destination.height / source.height);
  const width = Math.max(1, Math.min(destination.width, Math.round(source.width * scale)));
  const height = Math.max(1, Math.min(destination.height, Math.round(source.height * scale)));

  return {
    x: Math.floor((destination.width - width) / 2),
    y: Math.floor((destination.height - height) / 2),
    width,
    height,
  };
}

export function mapLocalEditBounds(
  bounds: LocalEditBounds,
  source: ImageDimensions,
  destination: LocalEditBounds,
) {
  const rawX = destination.x + Math.floor((bounds.x / source.width) * destination.width);
  const rawY = destination.y + Math.floor((bounds.y / source.height) * destination.height);
  const rawRight = destination.x + Math.ceil(((bounds.x + bounds.width) / source.width) * destination.width);
  const rawBottom = destination.y + Math.ceil(((bounds.y + bounds.height) / source.height) * destination.height);
  const x = clampNumber(rawX, destination.x, destination.x + destination.width - 1);
  const y = clampNumber(rawY, destination.y, destination.y + destination.height - 1);
  const right = clampNumber(rawRight, x + 1, destination.x + destination.width);
  const bottom = clampNumber(rawBottom, y + 1, destination.y + destination.height);

  return { x, y, width: right - x, height: bottom - y };
}

export function paintLocalEditMask(
  context: LocalEditMaskContext,
  dimensions: ImageDimensions,
  targetBounds: LocalEditBounds,
) {
  context.fillStyle = "rgba(0, 0, 0, 1)";
  context.fillRect(0, 0, dimensions.width, dimensions.height);
  context.clearRect(targetBounds.x, targetBounds.y, targetBounds.width, targetBounds.height);
}

function getEdgeOpacity(index: number, length: number, feather: number, enabledAtStart: boolean, enabledAtEnd: boolean) {
  if (feather <= 0) return 1;
  const startOpacity = enabledAtStart && index < feather ? index / feather : 1;
  const endDistance = length - 1 - index;
  const endOpacity = enabledAtEnd && endDistance < feather ? endDistance / feather : 1;
  return Math.min(startOpacity, endOpacity);
}

export function getLocalEditFeatherEdges(targetBounds: LocalEditBounds, image: ImageDimensions): FeatherEdges {
  return {
    top: targetBounds.y > 0,
    right: targetBounds.x + targetBounds.width < image.width,
    bottom: targetBounds.y + targetBounds.height < image.height,
    left: targetBounds.x > 0,
  };
}

export function createFeatherAlpha(
  width: number,
  height: number,
  ratio = LOCAL_EDIT_FEATHER_RATIO,
  edges: FeatherEdges = { top: true, right: true, bottom: true, left: true },
) {
  const alpha = new Uint8ClampedArray(width * height);
  const minimumDimension = Math.min(width, height);
  const feather = Math.min(
    Math.floor((minimumDimension - 1) / 2),
    Math.max(1, Math.round(minimumDimension * ratio)),
  );

  for (let y = 0; y < height; y += 1) {
    const verticalOpacity = getEdgeOpacity(y, height, feather, edges.top, edges.bottom);
    for (let x = 0; x < width; x += 1) {
      const horizontalOpacity = getEdgeOpacity(x, width, feather, edges.left, edges.right);
      alpha[y * width + x] = Math.round(horizontalOpacity * verticalOpacity * 255);
    }
  }

  return alpha;
}

export function compositeRgbaRegion(
  destination: Uint8ClampedArray,
  destinationDimensions: ImageDimensions,
  patch: Uint8ClampedArray,
  targetBounds: LocalEditBounds,
  featherAlpha: Uint8ClampedArray,
) {
  if (destination.length !== destinationDimensions.width * destinationDimensions.height * 4) {
    throw new Error("目标图片像素尺寸不匹配。");
  }
  if (patch.length !== targetBounds.width * targetBounds.height * 4 || featherAlpha.length !== targetBounds.width * targetBounds.height) {
    throw new Error("局部图片像素尺寸不匹配。");
  }
  if (
    targetBounds.x < 0 || targetBounds.y < 0 ||
    targetBounds.x + targetBounds.width > destinationDimensions.width ||
    targetBounds.y + targetBounds.height > destinationDimensions.height
  ) {
    throw new Error("局部图片合成区域超出目标图片范围。");
  }

  const output = new Uint8ClampedArray(destination);

  for (let y = 0; y < targetBounds.height; y += 1) {
    for (let x = 0; x < targetBounds.width; x += 1) {
      const patchPixel = y * targetBounds.width + x;
      const patchIndex = patchPixel * 4;
      const destinationIndex = ((targetBounds.y + y) * destinationDimensions.width + targetBounds.x + x) * 4;
      const sourceAlpha = (patch[patchIndex + 3] / 255) * (featherAlpha[patchPixel] / 255);
      const destinationAlpha = output[destinationIndex + 3] / 255;
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);

      for (let channel = 0; channel < 3; channel += 1) {
        const sourceValue = patch[patchIndex + channel];
        const destinationValue = output[destinationIndex + channel];
        output[destinationIndex + channel] = outputAlpha === 0
          ? 0
          : Math.round((sourceValue * sourceAlpha + destinationValue * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
      }
      output[destinationIndex + 3] = Math.round(outputAlpha * 255);
    }
  }

  return output;
}
