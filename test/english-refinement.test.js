const { test } = require('node:test');
const assert = require('node:assert/strict');

test('masked compositing preserves every unselected pixel including alpha', async () => {
  const { compositeMaskedPixels } = await import('../frontend/src/english-refinement.mjs');
  const base = new Uint8ClampedArray([12, 34, 56, 255, 80, 90, 100, 120, 1, 2, 3, 255]);
  const edited = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255]);
  const result = compositeMaskedPixels(base, edited, new Uint8ClampedArray([0, 255, 0]));
  assert.deepEqual([...result], [12, 34, 56, 255, 0, 255, 0, 255, 1, 2, 3, 255]);
  assert.deepEqual([...base], [12, 34, 56, 255, 80, 90, 100, 120, 1, 2, 3, 255]);
});

test('projective transform maps all four corners and rejects folded quadrilaterals', async () => {
  const { homographyForQuad, projectPoint, isValidQuad } = await import('../frontend/src/english-refinement.mjs');
  const quad = [{ x: 10, y: 20 }, { x: 120, y: 5 }, { x: 100, y: 130 }, { x: 0, y: 100 }];
  const matrix = homographyForQuad(quad);
  for (const [i, point] of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].entries()) {
    const actual = projectPoint(matrix, point);
    assert.ok(Math.abs(actual.x - quad[i].x) < 1e-8);
    assert.ok(Math.abs(actual.y - quad[i].y) < 1e-8);
  }
  assert.equal(isValidQuad(quad), true);
  assert.equal(isValidQuad([quad[0], quad[2], quad[1], quad[3]]), false);
  assert.throws(() => homographyForQuad([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]));
});

test('project import rejects remote images, excessive dimensions and invalid transforms', async () => {
  const { validateProject } = await import('../frontend/src/english-refinement.mjs');
  const layer = { id: 'base', name: '底图', image: 'data:image/png;base64,aGVsbG8=', visible: true, locked: true, opacity: 1, quad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] };
  const project = { version: 1, width: 100, height: 80, layers: [layer], landmarks: [], reference: '' };
  assert.equal(validateProject(project), project);
  assert.throws(() => validateProject({ ...project, width: 100000 }));
  assert.throws(() => validateProject({ ...project, layers: [{ ...layer, image: 'https://example.com/image.png' }] }));
  assert.throws(() => validateProject({ ...project, layers: [{ ...layer, quad: layer.quad.map(() => ({ x: 0, y: 0 })) }] }));
});

test('landmark report measures correspondence without inventing an overall similarity score', async () => {
  const { landmarkReport } = await import('../frontend/src/english-refinement.mjs');
  const report = landmarkReport([{ id: 'hand', name: '手', original: { x: 100, y: 100 }, result: { x: 110, y: 100 } }, { id: 'foot', name: '脚', original: { x: 200, y: 300 }, result: null }], 1000, 500);
  assert.equal(report.completed, 1);
  assert.equal(report.total, 2);
  assert.equal(report.points[0].pixels, 10);
  assert.equal(report.points[0].percent, 1);
  assert.equal(Object.hasOwn(report, 'similarity'), false);
});

test('editing geometry fits nonstandard storyboard dimensions without stretching or cropping', async () => {
  const { editCanvasGeometry } = await import('../frontend/src/english-refinement.mjs');
  const geometry = editCanvasGeometry(952, 614);
  assert.equal(geometry.width % 16, 0);
  assert.equal(geometry.height % 16, 0);
  assert.ok(geometry.width * geometry.height >= 655360);
  assert.ok(geometry.width <= 3840 && geometry.height <= 3840);
  assert.equal(geometry.contentWidth / geometry.contentHeight, 952 / 614);
  assert.ok(geometry.x >= 0 && geometry.y >= 0);
  assert.throws(() => editCanvasGeometry(8000, 100));
});

test('full selection replaces transparent pixels instead of accumulating base alpha', async () => {
  const { compositeMaskedPixels } = await import('../frontend/src/english-refinement.mjs');
  const base = new Uint8ClampedArray([20, 40, 60, 127, 100, 90, 80, 255]);
  const edited = new Uint8ClampedArray([20, 40, 60, 127, 0, 0, 0, 0]);
  assert.deepEqual([...compositeMaskedPixels(base, edited, new Uint8ClampedArray([255, 255]))], [...edited]);
});
