import { describe, expect, it } from "vitest";
import {
  LOCAL_EDIT_MAX_MODEL_EDGE,
  LOCAL_EDIT_MAX_MODEL_PIXELS,
  LOCAL_EDIT_MIN_MODEL_PIXELS,
  compositeRgbaRegion,
  createFeatherAlpha,
  createLocalEditSelection,
  getContainedImageBounds,
  getLocalEditBounds,
  getLocalEditContextBounds,
  getLocalEditFeatherEdges,
  getLocalEditModelDimensions,
  getLocalEditTargetInContext,
  mapLocalEditBounds,
  paintLocalEditMask,
} from "./local-edit";

function solidImage(width: number, height: number, color: [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) pixels.set(color, index * 4);
  return pixels;
}

function getPixel(pixels: Uint8ClampedArray, width: number, x: number, y: number) {
  return [...pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4)];
}

describe("局部编辑坐标", () => {
  it.each([
    ["横图", { width: 1600, height: 400 }, { x: 25, y: 25, width: 50, height: 50 }, { x: 400, y: 100, width: 800, height: 200 }],
    ["竖图", { width: 400, height: 1600 }, { x: 25, y: 25, width: 50, height: 50 }, { x: 100, y: 400, width: 200, height: 800 }],
    ["方图", { width: 801, height: 801 }, { x: 12.5, y: 12.5, width: 8, height: 8 }, { x: 100, y: 100, width: 65, height: 65 }],
    ["右下边缘", { width: 1000, height: 500 }, { x: 92, y: 92, width: 8, height: 8 }, { x: 920, y: 460, width: 80, height: 40 }],
  ])("把%s百分比映射为覆盖完整选区的像素边界", (_label, image, selection, expected) => {
    expect(getLocalEditBounds(image, selection)).toEqual(expected);
  });

  it("反向拖动时保持最小 8% 选区并夹在画布内", () => {
    expect(createLocalEditSelection({ x: 99, y: 99 }, { x: 98, y: 97 })).toEqual({ x: 92, y: 92, width: 8, height: 8 });
    expect(createLocalEditSelection({ x: 70, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 60, height: 40 });
  });

  it("上下文 padding 在图片四边正确裁切", () => {
    expect(getLocalEditContextBounds({ x: 0, y: 0, width: 100, height: 50 }, { width: 500, height: 300 }))
      .toEqual({ x: 0, y: 0, width: 120, height: 70 });
    expect(getLocalEditContextBounds({ x: 420, y: 250, width: 80, height: 50 }, { width: 500, height: 300 }))
      .toEqual({ x: 404, y: 234, width: 96, height: 66 });
  });

  it("目标区域在上下文中的坐标使用同一原点", () => {
    expect(getLocalEditTargetInContext(
      { x: 420, y: 250, width: 80, height: 50 },
      { x: 404, y: 234, width: 96, height: 66 },
    )).toEqual({ x: 16, y: 16, width: 80, height: 50 });
  });

  it("按各轴比例映射非整数尺寸并覆盖完整源边界", () => {
    expect(mapLocalEditBounds(
      { x: 17, y: 11, width: 43, height: 29 },
      { width: 97, height: 71 },
      { x: 8, y: 12, width: 1000, height: 736 },
    )).toEqual({ x: 183, y: 126, width: 444, height: 301 });
  });
});

describe("模型画布尺寸", () => {
  it.each([
    { width: 1600, height: 400 },
    { width: 400, height: 1600 },
    { width: 800, height: 800 },
    { width: 127, height: 83 },
    { width: 3000, height: 1000 },
  ])("为 $width x $height 生成合法且接近原比例的尺寸", (source) => {
    const dimensions = getLocalEditModelDimensions(source);
    const pixels = dimensions.width * dimensions.height;
    const ratio = dimensions.width / dimensions.height;
    const sourceRatio = source.width / source.height;

    expect(dimensions.width % 16).toBe(0);
    expect(dimensions.height % 16).toBe(0);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(LOCAL_EDIT_MAX_MODEL_EDGE);
    expect(pixels).toBeGreaterThanOrEqual(LOCAL_EDIT_MIN_MODEL_PIXELS);
    expect(pixels).toBeLessThanOrEqual(LOCAL_EDIT_MAX_MODEL_PIXELS);
    expect(ratio).toBeGreaterThanOrEqual(1 / 3);
    expect(ratio).toBeLessThanOrEqual(3);
    expect(Math.abs(ratio - Math.min(3, Math.max(1 / 3, sourceRatio)))).toBeLessThan(0.03);
  });

  it("极端宽高比使用 contain 留白而不拉伸原图", () => {
    const destination = getLocalEditModelDimensions({ width: 1600, height: 200 });
    const content = getContainedImageBounds({ width: 1600, height: 200 }, destination);

    expect(destination.width / destination.height).toBeLessThanOrEqual(3);
    expect(content.width / content.height).toBeCloseTo(8, 1);
    expect(content.y).toBeGreaterThan(0);
  });
});

describe("局部编辑 mask", () => {
  it("仅把模型目标区域设为透明", () => {
    const operations: Array<[string, number, number, number, number]> = [];
    const context = {
      fillStyle: "",
      fillRect: (x: number, y: number, width: number, height: number) => operations.push(["fill", x, y, width, height]),
      clearRect: (x: number, y: number, width: number, height: number) => operations.push(["clear", x, y, width, height]),
    };

    paintLocalEditMask(context, { width: 640, height: 480 }, { x: 120, y: 80, width: 240, height: 160 });

    expect(context.fillStyle).toBe("rgba(0, 0, 0, 1)");
    expect(operations).toEqual([
      ["fill", 0, 0, 640, 480],
      ["clear", 120, 80, 240, 160],
    ]);
  });

  it("feather 中心保持不透明，启用边缘为透明且窄区域不会出错", () => {
    const alpha = createFeatherAlpha(5, 3);

    expect(alpha).toHaveLength(15);
    expect(alpha[0]).toBe(0);
    expect(alpha[2]).toBe(0);
    expect(alpha[7]).toBe(255);
    expect(createFeatherAlpha(1, 1)[0]).toBe(255);
  });

  it("贴住原图边缘时不羽化外侧边缘", () => {
    const edges = getLocalEditFeatherEdges({ x: 0, y: 0, width: 3, height: 3 }, { width: 8, height: 8 });
    const alpha = createFeatherAlpha(3, 3, 0.5, edges);

    expect(edges).toEqual({ top: false, right: true, bottom: true, left: false });
    expect(alpha[0]).toBe(255);
    expect(alpha[2]).toBe(0);
    expect(alpha[6]).toBe(0);
  });
});

describe("局部编辑像素合成", () => {
  it("单区域只改变目标矩形，选区外逐像素不变", () => {
    const destination = solidImage(6, 5, [10, 20, 30, 255]);
    const patch = solidImage(2, 2, [200, 100, 50, 255]);
    const alpha = new Uint8ClampedArray([255, 255, 255, 255]);
    const output = compositeRgbaRegion(destination, { width: 6, height: 5 }, patch, { x: 2, y: 1, width: 2, height: 2 }, alpha);

    expect(getPixel(output, 6, 1, 1)).toEqual([10, 20, 30, 255]);
    expect(getPixel(output, 6, 2, 1)).toEqual([200, 100, 50, 255]);
    expect(getPixel(output, 6, 3, 2)).toEqual([200, 100, 50, 255]);
    expect(getPixel(output, 6, 4, 2)).toEqual([10, 20, 30, 255]);
  });

  it("两个不重叠区域都生效", () => {
    const original = solidImage(5, 3, [0, 0, 0, 255]);
    const first = compositeRgbaRegion(
      original,
      { width: 5, height: 3 },
      solidImage(1, 1, [255, 0, 0, 255]),
      { x: 0, y: 0, width: 1, height: 1 },
      new Uint8ClampedArray([255]),
    );
    const second = compositeRgbaRegion(
      first,
      { width: 5, height: 3 },
      solidImage(1, 1, [0, 0, 255, 255]),
      { x: 4, y: 2, width: 1, height: 1 },
      new Uint8ClampedArray([255]),
    );

    expect(getPixel(second, 5, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(getPixel(second, 5, 4, 2)).toEqual([0, 0, 255, 255]);
    expect(getPixel(second, 5, 2, 1)).toEqual([0, 0, 0, 255]);
  });

  it("重叠区域按合成顺序由后一个覆盖", () => {
    const original = solidImage(4, 4, [0, 0, 0, 255]);
    const first = compositeRgbaRegion(
      original,
      { width: 4, height: 4 },
      solidImage(2, 2, [255, 0, 0, 255]),
      { x: 1, y: 1, width: 2, height: 2 },
      new Uint8ClampedArray(4).fill(255),
    );
    const second = compositeRgbaRegion(
      first,
      { width: 4, height: 4 },
      solidImage(2, 2, [0, 255, 0, 255]),
      { x: 2, y: 2, width: 2, height: 2 },
      new Uint8ClampedArray(4).fill(255),
    );

    expect(getPixel(second, 4, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(getPixel(second, 4, 2, 2)).toEqual([0, 255, 0, 255]);
    expect(getPixel(second, 4, 3, 3)).toEqual([0, 255, 0, 255]);
  });
});
