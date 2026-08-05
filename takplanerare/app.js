'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const fmt = (n, d = 0) => Number(n).toLocaleString('sv-SE', { maximumFractionDigits: d, minimumFractionDigits: d });
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const roundTo = (v, step) => Math.round(v / step) * step;

const defaults = {
  beam: 5490,
  rafterWidth: 45,
  overL: 400,
  overR: 400,
  slope: 2500,
  sides: 2,
  supportRef: 'left',
  lockEnds: true,
  materialMode: 'panel',
  stockLength: 3600,
  coverWidth: 540,
  priceLm: 0,
  snap: 5,
  activePattern: 'A',
  rafters: [0, 1089, 2178, 3200, 4356, 5445],
  patterns: { A: [3], B: [2, 4] }
};

let state = loadState() || structuredClone(defaults);
let drag = null;

const ids = ['beam','rafterWidth','overL','overR','slope','sides','supportRef','lockEnds','stockLength','coverWidth','priceLm','snap'];

function loadState(){
  try {
    const raw = localStorage.getItem('takplanerare-v2');
    return raw ? normaliseState(JSON.parse(raw)) : null;
  } catch { return null; }
}

function normaliseState(s){
  const merged = { ...structuredClone(defaults), ...s };
  merged.patterns = { A: [...(s?.patterns?.A || [])], B: [...(s?.patterns?.B || [])] };
  merged.rafters = Array.isArray(s?.rafters) ? s.rafters.map(Number).sort((a,b)=>a-b) : [...defaults.rafters];
  return merged;
}

function saveState(show = false){
  localStorage.setItem('takplanerare-v2', JSON.stringify(state));
  if(show) toast('Projektet är sparat lokalt');
}

function supportOffset(){
  if(state.supportRef === 'center') return state.rafterWidth / 2;
  if(state.supportRef === 'right') return state.rafterWidth;
  return 0;
}

function supportPos(index){ return state.rafters[index] + supportOffset(); }
function roofStart(){ return -state.overL; }
function roofEnd(){ return state.beam + state.overR; }
function roofLength(){ return state.beam + state.overL + state.overR; }
function rowsPerSide(){ return Math.ceil(state.slope / state.coverWidth); }
function totalRows(){ return rowsPerSide() * state.sides; }

function syncInputs(){
  for(const id of ids){
    const el = $(id);
    if(el.type === 'checkbox') el.checked = !!state[id];
    else el.value = state[id];
  }
  $('panelMode').classList.toggle('active', state.materialMode === 'panel');
  $('looseMode').classList.toggle('active', state.materialMode === 'loose');
  $('patternABtn').classList.toggle('active', state.activePattern === 'A');
  $('patternBBtn').classList.toggle('active', state.activePattern === 'B');
  $('coverLabel').textContent = state.materialMode === 'panel' ? 'Täckbredd lucka (mm)' : 'Täckbredd bräda (mm)';
  $('rafterCount').value = state.rafters.length;
}

function bindInputs(){
  for(const id of ids){
    $(id).addEventListener('change', () => {
      const el = $(id);
      state[id] = el.type === 'checkbox' ? el.checked : (el.tagName === 'SELECT' && ['supportRef'].includes(id) ? el.value : Number(el.value));
      if(id === 'beam' || id === 'rafterWidth') constrainRafters();
      if(id === 'coverWidth' && state.coverWidth < 1) state.coverWidth = 1;
      if(id === 'stockLength') pruneInvalidSeams();
      render();
    });
  }

  $('rafterCount').addEventListener('change', () => setRafterCount(Number($('rafterCount').value)));
  $('panelMode').onclick = () => setMode('panel');
  $('looseMode').onclick = () => setMode('loose');
  $('patternABtn').onclick = () => { state.activePattern = 'A'; render(); };
  $('patternBBtn').onclick = () => { state.activePattern = 'B'; render(); };
  $('equalBtn').onclick = distributeEvenly;
  $('fitBtn').onclick = fitWholeStock;
  $('addRafterBtn').onclick = addRafter;
  $('removeRafterBtn').onclick = removeRafter;
  $('optimizeBtn').onclick = optimizePatterns;
  $('clearSeamsBtn').onclick = () => { state.patterns.A = []; state.patterns.B = []; render(); };
  $('saveBtn').onclick = () => saveState(true);
  $('printBtn').onclick = () => window.print();
  $('exportBtn').onclick = exportProject;
  $('importBtn').onclick = () => $('fileInput').click();
  $('fileInput').addEventListener('change', importProject);
  window.addEventListener('beforeunload', () => saveState(false));
}

function setMode(mode){
  state.materialMode = mode;
  state.coverWidth = mode === 'panel' ? 540 : 90;
  render();
}

function constrainRafters(){
  const maxLeft = Math.max(0, state.beam - state.rafterWidth);
  state.rafters = state.rafters.map(x => clamp(Number(x)||0, 0, maxLeft)).sort((a,b)=>a-b);
  if(state.lockEnds && state.rafters.length >= 2){
    state.rafters[0] = 0;
    state.rafters[state.rafters.length - 1] = maxLeft;
  }
  dedupeRafters();
}

function dedupeRafters(){
  const minGap = Math.max(10, state.rafterWidth);
  for(let i=1;i<state.rafters.length;i++){
    if(state.rafters[i] < state.rafters[i-1] + minGap){
      state.rafters[i] = Math.min(state.beam - state.rafterWidth, state.rafters[i-1] + minGap);
    }
  }
}

function setRafterCount(n){
  n = clamp(Math.round(n || 2), 2, 20);
  const oldA = seamPositions('A');
  const oldB = seamPositions('B');
  state.rafters = [];
  const span = state.beam - state.rafterWidth;
  for(let i=0;i<n;i++) state.rafters.push(i * span / (n - 1));
  remapPatterns(oldA, oldB);
  render();
}

function remapPatterns(oldA, oldB){
  state.patterns.A = nearestRafterIndices(oldA);
  state.patterns.B = nearestRafterIndices(oldB);
}

function nearestRafterIndices(positions){
  return [...new Set(positions.map(p => {
    let best = 0, dist = Infinity;
    state.rafters.forEach((_,i) => {
      const d = Math.abs(supportPos(i)-p);
      if(d < dist){ dist=d; best=i; }
    });
    return best;
  }))].filter(i => i > 0 && i < state.rafters.length-1).sort((a,b)=>a-b);
}

function distributeEvenly(){
  const oldA = seamPositions('A'), oldB = seamPositions('B');
  const span = state.beam - state.rafterWidth;
  state.rafters = state.rafters.map((_,i,arr) => i * span / (arr.length - 1));
  remapPatterns(oldA, oldB);
  render();
}

function fitWholeStock(){
  if(state.rafters.length < 3) return;
  const targetSupport = roofStart() + state.stockLength;
  const targetLeft = targetSupport - supportOffset();
  if(targetLeft <= 0 || targetLeft >= state.beam - state.rafterWidth){
    toast('Materiallängden når ingen invändig takstol');
    return;
  }
  let index = 1, best = Infinity;
  for(let i=1;i<state.rafters.length-1;i++){
    const d = Math.abs(state.rafters[i] - targetLeft);
    if(d < best){ best=d; index=i; }
  }
  state.rafters[index] = roundTo(targetLeft, state.snap);
  state.rafters.sort((a,b)=>a-b);
  const newIndex = state.rafters.findIndex(x => Math.abs(x-roundTo(targetLeft,state.snap)) < 0.1);
  state.patterns[state.activePattern] = [newIndex];
  constrainRafters();
  render();
  toast(`Takstol placerad vid ${fmt(supportPos(newIndex))} mm för en hel ${fmt(state.stockLength)}-längd`);
}

function addRafter(){
  if(state.rafters.length >= 20) return;
  let bestGap = -1, at = 0;
  for(let i=0;i<state.rafters.length-1;i++){
    const gap = state.rafters[i+1] - state.rafters[i];
    if(gap > bestGap){ bestGap=gap; at=i; }
  }
  state.rafters.splice(at+1, 0, (state.rafters[at]+state.rafters[at+1])/2);
  shiftPatternIndices(at+1, 1);
  render();
}

function removeRafter(){
  if(state.rafters.length <= 2) return;
  let index = state.rafters.length - 2;
  state.rafters.splice(index,1);
  state.patterns.A = state.patterns.A.filter(i=>i!==index).map(i=>i>index?i-1:i);
  state.patterns.B = state.patterns.B.filter(i=>i!==index).map(i=>i>index?i-1:i);
  render();
}

function shiftPatternIndices(start, delta){
  for(const k of ['A','B']) state.patterns[k] = state.patterns[k].map(i => i >= start ? i+delta : i);
}

function pruneInvalidSeams(){
  for(const k of ['A','B']) state.patterns[k] = state.patterns[k].filter(i => i>0 && i<state.rafters.length-1);
}

function seamPositions(pattern){ return state.patterns[pattern].map(supportPos).sort((a,b)=>a-b); }

function cutsForPattern(pattern){
  const pts = [roofStart(), ...seamPositions(pattern), roofEnd()];
  const cuts = [];
  for(let i=0;i<pts.length-1;i++) cuts.push(Math.max(0, pts[i+1]-pts[i]));
  return cuts;
}

function patternIsValid(pattern){
  const cuts = cutsForPattern(pattern);
  return cuts.every(x => x > 0 && x <= state.stockLength + 0.001);
}

function toggleSeam(index, pattern = state.activePattern){
  if(index <= 0 || index >= state.rafters.length-1) return;
  const arr = state.patterns[pattern];
  const p = arr.indexOf(index);
  if(p >= 0) arr.splice(p,1); else arr.push(index);
  arr.sort((a,b)=>a-b);
  render();
}

function combinations(arr, maxLen){
  const out = [[]];
  function walk(start, chosen){
    if(chosen.length >= maxLen) return;
    for(let i=start;i<arr.length;i++){
      const next=[...chosen,arr[i]]; out.push(next); walk(i+1,next);
    }
  }
  walk(0,[]);
  return out;
}

function generateCandidates(){
  const interior = Array.from({length:Math.max(0,state.rafters.length-2)},(_,i)=>i+1);
  const minPieces = Math.ceil(roofLength()/state.stockLength);
  const maxSeams = Math.min(interior.length, Math.max(minPieces+1,3));
  return combinations(interior,maxSeams)
    .map(indices => ({ indices, cuts: cutsFromIndices(indices) }))
    .filter(c => c.cuts.every(x => x > 0 && x <= state.stockLength + .001))
    .map(c => {
      const p=packCuts(c.cuts);
      return {...c, score:p.stockCount*1e9+p.waste};
    })
    .sort((a,b)=>a.score-b.score || a.indices.length-b.indices.length)
    .slice(0,50);
}

function cutsFromIndices(indices){
  const pts=[roofStart(),...indices.map(supportPos).sort((a,b)=>a-b),roofEnd()];
  return pts.slice(1).map((p,i)=>p-pts[i]);
}

function optimizePatterns(){
  const candidates = generateCandidates();
  if(!candidates.length){ toast('Ingen giltig skarvplan finns med nuvarande materiallängd'); return; }
  const rows = totalRows();
  const countA = Math.ceil(rows/2), countB = Math.floor(rows/2);
  let best = null;
  const pool = candidates.slice(0,30);
  for(const a of pool){
    for(const b of pool){
      if(pool.length>1 && a.indices.join(',')===b.indices.join(',')) continue;
      const cuts=[];
      for(let i=0;i<countA;i++) cuts.push(...a.cuts);
      for(let i=0;i<countB;i++) cuts.push(...b.cuts);
      const packed=packCuts(cuts);
      const sameSupport = a.indices.filter(i=>b.indices.includes(i)).length;
      const score=packed.stockCount*1e12+packed.waste*1e3+sameSupport*100+a.indices.length+b.indices.length;
      if(!best || score<best.score) best={score,a,b,packed};
    }
  }
  if(!best) best={a:candidates[0],b:candidates[0]};
  state.patterns.A=[...best.a.indices];
  state.patterns.B=[...best.b.indices];
  render();
  toast('Skarvmönster optimerade för minsta antal inköpslängder');
}

function allDemandCuts(){
  const cuts=[];
  for(let row=0;row<totalRows();row++) cuts.push(...cutsForPattern(row%2===0?'A':'B'));
  return cuts;
}

function packCuts(cuts){
  const stock = [];
  const sorted = cuts.map((length,i)=>({length:Number(length),id:i})).sort((a,b)=>b.length-a.length);
  for(const cut of sorted){
    let best=-1, bestRest=Infinity;
    for(let i=0;i<stock.length;i++){
      const rest=stock[i].remaining-cut.length;
      if(rest>=-0.001 && rest<bestRest){best=i;bestRest=rest;}
    }
    if(best<0){
      stock.push({remaining:state.stockLength-cut.length,cuts:[cut.length]});
    } else {
      stock[best].cuts.push(cut.length);
      stock[best].remaining-=cut.length;
    }
  }
  return {
    stock,
    stockCount:stock.length,
    purchased:stock.length*state.stockLength,
    used:cuts.reduce((a,b)=>a+b,0),
    waste:stock.reduce((a,b)=>a+Math.max(0,b.remaining),0)
  };
}

function render(){
  constrainRafters();
  syncInputs();
  renderRafterTable();
  renderDrawing();
  renderSummary();
  saveState(false);
}

function renderRafterTable(){
  const body=$('rafterRows'); body.innerHTML='';
  state.rafters.forEach((left,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>TS${i+1}</td>
      <td><input class="tinyInput" data-left="${i}" type="number" step="${state.snap}" value="${Math.round(left)}" ${state.lockEnds&&(i===0||i===state.rafters.length-1)?'disabled':''}></td>
      <td>${fmt(left+state.rafterWidth/2,1)}</td>
      <td><input data-seam-a="${i}" type="checkbox" ${state.patterns.A.includes(i)?'checked':''} ${i===0||i===state.rafters.length-1?'disabled':''}></td>
      <td><input data-seam-b="${i}" type="checkbox" ${state.patterns.B.includes(i)?'checked':''} ${i===0||i===state.rafters.length-1?'disabled':''}></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-left]').forEach(el=>el.onchange=()=>{
    const i=Number(el.dataset.left); state.rafters[i]=roundTo(Number(el.value),state.snap); constrainRafters(); render();
  });
  body.querySelectorAll('[data-seam-a]').forEach(el=>el.onchange=()=>toggleSeam(Number(el.dataset.seamA),'A'));
  body.querySelectorAll('[data-seam-b]').forEach(el=>el.onchange=()=>toggleSeam(Number(el.dataset.seamB),'B'));
}

function svgEl(name, attrs={}, text=''){
  const el=document.createElementNS(SVG_NS,name);
  for(const [k,v] of Object.entries(attrs)) el.setAttribute(k,v);
  if(text) el.textContent=text;
  return el;
}

function renderDrawing(){
  const svg=$('drawing'); svg.innerHTML='';
  const start=roofStart(), end=roofEnd();
  const pad=Math.max(350,roofLength()*.06);
  svg.setAttribute('viewBox',`${start-pad} 0 ${roofLength()+2*pad} 670`);

  const defs=svgEl('defs');
  defs.innerHTML=`<pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#e2e8f0" stroke-width="2"/></pattern>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-opacity=".16"/></filter>`;
  svg.appendChild(defs);
  svg.appendChild(svgEl('rect',{x:start-pad,y:0,width:roofLength()+2*pad,height:670,fill:'url(#grid)'}));

  drawDimension(svg,start,end,55,`TOTAL TAKLÄNGD ${fmt(roofLength())} mm`);
  drawDimension(svg,0,state.beam,100,`HAMMARBAND ${fmt(state.beam)} mm`);
  drawDimension(svg,start,0,145,`${fmt(state.overL)} mm`);
  drawDimension(svg,state.beam,end,145,`${fmt(state.overR)} mm`);

  svg.appendChild(svgEl('rect',{x:0,y:235,width:state.beam,height:65,rx:10,fill:'#b7793f',stroke:'#8f5d2f','stroke-width':4,filter:'url(#shadow)'}));
  svg.appendChild(svgEl('text',{x:state.beam/2,y:275,'text-anchor':'middle','font-size':30,'font-weight':900,fill:'#fff'},'HAMMARBAND'));

  state.rafters.forEach((left,i)=>{
    const group=svgEl('g',{'data-index':i,style:'cursor:ew-resize'});
    group.appendChild(svgEl('rect',{x:left,y:195,width:state.rafterWidth,height:145,rx:6,fill:'#475569',stroke:'#0f172a','stroke-width':3}));
    group.appendChild(svgEl('text',{x:left+state.rafterWidth/2,y:180,'text-anchor':'middle','font-size':24,'font-weight':900,fill:'#0f172a'},`TS${i+1}`));
    group.appendChild(svgEl('text',{x:left+state.rafterWidth/2,y:370,'text-anchor':'middle','font-size':20,'font-weight':800,fill:'#334155'},`${fmt(supportPos(i))}`));
    if(state.patterns.A.includes(i)) group.appendChild(svgEl('circle',{cx:supportPos(i),cy:400,r:14,fill:'#2563eb'}));
    if(state.patterns.B.includes(i)) group.appendChild(svgEl('circle',{cx:supportPos(i),cy:430,r:14,fill:'#d97706'}));
    bindRafterDrag(group,i,svg);
    svg.appendChild(group);
  });

  drawPattern(svg,'A',465,'#bfdbfe','#2563eb');
  drawPattern(svg,'B',545,'#fde68a','#d97706');

  const cc=[];
  for(let i=0;i<state.rafters.length-1;i++) cc.push((state.rafters[i+1]+state.rafterWidth/2)-(state.rafters[i]+state.rafterWidth/2));
  svg.appendChild(svgEl('text',{x:start,y:650,'font-size':20,'font-weight':800,fill:'#64748b'},`CC min ${fmt(Math.min(...cc))} mm · CC max ${fmt(Math.max(...cc))} mm · Måttetiketter vid takstolar = ${state.supportRef==='left'?'vänsterkant':state.supportRef==='center'?'centrum':'högerkant'}`));
}

function drawDimension(svg,x1,x2,y,label){
  const c='#334155';
  svg.appendChild(svgEl('line',{x1,y1:y,x2,y2:y,stroke:c,'stroke-width':2}));
  svg.appendChild(svgEl('line',{x1,y1:y-10,x2:x1,y2:y+10,stroke:c,'stroke-width':2}));
  svg.appendChild(svgEl('line',{x1:x2,y1:y-10,x2,y2:y+10,stroke:c,'stroke-width':2}));
  svg.appendChild(svgEl('text',{x:(x1+x2)/2,y:y-8,'text-anchor':'middle','font-size':20,'font-weight':900,fill:c},label));
}

function drawPattern(svg,pattern,y,fill,stroke){
  const cuts=cutsForPattern(pattern); let x=roofStart();
  cuts.forEach((len,i)=>{
    const valid=len<=state.stockLength+.001;
    svg.appendChild(svgEl('rect',{x,y,width:len,height:48,rx:8,fill:valid?fill:'#fecaca',stroke:valid?stroke:'#dc2626','stroke-width':3}));
    svg.appendChild(svgEl('text',{x:x+len/2,y:y+31,'text-anchor':'middle','font-size':20,'font-weight':900,fill:'#0f172a'},`${fmt(len)} mm`));
    x+=len;
    if(i<cuts.length-1) svg.appendChild(svgEl('line',{x1:x,y1:y-12,x2:x,y2:y+60,stroke:valid?stroke:'#dc2626','stroke-width':5}));
  });
  svg.appendChild(svgEl('text',{x:roofStart()-25,y:y+31,'text-anchor':'end','font-size':24,'font-weight':1000,fill:stroke},pattern));
}

function bindRafterDrag(group,index,svg){
  group.addEventListener('pointerdown',e=>{
    if(state.lockEnds && (index===0||index===state.rafters.length-1)) return;
    group.setPointerCapture(e.pointerId);
    drag={index,startX:e.clientX,startLeft:state.rafters[index],moved:false};
  });
  group.addEventListener('pointermove',e=>{
    if(!drag||drag.index!==index) return;
    const pt=svg.createSVGPoint(); pt.x=e.clientX;pt.y=e.clientY;
    const local=pt.matrixTransform(svg.getScreenCTM().inverse());
    let left=roundTo(local.x-state.rafterWidth/2,state.snap);
    const min=index===0?0:state.rafters[index-1]+state.rafterWidth;
    const max=index===state.rafters.length-1?state.beam-state.rafterWidth:state.rafters[index+1]-state.rafterWidth;
    left=clamp(left,min,max);
    if(Math.abs(left-drag.startLeft)>state.snap/2) drag.moved=true;
    state.rafters[index]=left;
    renderDrawing(); renderRafterTable(); renderSummary();
  });
  group.addEventListener('pointerup',()=>{
    if(!drag||drag.index!==index) return;
    const moved=drag.moved; drag=null;
    if(!moved) toggleSeam(index); else render();
  });
}

function renderSummary(){
  const validA=patternIsValid('A'), validB=patternIsValid('B');
  const cuts=allDemandCuts();
  const pack=packCuts(cuts);
  const rows=totalRows();
  const wastePct=pack.purchased?pack.waste/pack.purchased*100:0;
  const cost=pack.purchased/1000*state.priceLm;

  $('roofLengthMetric').textContent=`${fmt(roofLength())} mm`;
  $('rowsMetric').textContent=`${rows}`;
  $('stockMetric').textContent=`${pack.stockCount} st`;
  $('wasteMetric').textContent=`${fmt(pack.waste/1000,2)} m`;
  $('costMetric').textContent=state.priceLm?`${fmt(cost,0)} kr`:'–';

  const pill=$('validationPill');
  pill.className='pill '+(validA&&validB?'good':'bad');
  pill.textContent=validA&&validB?'Alla delar ryms i inköpslängden':'Minst en del är för lång';

  const area=roofLength()/1000*state.slope/1000*state.sides;
  const lm=pack.used/1000;
  const maxCc=Math.max(...state.rafters.slice(1).map((x,i)=>(x+state.rafterWidth/2)-(state.rafters[i]+state.rafterWidth/2)));
  const rowsData=[
    ['Takarea',`${fmt(area,2)} m²`],
    ['Rader per takfall',`${rowsPerSide()} st`],
    ['Använd materiallängd',`${fmt(lm,2)} löpmeter`],
    ['Inköpt materiallängd',`${fmt(pack.purchased/1000,2)} löpmeter`],
    ['Spillandel',`${fmt(wastePct,1)} %`],
    ['Maximalt CC-mått',`${fmt(maxCc)} mm`],
    ['Mönster A',cutsForPattern('A').map(x=>fmt(x)).join(' + ')+' mm'],
    ['Mönster B',cutsForPattern('B').map(x=>fmt(x)).join(' + ')+' mm']
  ];
  $('summaryRows').innerHTML=rowsData.map(([a,b])=>`<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  $('cutRows').innerHTML=pack.stock.map((s,i)=>`<tr><td>${i+1} · ${fmt(state.stockLength)} mm</td><td>${s.cuts.map(x=>fmt(x)).join(' + ')}</td><td>${fmt(Math.max(0,s.remaining))} mm</td></tr>`).join('');
}

function exportProject(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='takplanerare-projekt.json'; a.click(); URL.revokeObjectURL(a.href);
}

function importProject(e){
  const file=e.target.files?.[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{ state=normaliseState(JSON.parse(reader.result)); render(); toast('Projekt importerat'); }
    catch{ toast('Filen kunde inte läsas'); }
  };
  reader.readAsText(file); e.target.value='';
}

function toast(msg){
  const el=$('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2600);
}

bindInputs();
syncInputs();
render();
