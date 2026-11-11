import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import sceneTemplate from './english-scene-prompt.txt?raw';
import { buildCharacterPrompt, buildPropPrompt, buildScenePrompt } from './english-prompts.mjs';
import './english-studio.css';

type Section = 'character' | 'scene' | 'prop';
type Role = { id: string; file: File; mapping: string };
const MAX_COUNT = 16;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const sections: { id: Section; number: string; title: string; subtitle: string }[] = [
  { id: 'character', number: '01', title: '人物', subtitle: '创建一致的角色形象' },
  { id: 'scene', number: '02', title: '场景', subtitle: '还原教材中的分镜' },
  { id: 'prop', number: '03', title: '道具', subtitle: '修改或补充画面内容' },
];

function Preview({ file, alt }: { file: File; alt: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return url ? <img src={url} alt={alt} /> : null;
}
function FileInput({ id, title, hint, file, onChange, disabled }: { id: string; title: string; hint: string; file: File | null; onChange: (file: File | null) => void; disabled: boolean }) {
  return <div className="eng-file-wrap">
    <label className={`eng-upload ${file ? 'has-file' : ''}`} htmlFor={id}>
      {file ? <Preview file={file} alt={file.name} /> : <span className="eng-upload-icon" aria-hidden="true">＋</span>}
      <span className="eng-upload-copy"><strong>{file ? file.name : title}</strong><small>{file ? '点击更换图片' : hint}</small></span>
      <input id={id} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { onChange(event.target.files?.[0] ?? null); event.target.value = ''; }} />
    </label>
    {file && <button type="button" className="eng-remove" disabled={disabled} onClick={() => onChange(null)}>移除</button>}
  </div>;
}
function fileError(files: File[]) {
  if (files.length > MAX_COUNT) return '最多上传 16 张图片。';
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return '仅支持 PNG、JPG 或 WebP 图片。';
  if (files.some(file => file.size > MAX_FILE)) return '单张图片不能超过 20MB。';
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL) return '参考图合计不能超过 40MB。';
  return '';
}

async function responseMessage(response: Response) {
  try { const payload = await response.json(); return payload.message || `请求失败（${response.status}）`; }
  catch { return `请求失败（${response.status}）`; }
}

export default function EnglishStudio() {
  const [section, setSection] = useState<Section>('character');
  const [mode, setMode] = useState<'extract' | 'direct'>('extract');
  const [species, setSpecies] = useState<'human' | 'animal'>('human');
  const [name, setName] = useState('');
  const [characterImage, setCharacterImage] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [characterEdit, setCharacterEdit] = useState('');
  const [sceneImage, setSceneImage] = useState<File | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [background, setBackground] = useState<File | null>(null);
  const [special, setSpecial] = useState('');
  const [propImage, setPropImage] = useState<File | null>(null);
  const [propReference, setPropReference] = useState<File | null>(null);
  const [propInstruction, setPropInstruction] = useState('');
  const [size, setSize] = useState('2048x1152');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<'extract' | 'generate' | null>(null);
  const [status, setStatus] = useState('准备就绪');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [partial, setPartial] = useState('');
  const [reviewPrompt, setReviewPrompt] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setModelError('');
    fetch('/api/image-models', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('无法获取模型列表');
      const data = await response.json();
      if (!Array.isArray(data.models) || !data.models.length) throw new Error('服务端未返回可用模型');
      setModels(data.models);
      setModel(data.models.includes(data.defaultModel) ? data.defaultModel : data.models[0]);
    }).catch(reason => { if (!controller.signal.aborted) setModelError(reason instanceof Error ? reason.message : '无法获取模型列表'); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => { const oldTitle = document.title; document.title = '英语图片工作台 · AI Image Studio'; return () => { document.title = oldTitle; controllerRef.current?.abort(); }; }, []);

  const prompt = useMemo(() => {
    try {
      if (section === 'character') return mode === 'extract' ? buildCharacterPrompt(description, species) : (characterEdit.trim() ? `请根据图片1修改角色形象，保持其他外貌特征、服装及画风不变。修改要求：${characterEdit.trim()}` : '');
      if (section === 'scene') return buildScenePrompt(sceneTemplate, roles.map(role => role.mapping), Boolean(background), special, ({ '2048x1152': '16:9', '1536x1024': '3:2', '1024x1024': '1:1', '1024x1536': '2:3', '1152x2048': '9:16', auto: '按原图' } as Record<string, string>)[size]);
      return buildPropPrompt(propInstruction, Boolean(propReference));
    } catch { return ''; }
  }, [section, mode, species, description, characterEdit, roles, background, special, propInstruction, size]);

  const validateAndSet = (setter: (file: File | null) => void) => (file: File | null) => {
    if (file) { const problem = fileError([file]); if (problem) { setError(problem); return; } }
    setError(''); setter(file);
  };
  const addRoles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []); event.target.value = '';
    const problem = fileError([...(sceneImage ? [sceneImage] : []), ...roles.map(role => role.file), ...files, ...(background ? [background] : [])]);
    if (problem) { setError(problem); return; }
    setError(''); setRoles(current => [...current, ...files.map(file => ({ id: crypto.randomUUID(), file, mapping: '' }))]);
  };
  const setTab = (next: Section) => { setSection(next); setError(''); setResult(''); setPartial(''); setStatus('准备就绪'); setReviewPrompt(false); };

  const extract = async () => {
    if (!characterImage) { setError('请先上传教材人物截图。'); return; }
    setError(''); setBusy('extract'); setStatus('正在提取人物特征…');
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const form = new FormData(); form.append('images', characterImage);
      const response = await fetch('/api/english/extract-character', { method: 'POST', body: form, signal: controller.signal });
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = await response.json();
      setDescription(data.description); setStatus('特征已提取，请人工检查并修改后再生成。');
    } catch (reason) {
      if (controller.signal.aborted) setStatus('已取消特征提取。');
      else { setError(reason instanceof Error ? reason.message : '特征提取失败'); setStatus('提取失败，可手动填写特征。'); }
    } finally { if (controllerRef.current === controller) controllerRef.current = null; setBusy(null); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    let files: File[];
    try {
      if (!model) throw new Error('请等待可用模型加载，或重试获取模型。');
      if (section === 'character') {
        if (!characterImage) throw new Error('请上传人物截图或角色图。');
        if (mode === 'extract' && !description.trim()) throw new Error('请先提取或手动填写并审核人物特征。');
        if (mode === 'direct' && !characterEdit.trim()) throw new Error('请填写角色修改要求。');
        files = [characterImage];
      } else if (section === 'scene') {
        if (!sceneImage) throw new Error('请上传教材场景原图。');
        if (roles.some(role => !role.mapping.trim())) throw new Error('请为每张角色图填写与场景人物的对应关系。');
        files = [sceneImage, ...roles.map(role => role.file), ...(background ? [background] : [])];
      } else {
        if (!propImage) throw new Error('请上传需要修改的场景图。');
        if (!propInstruction.trim()) throw new Error('请填写需要替换或补充的内容。');
        files = [propImage, ...(propReference ? [propReference] : [])];
      }
      const problem = fileError(files); if (problem) throw new Error(problem);
      if (!prompt || prompt.length > 16000) throw new Error('提示词为空或超过 16000 字符，请调整输入。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请检查输入'); return; }

    setBusy('generate'); setStatus('正在提交图片并等待生成…'); setResult(''); setPartial('');
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const data = new FormData(); data.append('prompt', prompt); data.append('model', model); data.append('size', size);
      files.forEach(file => data.append('images', file));
      const response = await fetch('/api/english/generate-image-stream', { method: 'POST', body: data, signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(await responseMessage(response));
      if (!response.body) throw new Error('服务器没有返回图片流。');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let gotFinal = false; let streamError = '';
      const handle = (block: string) => {
        let eventName = 'message'; const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) { if (line.startsWith('event:')) eventName = line.slice(6).trim(); if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart()); }
        if (!dataLines.length) return;
        let payload: any; try { payload = JSON.parse(dataLines.join('\n')); } catch { return; }
        if ((eventName === 'partial_image' || eventName === 'final_image' || eventName === 'done') && payload.image) {
          const image = /^(data:|https?:|blob:)/.test(payload.image) ? payload.image : `data:image/png;base64,${payload.image}`;
          if (eventName === 'partial_image') setPartial(image); else { gotFinal = true; setResult(image); }
        }
        if (eventName === 'error') streamError = [payload.message, payload.detail, payload.requestId ? `请求 ID：${payload.requestId}` : ''].filter(Boolean).join(' ');
        if ((eventName === 'status' || eventName === 'heartbeat') && payload.message) setStatus(payload.message);
      };
      while (true) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) { const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0]; handle(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + separator.length); boundary = buffer.search(/\r?\n\r?\n/); }
        if (done) break;
      }
      if (buffer.trim()) handle(buffer);
      if (streamError) throw new Error(streamError);
      if (!gotFinal) throw new Error('图片服务未返回最终结果，请重试。');
      setStatus('图片已生成，请对照教材原图检查细节。');
    } catch (reason) {
      if (controller.signal.aborted) setStatus('已取消本次生成。');
      else { setError(reason instanceof Error ? reason.message : '生成失败'); setStatus('生成失败，请检查提示后重试。'); }
    } finally { if (controllerRef.current === controller) controllerRef.current = null; setBusy(null); }
  };

  const info = sections.find(item => item.id === section)!;
  return <main className="english-app">
    <header className="eng-topbar"><a className="eng-brand" href="/generator"><span className="eng-brand-mark">✳</span><span>AI Image Studio <small>/ 英语工作台</small></span></a><a className="eng-back" href="/generator">返回原工作台 <span>↗</span></a></header>
    <div className="eng-intro"><div><p className="eng-eyebrow">ENGLISH IMAGE WORKSPACE <span> / 01—03</span></p><h1>让教材画面<span>活起来。</span></h1><p>从角色到场景，为每一帧准备一致、细致的视觉素材。</p></div><div className="eng-intro-note"><span>CREATIVE WORKFLOW</span><strong>角色一致 · 场景还原 · 细节可控</strong></div></div>
    <div className="eng-layout">
      <aside className="eng-sidebar" aria-label="工作流程"><p className="eng-side-label">选择创作任务</p>{sections.map(item => <button key={item.id} type="button" disabled={Boolean(busy)} onClick={() => setTab(item.id)} className={`eng-side-item ${section === item.id ? 'active' : ''}`} aria-pressed={section === item.id}><span className="eng-side-number">{item.number}</span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><span className="eng-arrow">↗</span></button>)}<div className="eng-side-tip"><span>✳</span><p><strong>每张图都值得细看</strong><br />生成后请对照教材检查人物、道具和场景细节。</p></div></aside>
      <form className="eng-config" onSubmit={submit}>
        <div className="eng-section-heading"><div><p className="eng-eyebrow">STEP {info.number} / CREATE</p><h2>{info.title}工作台</h2><p>{info.subtitle}</p></div><span className="eng-heading-icon">{section === 'character' ? '◉' : section === 'scene' ? '▧' : '✦'}</span></div>
        <label className="eng-label" htmlFor="eng-name">任务名称 <span>选填</span></label><input id="eng-name" className="eng-input" value={name} onChange={e => setName(e.target.value)} placeholder="给这次创作起个名字" disabled={Boolean(busy)} maxLength={80} />
        {section === 'character' && <>
          <div className="eng-segment"><button type="button" disabled={Boolean(busy)} className={mode === 'extract' ? 'active' : ''} onClick={() => setMode('extract')}>提取特征后生图</button><button type="button" disabled={Boolean(busy)} className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>直接修改角色</button></div>
          <div className="eng-block-title"><div><strong>上传参考图</strong><small>{mode === 'extract' ? '选择教材中的人物截图' : '选择需要修改的角色图'}</small></div><span>01</span></div>
          <FileInput id="eng-character" title="选择人物图片" hint="PNG、JPG、WebP · 最大 20MB" file={characterImage} onChange={validateAndSet(file => { setCharacterImage(file); setDescription(''); })} disabled={Boolean(busy)} />
          {mode === 'extract' ? <><div className="eng-row"><label className="eng-label" htmlFor="eng-description">人物特征 <span>请人工审核</span></label><button type="button" className="eng-text-button" onClick={() => void extract()} disabled={!characterImage || Boolean(busy)}>✦ {busy === 'extract' ? '提取中…' : '提取特征'}</button></div><textarea id="eng-description" className="eng-textarea" rows={8} value={description} onChange={e => setDescription(e.target.value)} placeholder="提取后请检查并修改描述，也可以手动填写人物或动物的外貌、衣着与配饰。" disabled={Boolean(busy)} maxLength={10000} /><div className="eng-choice"><span>角色类型</span><button type="button" className={species === 'human' ? 'active' : ''} onClick={() => setSpecies('human')} disabled={Boolean(busy)}>人物</button><button type="button" className={species === 'animal' ? 'active' : ''} onClick={() => setSpecies('animal')} disabled={Boolean(busy)}>带毛动物</button></div></> : <><label className="eng-label" htmlFor="eng-edit">修改要求</label><textarea id="eng-edit" className="eng-textarea" rows={5} value={characterEdit} onChange={e => setCharacterEdit(e.target.value)} placeholder="例如：把外套换成宽松的蓝色运动服，保留其他形象细节。" disabled={Boolean(busy)} maxLength={10000} /></>}
        </>}
        {section === 'scene' && <>
          <div className="eng-block-title"><div><strong>场景原图</strong><small>构图、动作与物体的主要依据</small></div><span>01</span></div><FileInput id="eng-scene" title="选择教材场景图" hint="支持截图或原始插画" file={sceneImage} onChange={validateAndSet(setSceneImage)} disabled={Boolean(busy)} />
          <div className="eng-block-title"><div><strong>角色参考图 <em>选填</em></strong><small>每张角色图都需要填写对应关系</small></div><span>02</span></div>
          <div className="eng-roles">{roles.map((role, index) => <div className="eng-role" key={role.id}><div className="eng-role-image"><Preview file={role.file} alt={role.file.name} /></div><div className="eng-role-fields"><strong>图片 {index + 2} <small>{role.file.name}</small></strong><input className="eng-input" aria-label={`图片 ${index + 2} 对应角色`} value={role.mapping} placeholder="例如：画面左侧的黑发小女孩" disabled={Boolean(busy)} onChange={e => setRoles(current => current.map(item => item.id === role.id ? { ...item, mapping: e.target.value } : item))} /></div><button className="eng-remove" type="button" disabled={Boolean(busy)} onClick={() => setRoles(current => current.filter(item => item.id !== role.id))}>移除</button></div>)}</div>
          <label className="eng-add-role" htmlFor="eng-roles">＋ 添加角色图<input id="eng-roles" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={addRoles} disabled={Boolean(busy)} /></label>
          <div className="eng-block-title"><div><strong>背景参考 <em>选填</em></strong><small>用于前后场景的环境连续性</small></div><span>03</span></div><FileInput id="eng-background" title="选择背景参考图" hint="可以使用已完成的场景图" file={background} onChange={validateAndSet(setBackground)} disabled={Boolean(busy)} />
          <label className="eng-label" htmlFor="eng-special">特别要求 <span>优先于默认提示词</span></label><textarea id="eng-special" className="eng-textarea" rows={5} value={special} onChange={e => setSpecial(e.target.value)} placeholder="先写最重要的要求，例如：保留黑板上的 HELLO、去除气泡……" disabled={Boolean(busy)} maxLength={7000} />
          <p className="eng-hint">默认去除教材文字和对话框，保留思考气泡；文字类道具保留模糊的色块和轮廓。</p>
        </>}
        {section === 'prop' && <><div className="eng-block-title"><div><strong>待修改场景</strong><small>上传已经生成的场景图</small></div><span>01</span></div><FileInput id="eng-prop" title="选择场景图片" hint="PNG、JPG、WebP · 最大 20MB" file={propImage} onChange={validateAndSet(setPropImage)} disabled={Boolean(busy)} /><div className="eng-block-title"><div><strong>道具参考图 <em>选填</em></strong><small>用于参考需要加入或替换的道具</small></div><span>02</span></div><FileInput id="eng-prop-ref" title="选择道具图片" hint="可上传一张道具参考图" file={propReference} onChange={validateAndSet(setPropReference)} disabled={Boolean(busy)} /><label className="eng-label" htmlFor="eng-prop-instruction">修改要求</label><textarea id="eng-prop-instruction" className="eng-textarea" rows={6} value={propInstruction} onChange={e => setPropInstruction(e.target.value)} placeholder="描述要替换或补充的内容，以及需要保持不变的细节。" disabled={Boolean(busy)} maxLength={10000} /></>}
        <div className="eng-settings"><label>图片模型<select value={model} onChange={e => setModel(e.target.value)} disabled={Boolean(busy) || !models.length}>{!models.length && <option value="">{modelError ? '获取失败' : '正在获取…'}</option>}{models.map(item => <option key={item}>{item}</option>)}</select></label><label>输出尺寸<select value={size} onChange={e => setSize(e.target.value)} disabled={Boolean(busy)}><option value="2048x1152">16:9 · 横版</option><option value="1536x1024">3:2 · 横版</option><option value="1024x1024">1:1 · 方形</option><option value="1024x1536">2:3 · 竖版</option><option value="1152x2048">9:16 · 竖版</option><option value="auto">自动</option></select></label></div>
        {modelError && <p className="eng-error">{modelError} <button type="button" className="eng-text-button" onClick={() => setReload(v => v + 1)}>重试</button></p>}
        <div className="eng-prompt-preview"><button type="button" onClick={() => setReviewPrompt(value => !value)} aria-expanded={reviewPrompt}>查看实际提示词 <span>{reviewPrompt ? '−' : '+'}</span></button>{reviewPrompt && <pre>{prompt || '请先完成必填内容。'}</pre>}</div>
        {error && <p className="eng-error" role="alert">{error}</p>}
        <button className="eng-generate" type="submit" disabled={Boolean(busy) || !model}>{busy === 'generate' ? '正在生成…' : `生成${info.title}图片`} <span>↗</span></button>{busy && <button type="button" className="eng-cancel" onClick={() => controllerRef.current?.abort()}>取消当前请求</button>}
        <p className="eng-footnote">最多 16 张参考图 · 单张 20MB · 合计 40MB</p>
      </form>
      <section className="eng-result" aria-live="polite"><div className="eng-result-heading"><div><p className="eng-eyebrow">YOUR CREATION</p><h2>创作预览</h2></div><span className="eng-status-dot">{busy ? '生成中' : result ? '已完成' : '等待生成'}</span></div><div className={`eng-canvas ${result || partial ? 'has-image' : ''}`}>{result || partial ? <img src={result || partial} alt={result ? `${name || info.title}生成结果` : '生成中的预览'} /> : <div className="eng-empty"><span className="eng-empty-art"><i />✳</span><strong>灵感，即将成形</strong><p>完成左侧配置，生成的图片将显示在这里。</p></div>}</div><div className="eng-result-bottom"><div><strong>{name || `${info.title}图片`}</strong><p>{status}</p></div>{result && <a className="eng-download" href={result} download={`${name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'english-image'}.${result.startsWith('data:image/jpeg') ? 'jpg' : result.startsWith('data:image/webp') ? 'webp' : 'png'}`}>下载图片 ↓</a>}</div><div className="eng-check"><span>CHECK BEFORE EXPORT</span><p>人物外貌和动作 · 道具颜色与数量 · 背景与前后画面一致</p></div></section>
    </div>
    <footer className="eng-footer"><span>AI IMAGE STUDIO</span><span>MADE FOR EVERY LITTLE DETAIL ✳</span></footer>
  </main>;
}
