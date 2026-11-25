import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { editCanvasGeometry, isValidQuad, landmarkReport, rectangleQuad, validateProject } from './english-refinement.mjs';
import { canvas, context, downloadBlob, fileData, loadDraft, loadImage, maskBounds, newProject, normalizedImage, pngBlob, readImageStream, regionalLayer, renderProject, saveDraft, upstreamMask } from './english-refinement-canvas';
import type { Layer, Point, Project } from './english-refinement-canvas';
import './english-refinement.css';

type Tool = 'rect' | 'brush' | 'erase' | 'polygon' | 'transform' | 'landmark';
type Props = { result: string; original: File | null; references: File[]; model: string; disabled: boolean; name: string };

export default function EnglishRefinement({ result, original, references, model, disabled, name }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const current = useRef<Project | null>(null);
  const [selected, setSelected] = useState('');
  const [tool, setTool] = useState<Tool>('rect');
  const [brush, setBrush] = useState(30);
  const [zoom, setZoom] = useState(100);
  const [overlay, setOverlay] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [difference, setDifference] = useState(false);
  const [revision, setRevision] = useState(0);
  const [polygon, setPolygon] = useState<Point[]>([]);
  const [preview, setPreview] = useState<Point[] | null>(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('导入已有图片，或把生成结果送入精修。');
  const [error, setError] = useState('');
  const [draftState, setDraftState] = useState('');
  const [undoStack, setUndoStack] = useState<{ project: Project; label: string }[]>([]);
  const [redoStack, setRedoStack] = useState<{ project: Project; label: string }[]>([]);
  const [pointName, setPointName] = useState('');
  const [activePoint, setActivePoint] = useState('');
  const [pointSide, setPointSide] = useState<'original' | 'result'>('original');
  const output = useRef<HTMLCanvasElement>(null);
  const mask = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ start: Point; last: Point; quad?: Point[]; corner?: number; project?: Project } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const redraw = useRef(0);
  const saving = useRef(Promise.resolve());
  const editDisabled = busy || disabled;

  const update = (next: Project) => { current.current = next; setProject(next); };
  const commit = (next: Project, label: string) => {
    validateProject(next);
    const previous = current.current;
    if (previous) setUndoStack(items => [...items.slice(-11), { project: previous, label }]);
    setRedoStack([]); update(next);
  };
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : '操作失败');
  const work = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); try { await action(); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };
  const resetSelection = () => { if (mask.current) context(mask.current).clearRect(0, 0, mask.current.width, mask.current.height); setPolygon([]); setPreview(null); setRevision(v => v + 1); };
  const adopt = async (source: string) => {
    const next = await newProject(source); resetSelection(); update(next); setSelected(next.layers[0].id); setUndoStack([]); setRedoStack([]); setOverlay(0); setShowOriginal(false); setDifference(false); setMessage('底图已载入；可圈选局部、合成修正或导入图层。');
  };
  useEffect(() => {
    if (!project) return;
    mask.current = canvas(project.width, project.height); setPolygon([]); setPreview(null); setRevision(v => v + 1);
  }, [project?.width, project?.height]);
  useEffect(() => () => { abort.current?.abort(); redraw.current++; }, []);
  useEffect(() => {
    if (!project) return;
    setDraftState('保存中…');
    const timer = setTimeout(() => {
      saving.current = saving.current.catch(() => {}).then(() => saveDraft(project)).then(() => setDraftState('草稿已保存在本机')).catch(() => setDraftState('草稿保存失败，请下载工程备份'));
    }, 600);
    return () => clearTimeout(timer);
  }, [project]);
  useEffect(() => {
    const token = ++redraw.current;
    if (!project || !output.current) return;
    void (async () => {
      const merged = await renderProject(project); if (token !== redraw.current || !output.current) return;
      const target = output.current; target.width = project.width; target.height = project.height;
      const ctx = context(target); ctx.drawImage(merged, 0, 0);
      if (project.reference && (overlay || showOriginal || difference || (tool === 'landmark' && pointSide === 'original'))) {
        const reference = await loadImage(project.reference); if (token !== redraw.current) return;
        ctx.save(); ctx.globalAlpha = showOriginal || difference || (tool === 'landmark' && pointSide === 'original') ? 1 : overlay / 100;
        if (difference) ctx.globalCompositeOperation = 'difference'; ctx.drawImage(reference, 0, 0, project.width, project.height); ctx.restore();
      }
      if (mask.current) {
        const tinted = canvas(project.width, project.height), tint = context(tinted); tint.drawImage(mask.current, 0, 0); tint.globalCompositeOperation = 'source-in'; tint.fillStyle = 'rgba(242,166,45,.45)'; tint.fillRect(0, 0, project.width, project.height); ctx.drawImage(tinted, 0, 0);
      }
      const scale = project.width / (target.clientWidth || project.width);
      const drawLine = (points: Point[], closed: boolean, color: string) => { if (!points.length) return; ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2 * scale; ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); if (closed) ctx.closePath(); ctx.stroke(); ctx.restore(); };
      if (preview) drawLine(preview, true, '#f29a21'); if (polygon.length) drawLine(polygon, false, '#f29a21');
      const layer = project.layers.find(item => item.id === selected);
      if (tool === 'transform' && layer && !layer.locked) { drawLine(layer.quad, true, '#398cde'); layer.quad.forEach((p, i) => { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#287bce'; ctx.lineWidth = 2 * scale; ctx.beginPath(); ctx.arc(p.x, p.y, 6 * scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#287bce'; ctx.font = `${12*scale}px sans-serif`; ctx.fillText(String(i+1), p.x+9*scale, p.y-9*scale); }); }
      for (const item of project.landmarks) for (const side of ['original', 'result'] as const) {
        const p = item[side]; if (!p) continue; ctx.fillStyle = side === 'original' ? '#ef941c' : '#2786de'; ctx.beginPath(); ctx.arc(p.x, p.y, 4*scale, 0, Math.PI*2); ctx.fill(); ctx.font=`${12*scale}px sans-serif`; ctx.fillText(`${item.name}·${side==='original'?'原':'成'}`,p.x+7*scale,p.y-7*scale);
      }
    })().catch(fail);
  }, [project, selected, overlay, showOriginal, difference, revision, preview, polygon, tool, pointSide, zoom]);

  const undo = () => {
    const entry=undoStack.at(-1); if (!entry || !current.current) return;
    const previous=current.current;
    setRedoStack(items=>[...items,{project:previous,label:entry.label}]);setUndoStack(items=>items.slice(0,-1));update(entry.project);setMessage(`已撤销：${entry.label}`);
  };
  const redo = () => {
    const entry=redoStack.at(-1);if(!entry||!current.current)return;
    const previous=current.current;
    setUndoStack(items=>[...items,{project:previous,label:entry.label}]);setRedoStack(items=>items.slice(0,-1));update(entry.project);setMessage(`已重做：${entry.label}`);
  };
  const coordinate = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect=event.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(project!.width,(event.clientX-rect.left)/rect.width*project!.width)),y:Math.max(0,Math.min(project!.height,(event.clientY-rect.top)/rect.height*project!.height))};
  };
  const paint = (a:Point,b:Point) => {
    if(!mask.current)return;const ctx=context(mask.current);ctx.save();ctx.globalCompositeOperation=tool==='erase'?'destination-out':'source-over';ctx.strokeStyle='#fff';ctx.fillStyle='#fff';ctx.lineWidth=brush;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.beginPath();ctx.arc(b.x,b.y,brush/2,0,Math.PI*2);ctx.fill();ctx.restore();setRevision(v=>v+1);
  };
  const pointerDown = (event:ReactPointerEvent<HTMLCanvasElement>) => {
    if(!project||editDisabled)return;event.preventDefault();const p=coordinate(event);setError('');
    if(tool==='polygon'){setPolygon(points=>[...points,p]);return;}
    if(tool==='landmark'){
      if(pointSide==='original'&&!project.reference){setError('请先导入分镜对照原图');return;}
      if(!activePoint){setError('先添加或选择一个关键点');return;}
      commit({...project,landmarks:project.landmarks.map(item=>item.id===activePoint?{...item,[pointSide]:p}:item)},'标记关键点');return;
    }
    if(tool==='transform'){
      const layer=project.layers.find(item=>item.id===selected);if(!layer||layer.locked){setError('先选择一个未锁定的局部图层');return;}
      const threshold=16*project.width/event.currentTarget.clientWidth;
      const corner=layer.quad.findIndex(item=>Math.hypot(item.x-p.x,item.y-p.y)<threshold);
      drag.current={start:p,last:p,quad:layer.quad.map(item=>({...item})),corner,project};
    }else{drag.current={start:p,last:p};if(tool==='brush'||tool==='erase')paint(p,p);}
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event:ReactPointerEvent<HTMLCanvasElement>) => {
    const state=drag.current;if(!state||!current.current)return;const p=coordinate(event);
    if(tool==='rect'){const x=Math.min(state.start.x,p.x),y=Math.min(state.start.y,p.y);setPreview(rectangleQuad(x,y,Math.abs(p.x-state.start.x),Math.abs(p.y-state.start.y)));}
    else if(tool==='brush'||tool==='erase')paint(state.last,p);
    else if(tool==='transform'&&state.quad){
      const quad=state.quad.map((item,index)=>state.corner===-1?{x:item.x+p.x-state.start.x,y:item.y+p.y-state.start.y}:index===state.corner?p:item);
      if(isValidQuad(quad))update({...current.current,layers:current.current.layers.map(item=>item.id===selected?{...item,quad}:item)});
    }
    state.last=p;
  };
  const pointerUp = (event:ReactPointerEvent<HTMLCanvasElement>) => {
    const state=drag.current;if(!state||!project)return;const p=coordinate(event);
    if(tool==='rect'&&mask.current){const ctx=context(mask.current);ctx.fillStyle='#fff';ctx.fillRect(Math.min(state.start.x,p.x),Math.min(state.start.y,p.y),Math.abs(p.x-state.start.x),Math.abs(p.y-state.start.y));setPreview(null);setRevision(v=>v+1);}
    if(tool==='transform'&&state.project&&current.current!==state.project){setUndoStack(items=>[...items.slice(-11),{project:state.project!,label:'移动或透视变形'}]);setRedoStack([]);}
    drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const finishPolygon = () => {if(polygon.length<3||!mask.current)return;const ctx=context(mask.current);ctx.fillStyle='#fff';ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fill();setPolygon([]);setRevision(v=>v+1);};
  const changeLayer = (changes:Partial<Layer>) => {if(project)commit({...project,layers:project.layers.map(item=>item.id===selected?{...item,...changes}:item)},'调整图层');};
  const addLayer = (layer:Layer,label:string) => {if(!current.current)return;if(current.current.layers.length>=24)throw new Error('最多保留24个图层，请先合并或删除部分图层');commit({...current.current,layers:[...current.current.layers,layer]},label);setSelected(layer.id);};
  const addRegion = () => void work(async()=>{if(!project||!mask.current)return;addLayer(regionalLayer(await renderProject(project),mask.current,`局部 ${project.layers.length}`),'复制选区');resetSelection();setTool('transform');setMessage('选区已复制为独立图层；拖动四角或输入坐标调整。原位置仍保留底图内容。');});
  const importPatch = (file:File) => void work(async()=>{
    if(!project||!mask.current||!maskBounds(mask.current))throw new Error('先圈选需要替换的区域');
    const patch=await loadImage(await fileData(file)), full=canvas(project.width,project.height);
    if(patch.width!==project.width||patch.height!==project.height)throw new Error(`修订图必须与画布同尺寸（${project.width}×${project.height}），以免位置错位`);
    context(full).drawImage(patch,0,0);addLayer(regionalLayer(full,mask.current,`导入修正 ${project.layers.length}`,true),'合成局部修订');resetSelection();setMessage('已按选区合成修订图，选区外保留原画面。');
  });
  const refine = () => void work(async()=>{
    if(!project||!mask.current||!maskBounds(mask.current))throw new Error('先圈选需要修正的区域');
    if(!model)throw new Error('图片模型尚未加载');if(!instruction.trim())throw new Error('请填写局部修改要求');if(project.layers.length>=24)throw new Error('图层已达上限，请先合并图层');
    const sourceProject=project, selection=canvas(project.width,project.height);context(selection).drawImage(mask.current,0,0);
    const merged=await renderProject(project), data=new FormData(), geometry=editCanvasGeometry(project.width,project.height);
    const prepared=canvas(geometry.width,geometry.height), preparedMask=canvas(geometry.width,geometry.height);
    const preparedContext=context(prepared);preparedContext.fillStyle='#fff';preparedContext.fillRect(0,0,prepared.width,prepared.height);
    preparedContext.drawImage(merged,geometry.x,geometry.y,geometry.contentWidth,geometry.contentHeight);
    context(preparedMask).drawImage(selection,geometry.x,geometry.y,geometry.contentWidth,geometry.contentHeight);
    data.append('prompt',`图片1为待编辑场景，透明蒙版区域为本次允许修改的范围。仅修改该区域中的细节，保持角色身份、构图、透视、相对位置和光照一致，不重排画面。后续图片仅供外观或动作参考。\n修改要求：${instruction.trim()}`);
    data.append('model',model);data.append('size',`${geometry.width}x${geometry.height}`);data.append('images',await pngBlob(prepared),'base.png');
    data.append('mask',await pngBlob(upstreamMask(preparedMask)),'mask.png');
    for(const file of references.slice(0,15))data.append('images',file);
    const bytes=[...data.values()].filter(v=>v instanceof Blob) as Blob[];
    if(bytes.some(file=>file.size>20*1024*1024)||bytes.reduce((total,file)=>total+file.size,0)>40*1024*1024)throw new Error('底图、蒙版与参考图合计需小于40MB，单张小于20MB');
    const controller=new AbortController();abort.current=controller;setMessage('正在提交局部精修…');
    try{
      const response=await fetch('/api/english/refine-image-stream',{method:'POST',body:data,signal:controller.signal});
      const image=await loadImage(await readImageStream(response,setMessage,controller.signal));if(controller.signal.aborted)return;
      if(image.width!==geometry.width||image.height!==geometry.height)throw new Error('模型未按请求返回指定尺寸，未合成当前工程，请重试或导入同尺寸修订图。');
      if(current.current!==sourceProject)throw new Error('请求期间工程已变化，未覆盖当前工程');
      const full=canvas(project.width,project.height);context(full).drawImage(image,geometry.x,geometry.y,geometry.contentWidth,geometry.contentHeight,0,0,project.width,project.height);addLayer(regionalLayer(full,selection,`AI修正 ${project.layers.length}`,true),'局部AI修正');resetSelection();setMessage('局部结果已合成；选区外由本地合成保留，请检查选区内细节。');
    }catch(reason){if(controller.signal.aborted)setMessage('已取消精修，原工程已保留。');else throw reason;}finally{abort.current=null;}
  });

  const layer=project?.layers.find(item=>item.id===selected);
  const report=project?landmarkReport(project.landmarks,project.width,project.height):null;
  return <section className="eng-refinement" aria-label="分镜精修工作台" id="english-refinement">
    <div className="eng-refine-heading"><div><p className="eng-eyebrow">REFINE & COMPARE</p><h2>分镜精修</h2><p>局部修改、构图校正和成图检查</p></div><span>{draftState}</span></div>
    <div className="eng-refine-actions">
      <button type="button" disabled={!result||editDisabled} onClick={()=>void work(()=>adopt(result))}>载入生成结果</button>
      <label className="eng-refine-file">导入底图<input type="file" accept="image/png,image/jpeg,image/webp" disabled={editDisabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void work(async()=>adopt(await fileData(file)));}} /></label>
      <label className="eng-refine-file">打开工程<input type="file" accept="application/json,.json" disabled={editDisabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void work(async()=>{if(file.size>80*1024*1024)throw new Error('工程文件超过80MB');const next=validateProject(JSON.parse(await file.text()));await Promise.all(next.layers.map((item:Layer)=>loadImage(item.image)));update(next);setSelected(next.layers[0].id);setUndoStack([]);setRedoStack([]);resetSelection();setMessage('工程已恢复');});}} /></label>
      <button type="button" disabled={editDisabled} onClick={()=>void work(async()=>{const next=await loadDraft();if(!next)throw new Error('本机还没有精修草稿');validateProject(next);update(next);setSelected(next.layers[0].id);setUndoStack([]);setRedoStack([]);resetSelection();setMessage('本机草稿已恢复');})}>恢复本机草稿</button>
      {project&&<><button type="button" disabled={editDisabled} onClick={()=>downloadBlob(new Blob([JSON.stringify(project)],{type:'application/json'}),`${name||'分镜精修'}.english.json`)}>保存工程</button><button type="button" className="primary" disabled={editDisabled} onClick={()=>void work(async()=>{downloadBlob(await pngBlob(await renderProject(project)),`${name||'分镜精修'}-final.png`);setMessage('最终PNG已导出（不含蒙版、控制点或对照标记）');})}>导出最终PNG</button></>}
    </div>
    {!project?<div className="eng-refine-empty">载入一张待处理图片后，即可开始精修。已有成图也可以直接导入。</div>:<>
      <div className="eng-refine-toolbar" role="toolbar" aria-label="精修工具">
        {([['rect','矩形选区'],['brush','涂抹选区'],['erase','擦除选区'],['polygon','多边形选区'],['transform','移动 / 四角变形'],['landmark','关键点对照']] as [Tool,string][]).map(([value,label])=><button type="button" key={value} aria-pressed={tool===value} disabled={editDisabled} onClick={()=>{setTool(value);setPolygon([]);setPreview(null);}}>{label}</button>)}
        <button type="button" disabled={editDisabled} onClick={resetSelection}>清空选区</button>
        <button type="button" disabled={!undoStack.length||editDisabled} onClick={undo}>撤销</button><button type="button" disabled={!redoStack.length||editDisabled} onClick={redo}>重做</button>
      </div>
      {(tool==='brush'||tool==='erase')&&<label className="eng-refine-inline">笔刷直径<input type="range" min="2" max="200" value={brush} disabled={editDisabled} onChange={e=>setBrush(Number(e.target.value))}/>{brush}px</label>}
      {tool==='polygon'&&<div className="eng-refine-inline"><span>依次点击轮廓，至少3点。</span><button type="button" disabled={polygon.length<3||editDisabled} onClick={finishPolygon}>完成多边形选区</button></div>}
      <div className="eng-refine-body"><div className="eng-refine-main">
        <div className="eng-refine-viewbar"><span>{project.width} × {project.height}</span><label>显示缩放<select aria-label="精修缩放" value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[50,100,150,200,300].map(v=><option key={v} value={v}>{v===100?'适合宽度':`${v}%`}</option>)}</select></label></div>
        <div className="eng-refine-viewport"><canvas ref={output} aria-label="精修画布" style={{width:`${zoom}%`,touchAction:'none'}} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}/></div>
        <div className="eng-refine-compare">
          <label className="eng-refine-file">导入对照原图<input type="file" accept="image/png,image/jpeg,image/webp" disabled={editDisabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void work(async()=>{const image=await loadImage(await fileData(file)), prepared=canvas(project.width,project.height),ctx=context(prepared),scale=Math.min(project.width/image.width,project.height/image.height);ctx.drawImage(image,(project.width-image.width*scale)/2,(project.height-image.height*scale)/2,image.width*scale,image.height*scale);commit({...project,reference:prepared.toDataURL('image/png')},'设置对照原图');setOverlay(50);setMessage('原图按比例居中对齐；画幅不同的区域保留透明，不拉伸原图。');});}}/></label>
          <button type="button" disabled={!original||editDisabled} onClick={()=>void work(async()=>{const source=await loadImage(await fileData(original!)),prepared=canvas(project.width,project.height),scale=Math.min(project.width/source.width,project.height/source.height);context(prepared).drawImage(source,(project.width-source.width*scale)/2,(project.height-source.height*scale)/2,source.width*scale,source.height*scale);commit({...project,reference:prepared.toDataURL('image/png')},'使用分镜原图');setOverlay(50);})}>使用上方分镜原图</button>
          <label>原图叠加 <input type="range" min="0" max="100" value={overlay} disabled={!project.reference} onChange={e=>{setOverlay(Number(e.target.value));setShowOriginal(false);setDifference(false);}}/>{overlay}%</label>
          <button type="button" disabled={!project.reference} aria-pressed={showOriginal} onClick={()=>{setShowOriginal(v=>!v);setDifference(false);}}>原图 / 成图</button><button type="button" disabled={!project.reference} aria-pressed={difference} onClick={()=>{setDifference(v=>!v);setShowOriginal(false);}}>差异叠图</button>
        </div>
        {tool==='landmark'&&<div className="eng-refine-points"><strong>关键点对照</strong><p>为同一关节或道具分别标记原图点和成图点；偏差以画布长边为基准，不代表整体还原度评分。</p><div className="eng-refine-inline"><input aria-label="关键点名称" placeholder="例如：老师举起的手腕" maxLength={60} value={pointName} onChange={e=>setPointName(e.target.value)}/><button type="button" disabled={editDisabled||!pointName.trim()} onClick={()=>{const id=crypto.randomUUID();commit({...project,landmarks:[...project.landmarks,{id,name:pointName.trim(),original:null,result:null}]},'添加关键点');setActivePoint(id);setPointName('');}}>添加关键点</button><label>标记对象<select aria-label="标记对象" value={pointSide} onChange={e=>{setPointSide(e.target.value as 'original'|'result');setOverlay(0);setShowOriginal(false);setDifference(false);}}><option value="original">原图位置</option><option value="result">成图位置</option></select></label></div><ul>{project.landmarks.map(item=><li key={item.id}><button type="button" aria-pressed={activePoint===item.id} onClick={()=>setActivePoint(item.id)}>{item.name}</button><span>{item.original?'原✓':'原—'} / {item.result?'成✓':'成—'} {report?.points.find((p:{id:string})=>p.id===item.id)?.percent.toFixed(2)??'—'}%</span><button type="button" disabled={editDisabled} onClick={()=>commit({...project,landmarks:project.landmarks.filter(p=>p.id!==item.id)},'移除关键点')}>移除</button></li>)}</ul><small>已配对 {report?.completed} / {report?.total}</small></div>}
      </div><aside className="eng-refine-panel">
        <h3>图层</h3><ul className="eng-layer-list">{[...project.layers].reverse().map(item=><li key={item.id} className={selected===item.id?'selected':''}><button type="button" disabled={editDisabled} aria-label={`${item.visible?'隐藏':'显示'}${item.name}`} onClick={()=>commit({...project,layers:project.layers.map(p=>p.id===item.id?{...p,visible:!p.visible}:p)},'切换图层显示')}>{item.visible?'◉':'○'}</button><button type="button" disabled={editDisabled} className="eng-layer-name" onClick={()=>setSelected(item.id)}>{item.name}{item.locked?' 🔒':''}</button></li>)}</ul>
        <div className="eng-refine-panel-actions"><button type="button" disabled={editDisabled} onClick={addRegion}>复制选区为图层</button><label className="eng-refine-file">导入透明图层<input type="file" accept="image/png,image/jpeg,image/webp" disabled={editDisabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void work(async()=>{const image=await normalizedImage(await fileData(file)),scale=Math.min(1,project.width/image.width,project.height/image.height);addLayer({id:crypto.randomUUID(),name:file.name.slice(0,80),image:image.image,visible:true,locked:false,opacity:1,quad:rectangleQuad((project.width-image.width*scale)/2,(project.height-image.height*scale)/2,image.width*scale,image.height*scale)},'导入图层');setTool('transform');});}}/></label></div>
        {layer&&<div className="eng-layer-settings"><label>图层名称<input aria-label="图层名称" value={layer.name} maxLength={80} disabled={editDisabled} onChange={e=>changeLayer({name:e.target.value})}/></label><label>不透明度<input aria-label="图层不透明度" type="range" min="0" max="100" value={Math.round(layer.opacity*100)} disabled={editDisabled||layer.locked} onChange={e=>changeLayer({opacity:Number(e.target.value)/100})}/></label><button type="button" disabled={editDisabled} onClick={()=>changeLayer({locked:!layer.locked})}>{layer.locked?'解锁图层':'锁定图层'}</button><div className="eng-refine-inline"><button type="button" disabled={editDisabled||project.layers.indexOf(layer)===project.layers.length-1} onClick={()=>{const layers=[...project.layers],i=layers.indexOf(layer);[layers[i],layers[i+1]]=[layers[i+1],layers[i]];commit({...project,layers},'图层上移');}}>上移</button><button type="button" disabled={editDisabled||project.layers.indexOf(layer)===0} onClick={()=>{const layers=[...project.layers],i=layers.indexOf(layer);[layers[i],layers[i-1]]=[layers[i-1],layers[i]];commit({...project,layers},'图层下移');}}>下移</button><button type="button" disabled={editDisabled||layer.locked||project.layers.length===1} onClick={()=>{commit({...project,layers:project.layers.filter(item=>item.id!==selected)},'删除图层');setSelected(project.layers[0].id);}}>删除</button></div>{!layer.locked&&<details open={tool==='transform'}><summary>四角坐标 · 像素</summary><div className="eng-quad-coordinates">{layer.quad.map((p,i)=><div key={i}><span>{i+1}</span>{(['x','y'] as const).map(axis=><label key={axis}>{axis}<input aria-label={`角${i+1}${axis}`} type="number" step="1" value={Math.round(p[axis]*10)/10} disabled={editDisabled} onChange={e=>{const value=Number(e.target.value);if(!Number.isFinite(value)||Math.abs(value)>32768)return;const quad=layer.quad.map((point,index)=>index===i?{...point,[axis]:value}:point);if(isValidQuad(quad))changeLayer({quad});}}/></label>)}</div>)}</div></details>}</div>}
        <button type="button" disabled={editDisabled||project.layers.length<2} onClick={()=>void work(async()=>{const rendered=await renderProject(project);const next=await newProject(rendered.toDataURL('image/png'));commit({...next,reference:project.reference,landmarks:project.landmarks},'合并可见图层');setSelected(next.layers[0].id);})}>合并可见图层</button>
        <div className="eng-refine-ai"><h3>修正选区</h3><p>橙色为允许替换的范围；其他区域由本地合成保留。</p><textarea aria-label="局部修改要求" rows={4} maxLength={10000} value={instruction} disabled={editDisabled} onChange={e=>setInstruction(e.target.value)} placeholder="例如：修正握桶把的手指，保持手腕和桶的位置。"/><button type="button" className="primary" disabled={editDisabled||!model} onClick={refine}>生成并合成选区</button>{busy&&abort.current&&<button type="button" onClick={()=>abort.current?.abort()}>取消本次精修</button>}<label className="eng-refine-file">导入同尺寸修订图并合成<input type="file" accept="image/png,image/jpeg,image/webp" disabled={editDisabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)importPatch(file);}}/></label></div>
      </aside></div>
    </>}
    <p className="eng-refine-status" role="status">{message}</p>{error&&<p className="eng-error" role="alert">{error}</p>}
  </section>;
}
