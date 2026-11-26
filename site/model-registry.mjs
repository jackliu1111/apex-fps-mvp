export const DEFAULT_MODEL = 'efficientsed';
export const GUNSHOT_CLASSES = Object.freeze(['Gunshot, gunfire', 'Machine gun']);

const BUILTIN_MODELS = Object.freeze({
  efficientsed: {
    manifestUrl: '/assets/efficientsed/model.json',
    onnxUrl: '/assets/efficientsed/fmn10-tf256.onnx',
    frontendUrl: '/assets/efficientsed/frontend.json',
    frontendType: 'efficientsed',
    sampleRate: 16000,
    windowSeconds: 10,
    strideSeconds: 5,
    frameSeconds: 0.04,
    framesPerWindow: 250,
    hopFrames: 125,
    scoreType: 'frame',
    inputName: 'mel',
    inputShape: [1, 1, 128, 1000],
  },
});

function normalizeModelSpec(id, raw) {
  if (typeof id !== 'string' || !id.trim() || !raw || typeof raw !== 'object') {
    throw new Error(`模型注册配置无效：${String(id)}`);
  }
  const scoreType = raw.scoreType;
  if (scoreType !== 'frame') {
    throw new Error(`模型注册配置无效（scoreType）：${String(id)}`);
  }
  if (typeof raw.manifestUrl !== 'string' || !raw.manifestUrl || typeof raw.onnxUrl !== 'string' || !raw.onnxUrl) {
    throw new Error(`模型注册配置无效（资产路径）：${id}`);
  }
  if (raw.sampleRate !== 16000) {
    throw new Error(`模型注册配置无效（采样率）：${id}`);
  }
  if (typeof raw.inputName !== 'string' || !raw.inputName || !Array.isArray(raw.inputShape) || !raw.inputShape.length) {
    throw new Error(`模型注册配置无效（输入张量）：${id}`);
  }
  const frontendType = raw.frontendType || 'efficientsed';
  if (frontendType !== 'efficientsed') {
    throw new Error(`模型注册配置无效（前处理类型）：${id}`);
  }
  const windowSeconds = raw.windowSeconds ?? 10;
  const strideSeconds = raw.strideSeconds ?? 5;
  const frameSeconds = raw.frameSeconds ?? 0.04;
  const framesPerWindow = raw.framesPerWindow ?? 250;
  const hopFrames = raw.hopFrames ?? 125;
  const gunshotClasses = Object.freeze([...(raw.gunshotClasses || GUNSHOT_CLASSES)]);
  return Object.freeze({
    id,
    manifestUrl: raw.manifestUrl,
    onnxUrl: raw.onnxUrl,
    frontendUrl: raw.frontendUrl ?? null,
    frontendType,
    sampleRate: raw.sampleRate,
    windowSeconds,
    strideSeconds,
    frameSeconds,
    framesPerWindow,
    hopFrames,
    scoreType,
    inputName: raw.inputName,
    inputShape: Object.freeze([...raw.inputShape]),
    ...(typeof raw.outputName === 'string' && raw.outputName ? { outputName: raw.outputName } : {}),
    ...(Array.isArray(raw.outputShape) && raw.outputShape.length ? { outputShape: Object.freeze([...raw.outputShape]) } : {}),
    gunshotClasses,
  });
}

/** Create an extensible registry mapping model IDs to manifest, ONNX, and frontend specs. */
export function createModelRegistry(initial = BUILTIN_MODELS) {
  const specs = new Map();
  const register = (id, spec) => {
    const normalized = normalizeModelSpec(id, spec);
    specs.set(id, normalized);
    return normalized;
  };
  for (const [id, spec] of Object.entries(initial)) register(id, spec);
  return {
    register,
    has: (id) => specs.has(id),
    list: () => [...specs.keys()],
    get(id) {
      const spec = specs.get(id);
      if (!spec) throw new Error(`未知分析模型：${String(id)}`);
      return spec;
    },
  };
}

export const defaultModelRegistry = createModelRegistry();

export function getModelSpec(modelId, registry = defaultModelRegistry) {
  return registry.get(modelId);
}

/** Return a plain structured-clonable model spec safe to post across a Worker boundary. */
export function serializeSpec(spec) {
  return {
    id: spec.id,
    manifestUrl: spec.manifestUrl,
    onnxUrl: spec.onnxUrl,
    frontendUrl: spec.frontendUrl ?? null,
    frontendType: spec.frontendType || 'efficientsed',
    sampleRate: spec.sampleRate,
    windowSeconds: spec.windowSeconds,
    strideSeconds: spec.strideSeconds,
    frameSeconds: spec.frameSeconds,
    framesPerWindow: spec.framesPerWindow,
    hopFrames: spec.hopFrames,
    scoreType: spec.scoreType,
    inputName: spec.inputName,
    inputShape: Array.isArray(spec.inputShape) ? [...spec.inputShape] : [],
    ...(spec.outputName ? { outputName: spec.outputName } : {}),
    ...(Array.isArray(spec.outputShape) ? { outputShape: [...spec.outputShape] } : {}),
    ...(Array.isArray(spec.gunshotClasses) ? { gunshotClasses: [...spec.gunshotClasses] } : {}),
  };
}

/** Resolve absolute asset URLs for a registered model, honoring safe relative manifest.modelFile. */
export function resolveModelAssets(spec, manifest = null, baseUrl = 'http://localhost/') {
  const manifestUrl = new URL(spec.manifestUrl, baseUrl);
  let onnxUrl = new URL(spec.onnxUrl, baseUrl);
  if (manifest?.modelFile !== undefined) {
    const file = manifest.modelFile;
    if (typeof file !== 'string' || !file.trim() || /^[a-z]+:|^\//i.test(file) || file.split(/[\\/]/).includes('..')) {
      throw new Error(`模型文件路径无效：${String(file)}`);
    }
    onnxUrl = new URL(file, manifestUrl);
  }
  const frontendUrl = spec.frontendUrl ? new URL(spec.frontendUrl, baseUrl).href : null;
  return { manifestUrl: manifestUrl.href, onnxUrl: onnxUrl.href, frontendUrl };
}

/** Build an actionable user-facing recovery hint when model assets fail to load. */
export function assetRecoveryHint(status, missingTarget = '') {
  if (status === 404) {
    const at = missingTarget ? `（${missingTarget}）` : '';
    return `本地服务资产目录缺少该文件${at}，请检查 --assets 路径或按 README / MODEL-LAB.md 重建模型资产。`;
  }
  return '请检查本地服务与模型资产是否完整。';
}

const sameShape = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length
  && actual.every((dim, index) => dim === expected[index]);

/** Expected ONNX output tensor dimensions for a registered model and manifest class list. */
export function expectedOutputShape(spec, classCount) {
  return [1, spec.framesPerWindow, classCount];
}

/** Validate manifest structure, classes order/uniqueness, gunshot labels, and dimensions against a model spec. */
export function validateModelManifest(spec, manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('模型清单格式不匹配');
  const { classes } = manifest;
  if (!Array.isArray(classes) || !classes.length || classes.some((name) => typeof name !== 'string' || !name)) {
    throw new Error('模型类别清单无效');
  }
  if (new Set(classes).size !== classes.length) throw new Error('模型类别清单存在重复类别');
  if (manifest.sampleRate !== spec.sampleRate) {
    throw new Error(`模型清单采样率不匹配：期望 ${spec.sampleRate} Hz，实际 ${manifest.sampleRate}`);
  }
  if (manifest.scoreType !== undefined && manifest.scoreType !== spec.scoreType) {
    throw new Error(`模型清单分数类型不匹配：期望 ${spec.scoreType}，实际 ${manifest.scoreType}`);
  }
  if (manifest.windowSeconds !== undefined && manifest.windowSeconds !== spec.windowSeconds) {
    throw new Error(`模型清单窗口时长不匹配：期望 ${spec.windowSeconds}s，实际 ${manifest.windowSeconds}s`);
  }
  if (manifest.strideSeconds !== undefined && manifest.strideSeconds !== spec.strideSeconds) {
    throw new Error(`模型清单步长不匹配：期望 ${spec.strideSeconds}s，实际 ${manifest.strideSeconds}s`);
  }
  if (manifest.frameSeconds !== undefined && Math.abs(manifest.frameSeconds - spec.frameSeconds) > 1e-6) {
    throw new Error(`模型清单帧步长不匹配：期望 ${spec.frameSeconds}s，实际 ${manifest.frameSeconds}s`);
  }
  if (manifest.activation !== undefined && manifest.activation !== 'sigmoid') {
    throw new Error(`模型清单激活函数不支持：${manifest.activation}`);
  }
  if (manifest.inputName !== undefined && manifest.inputName !== spec.inputName) {
    throw new Error(`模型清单输入名称不匹配：期望 ${spec.inputName}，实际 ${manifest.inputName}`);
  }
  if (manifest.input !== undefined && !sameShape(manifest.input, spec.inputShape)) {
    throw new Error(`模型清单输入维度不匹配：期望 [${spec.inputShape.join(', ')}]`);
  }
  const outputShape = expectedOutputShape(spec, classes.length);
  if (manifest.output !== undefined && !sameShape(manifest.output, outputShape)) {
    throw new Error(`模型清单输出维度不匹配：期望 [${outputShape.join(', ')}]`);
  }
  const gunshotIndices = spec.gunshotClasses.map((name) => classes.indexOf(name));
  if (gunshotIndices.some((index) => index < 0)) {
    throw new Error('模型类别清单不匹配：缺少枪声类别');
  }
  return {
    gunshotIndices,
    scoreType: spec.scoreType,
    sampleRate: spec.sampleRate,
    frameSeconds: spec.frameSeconds,
    framesPerWindow: spec.framesPerWindow,
    hopFrames: spec.hopFrames,
    outputShape,
  };
}

/** Validate runtime inference tensor dimensions, element count, and probability range [0, 1]. */
export function validateInferenceOutput(spec, manifest, { values, dims } = {}) {
  const outputShape = expectedOutputShape(spec, manifest.classes.length);
  const expectedLength = outputShape.reduce((product, dim) => product * dim, 1);
  const label = '模型输出无效';
  if (Array.isArray(dims) && dims.length > 0 && !sameShape(dims, outputShape)) {
    throw new Error(`${label}：维度 [${dims.join(', ')}] 与清单 [${outputShape.join(', ')}] 不一致`);
  }
  if (!values || values.length !== expectedLength) {
    throw new Error(`${label}：输出长度 ${values?.length ?? 0} 与预期 ${expectedLength} 不一致`);
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`${label}：存在越界概率值`);
    }
  }
  return values;
}
