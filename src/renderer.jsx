import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmRoot, confirmDialog } from './ui/confirm.jsx';
import { useAsync } from './lib/use-async.js';
const {useState,useEffect,useRef,useCallback}=React;
const api=window.electronAPI||null;

/* ── Utils ─────────────────────────── */
const bar=(pct,w=20)=>{const f=Math.max(0,Math.min(w,Math.round((pct/100)*w)));return '█'.repeat(f)+'░'.repeat(w-f);};
const pad=(s,n)=>String(s).padStart(n,' ');
const fmtNow=()=>{const d=new Date();return `Hoy ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
const fmtBytes=(b)=>{b=Number(b)||0;if(b<1024)return b+' B';const u=['KB','MB','GB','TB'];let i=-1;do{b/=1024;i++;}while(b>=1024&&i<u.length-1);return b.toFixed(b>=10?0:1)+' '+u[i];};
const fmtDate=(ts)=>{const d=new Date(ts),n=new Date();const sameDay=d.toDateString()===n.toDateString();const y=new Date(n-86400000).toDateString()===d.toDateString();const hm=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;if(sameDay)return 'Hoy '+hm;if(y)return 'Ayer '+hm;return d.toLocaleDateString('es-ES',{day:'2-digit',month:'short'})+' '+hm;};

/* ── Toast bus ─────────────────────── */
const toastBus={fns:[],push(m,t){this.fns.forEach(f=>f(m,t));},sub(f){this.fns.push(f);return()=>{this.fns=this.fns.filter(x=>x!==f);};}};
const toast=(m,t='info')=>toastBus.push(m,t);
function Toasts(){
  const [items,setItems]=useState([]);
  useEffect(()=>toastBus.sub((m,t)=>{const id=Math.random();setItems(p=>[...p,{id,m,t}]);setTimeout(()=>setItems(p=>p.filter(x=>x.id!==id)),3600);}),[]);
  return(<div style={{position:'fixed',right:18,bottom:18,zIndex:10000,display:'flex',flexDirection:'column',gap:8,alignItems:'flex-end',pointerEvents:'none'}}>
    {items.map(it=>(<div key={it.id} style={{animation:'slideIn .2s ease',background:'#0a0a0a',border:`1px solid ${it.t==='err'?'#aa3333':it.t==='ok'?'#338855':'#3a3a3a'}`,padding:'9px 14px',fontSize:11,color:it.t==='err'?'#ff8888':it.t==='ok'?'#88ddaa':'#e5e5e5',maxWidth:340,boxShadow:'0 4px 20px rgba(0,0,0,.6)'}}>
      <span style={{color:it.t==='err'?'#aa3333':it.t==='ok'?'#338855':'#8a8a8a',marginRight:6}}>{it.t==='err'?'✗':it.t==='ok'?'✓':'›'}</span>{it.m}
    </div>))}
  </div>);
}
async function runAction(label,promise,{successFreed}={}){
  try{
    const r=await promise;
    if(r&&r.ok===false){toast(`${label}: ${r.error||'error'}`,'err');return r;}
    if(successFreed&&r&&r.freed!=null){toast(`${label}: ${fmtBytes(r.freed)} liberados`,'ok');return r;}
    toast(`${label} ✓`,'ok');return r;
  }catch(e){toast(`${label}: error`,'err');return{ok:false};}
}

/* ── Window size hook ──────────────── */
function useWindowSize(){
  const [s,setS]=useState({w:window.innerWidth,h:window.innerHeight});
  useEffect(()=>{const h=()=>setS({w:window.innerWidth,h:window.innerHeight});window.addEventListener('resize',h);return()=>window.removeEventListener('resize',h);},[]);
  return s;
}

/* ── Animated number hook (eased) ──── */
function useAnimatedNumber(target,dur=600){
  const [v,setV]=useState(target);
  const fromRef=useRef(target);
  useEffect(()=>{
    const from=fromRef.current,to=Number(target)||0;
    if(from===to)return;
    const t0=performance.now();let raf;
    const tick=t=>{
      const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);
      const val=from+(to-from)*e;
      setV(val);
      if(k<1)raf=requestAnimationFrame(tick);else fromRef.current=to;
    };
    raf=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(raf);fromRef.current=to;};
  },[target,dur]);
  return v;
}

/* ── Real-time metrics hook ────────── */
function useSystemMetrics(ms=2000){
  const [m,setM]=useState({cpu:0,ram:{pct:0,totalGB:0,usedGB:0,freeGB:0},ext:{gpu:0,temp:0,diskPct:0,netMbps:0,procs:0,threads:0,cpuFreq:0,uptime:'—'},topProcs:[]});
  useEffect(()=>{
    let on=true,inFlight=false;
    const poll=async()=>{
      if(!on)return;
      // Sin este guard, si una lectura tarda más que el intervalo (p.ej. bajo
      // carga de CPU) el siguiente tick del setInterval lanza otro proceso
      // powershell.exe encima del anterior, y se van acumulando.
      if(inFlight)return;
      // Pausar el polling con la ventana oculta/minimizada a la bandeja: no
      // hay nadie mirando los números y ahorra un proceso powershell.exe
      // cada `ms` que no sirve para nada.
      if(document.hidden)return;
      inFlight=true;
      if(api&&api.getMetrics){try{const d=await api.getMetrics();if(on&&d)setM(d);}catch(e){}}
      else{setM(p=>({cpu:Math.min(99,Math.max(5,(p.cpu||40)+(Math.random()-.5)*12)),ram:{pct:Math.min(95,Math.max(25,(p.ram?.pct||60)+(Math.random()-.5)*4)),totalGB:16,usedGB:9.6,freeGB:6.4},ext:{gpu:Math.min(95,Math.max(3,(p.ext?.gpu||25)+(Math.random()-.5)*14)),temp:Math.round(55+Math.random()*15),diskPct:42,netMbps:+(Math.random()*30).toFixed(1),procs:Math.round(170+Math.random()*30),threads:Math.round(1100+Math.random()*200),cpuFreq:3.84,uptime:'2d 5h'},topProcs:[{Name:'chrome',CPU:8.2,MemMB:1840,pid:1},{Name:'Code',CPU:5.4,MemMB:920,pid:2},{Name:'explorer',CPU:1.2,MemMB:340,pid:3}]}));}
      inFlight=false;
    };
    poll();const id=setInterval(poll,ms);
    const onVis=()=>{if(!document.hidden)poll();};
    document.addEventListener('visibilitychange',onVis);
    return()=>{on=false;clearInterval(id);document.removeEventListener('visibilitychange',onVis);};
  },[ms]);
  return m;
}

/* ── Shared Components ─────────────── */
const SLabel=({children})=>(<div style={{fontSize:11,color:'#a8a8a8',letterSpacing:2,textTransform:'uppercase',marginBottom:12}}>// {children}</div>);

// Two-tone ASCII progress bar: bright filled blocks over dim empty track
const BarGlyph=({pct,w=24})=>{const f=Math.max(0,Math.min(w,Math.round((pct/100)*w)));return(<span style={{letterSpacing:-1}}><span style={{color:'#ededed'}}>{'█'.repeat(f)}</span><span style={{color:'#333'}}>{'░'.repeat(w-f)}</span></span>);};
const Loading=({label='Cargando'})=>(<div style={{display:'flex',alignItems:'center',gap:10,color:'#8a8a8a',fontSize:11,padding:'20px 0'}}><span className="spinner"/> {label}<span className="blink">_</span></div>);
// Estado de fallo explícito — distinto de "cargando" y de "sin resultados",
// para no hacer pasar un error de PowerShell por una lista vacía.
const ErrorState=({message,onRetry})=>(<div style={{display:'flex',flexDirection:'column',gap:10,alignItems:'flex-start',border:'1.5px solid #4a2a2a',background:'#150808',padding:'16px 18px',fontSize:11,color:'#ff9a9a'}}>
  <span>✗ {message||'Ocurrió un error'}</span>
  {onRetry&&<button onClick={onRetry} className="btn-ghost" style={{padding:'6px 14px',border:'1.5px solid #6a3a3a',background:'transparent',color:'#ff9a9a',fontSize:10,letterSpacing:1,textTransform:'uppercase'}}>REINTENTAR</button>}
</div>);

// Escaneos largos (apps sin usar, restos de config, juegos): progreso
// visible (cronómetro, no spinner mudo), cancelable vía cancel-scan, y el
// propio timeout de main.js corta el PS si se cuelga. `cancelName` es la
// clave con la que main.js registró el proceso powershell.exe en vuelo.
function useCancelableScan(cancelName){
  const [scanning,setScanning]=useState(false);
  const [error,setError]=useState(null);
  const [elapsed,setElapsed]=useState(0);
  const timerRef=useRef();
  const run=useCallback(async(fn)=>{
    setScanning(true);setError(null);setElapsed(0);
    const t0=Date.now();
    timerRef.current=setInterval(()=>setElapsed(Math.round((Date.now()-t0)/1000)),1000);
    let result=null;
    try{
      const r=await fn();
      if(r&&r.ok===false)setError(r.error||'El escaneo falló');
      else result=(r&&r.data!==undefined)?r.data:r;
    }catch(e){setError('Error inesperado durante el escaneo');}
    clearInterval(timerRef.current);
    setScanning(false);
    return result;
  },[]);
  const cancel=useCallback(()=>{if(api&&api.cancelScan)api.cancelScan(cancelName);},[cancelName]);
  useEffect(()=>()=>clearInterval(timerRef.current),[]);
  return {scanning,error,elapsed,run,cancel};
}
function ScanProgress({label,elapsed,onCancel}){
  return(<div style={{marginBottom:16,border:'1.5px solid #303030',padding:'12px 16px'}} className="fade-in">
    <div style={{fontSize:11,color:'#a8a8a8',letterSpacing:1,marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <span>{label} — {elapsed}s<span className="blink">_</span></span>
      <button onClick={onCancel} style={{fontSize:10,color:'#ff9a9a',background:'none',border:'1px solid #6a3a3a',padding:'3px 10px',cursor:'pointer',letterSpacing:1}}>CANCELAR</button>
    </div>
    <div className="scanbar"/>
  </div>);
}

function BarRow({label,value,max=100,width=24}){
  const av=useAnimatedNumber(value,700);
  const pct=Math.round((av/max)*100);
  return(<div style={{display:'flex',alignItems:'center',gap:10,fontSize:12}}>
    <span style={{color:'#a8a8a8',width:50,flexShrink:0}}>{pad(label,6)}</span>
    <BarGlyph pct={pct} w={width}/>
    <span style={{color:'#d8d8d8',width:40,fontWeight:600,textAlign:'right',flexShrink:0}}>{pct}%</span>
  </div>);
}

function StatGrid({cols,items}){
  return(<div style={{display:'grid',gridTemplateColumns:`repeat(${cols},1fr)`,gap:0,border:'1.5px solid #303030',marginBottom:24}}>
    {items.map(([k,v],i)=>(<div key={k} style={{padding:'14px 18px',borderRight:(i+1)%cols!==0?'1px solid #2c2c2c':'none'}}>
      <div style={{fontSize:10,fontWeight:600,color:'#a8a8a8',letterSpacing:2,textTransform:'uppercase',marginBottom:4}}>{k}</div>
      <div style={{fontSize:'clamp(14px,1.9vw,22px)',fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v}</div>
    </div>))}
  </div>);
}

function LineCanvas({data,h=60,color='#fff'}){
  const ref=useRef();
  useEffect(()=>{const c=ref.current;if(!c)return;const W=c.offsetWidth||300,H=h;c.width=W;c.height=H;const ctx=c.getContext('2d');ctx.clearRect(0,0,W,H);const mn=Math.min(...data),mx=Math.max(...data),rg=mx-mn||1;const pts=data.map((v,i)=>({x:(i/(data.length-1))*W,y:H-((v-mn)/rg)*H*.85-H*.075}));[.25,.5,.75].forEach(p=>{ctx.beginPath();ctx.moveTo(0,H*(1-p));ctx.lineTo(W,H*(1-p));ctx.strokeStyle='#111';ctx.lineWidth=1;ctx.stroke();});ctx.beginPath();pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.stroke();const l=pts[pts.length-1];ctx.beginPath();ctx.arc(l.x,l.y,3,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();},[data,h,color]);
  return <canvas ref={ref} style={{width:'100%',height:h,display:'block'}}/>;
}

function AsciiSphere({size=160}){
  const ref=useRef();
  useEffect(()=>{const c=ref.current;c.width=size;c.height=size;const ctx=c.getContext('2d'),cx=size/2,cy=size/2,R=size*.38,N=180;const pts=Array.from({length:N},(_,i)=>{const phi=Math.acos(1-2*(i+.5)/N),theta=Math.PI*(1+Math.sqrt(5))*i;return{phi,theta0:theta};});let frame;const draw=t=>{ctx.clearRect(0,0,size,size);const rot=t*.0003;pts.forEach((p,i)=>{if(i%4!==0)return;const theta=p.theta0+rot,x=R*Math.sin(p.phi)*Math.cos(theta),y=R*Math.cos(p.phi),z=R*Math.sin(p.phi)*Math.sin(theta),persp=1/(1+z/(R*3)),depth=(z+R)/(2*R);ctx.beginPath();ctx.arc(cx+x*persp,cy-y*persp,.8+depth*1.4,0,Math.PI*2);ctx.fillStyle=`rgba(255,255,255,${.15+depth*.85})`;ctx.fill();});frame=requestAnimationFrame(draw);};frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame);},[size]);
  return <canvas ref={ref} style={{display:'block',imageRendering:'pixelated'}}/>;
}

/* ── Admin banner ──────────────────── */
function AdminBanner(){
  const [admin,setAdmin]=useState(true);
  useEffect(()=>{if(api&&api.isAdmin)api.isAdmin().then(setAdmin);},[]);
  if(admin)return null;
  return(<div style={{border:'1px solid #5a4a1a',background:'rgba(120,90,20,.08)',padding:'10px 16px',marginBottom:20,display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
    <div style={{fontSize:11,color:'#ccaa55',display:'flex',alignItems:'center'}}><span style={{display:'inline-block',border:'1px solid #ccaa55',padding:'0 7px',marginRight:10,fontSize:10,fontWeight:700,lineHeight:'17px',flexShrink:0}}>!</span>Sin privilegios de administrador. Algunas optimizaciones (servicios, registro, reparación) no se aplicarán.</div>
    <button onClick={()=>api&&api.relaunchAdmin()} style={{padding:'6px 14px',border:'1px solid #ccaa55',background:'transparent',color:'#ccaa55',fontSize:10,letterSpacing:2,textTransform:'uppercase',whiteSpace:'nowrap'}}>Elevar permisos</button>
  </div>);
}

/* ── Profiles ──────────────────────── */
const PROFILES=[
  {id:'gaming',label:'Gaming · Latencia cero',icon:'▸',desc:'Prioriza tu juego por encima de todo: GPU, CPU y red al instante',color:'#ff4444',actions:['Plan de energia: Alto rendimiento','Prioridad multimedia maxima','Red sin throttling (latencia minima)','Prioridad GPU/CPU alta para juegos','Game Mode ON · captura DVR OFF','Detiene SysMain, WSearch y telemetria','Vacia cache DNS']},
  {id:'trabajo',label:'Trabajo Silencioso',icon:'◎',desc:'Ventiladores en calma y bateria al maximo: solo lo esencial',color:'#4488ff',actions:['Plan de energia: Economizador','Detiene telemetria (DiagTrack)','Detiene precarga SysMain (menos disco)','CPU limitada al 80% (menos calor)']},
  {id:'balanced',label:'Equilibrado',icon:'◈',desc:'Valores de fabrica de Windows: deshace cualquier perfil anterior',color:'#44ff88',actions:['Plan de energia: Equilibrado','Restaura prioridad multimedia y red','Prioridades de juegos por defecto','Reactiva SysMain, WSearch y DVR']},
  {id:'ultimate',label:'Maximo Rendimiento',icon:'▲',desc:'Todo al limite, sin ningun ahorro de energia: para tareas pesadas',color:'#ffaa00',actions:['Plan Ultimate Performance','CPU minima al 100% (sin throttling)','Suspension selectiva USB desactivada','Prioridad multimedia maxima']},
];
function ProfilesPanel(){
  const [active,setActive]=useState(null);
  const [applying,setApplying]=useState(null);
  const [step,setStep]=useState(0);
  const apply=async p=>{
    if(applying)return;
    setApplying(p.id);setStep(0);
    const total=p.actions.length,stepMs=320;
    const t0=Date.now();
    const iv=setInterval(()=>setStep(s=>Math.min(total-1,s+1)),stepMs);
    let r={ok:true};
    try{r=api?(api.applyProfile?await api.applyProfile(p.id):await (p.id==='gaming'?api.setGameMode(true):p.id==='trabajo'?api.setQuietMode(true):api.setPowerProfile(p.id))):{ok:true};}catch(e){r={ok:false};}
    const left=total*stepMs+250-(Date.now()-t0);
    if(left>0)await new Promise(res=>setTimeout(res,left));
    clearInterval(iv);setStep(total);
    await new Promise(res=>setTimeout(res,350));
    setApplying(null);
    if(r&&r.ok!==false){setActive(p.id);toast(r.partial?`Perfil ${p.label}: aplicado con avisos`:`Perfil ${p.label} aplicado`,r.partial?'info':'ok');}
    else toast(`Perfil ${p.label}: no se pudo aplicar`,'err');
  };
  return(
    <div style={{padding:'0 0 24px'}} className="fade-in">
      <SLabel>Perfiles de rendimiento</SLabel>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(330px,1fr))',gap:12}}>
        {PROFILES.map((p,pi)=>{const isA=active===p.id,isAp=applying===p.id;return(
          <div key={p.id} onClick={()=>!applying&&apply(p)} className="row-in" style={{'--i':pi*3,border:`1.5px solid ${isA?p.color:'#262626'}`,padding:'16px 18px',cursor:isAp?'wait':applying?'default':'pointer',transition:'border-color .15s,background .15s',background:isA?'rgba(255,255,255,.03)':'transparent',position:'relative',overflow:'hidden'}}
            onMouseEnter={e=>{if(!isA&&!applying)e.currentTarget.style.borderColor='#4a4a4a';}} onMouseLeave={e=>{e.currentTarget.style.borderColor=isA?p.color:'#262626';}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={{width:34,height:34,flexShrink:0,border:`1px solid ${isA||isAp?p.color:'#3a3a3a'}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,color:isA||isAp?p.color:'#b5b5b5',transition:'all .2s'}}>{isAp?<span className="spinner" style={{borderTopColor:p.color}}/>:p.icon}</span>
                <div><div style={{fontSize:13,fontWeight:700,color:isA?p.color:'#d8d8d8',letterSpacing:.5,transition:'color .2s'}}>{p.label}</div>
                <div style={{fontSize:10,color:'#7e7e7e',marginTop:1}}>{p.desc}</div></div>
              </div>
              <div style={{fontSize:10,letterSpacing:2,color:isAp?'#d8d8d8':isA?p.color:'#6e6e6e',whiteSpace:'nowrap',transition:'color .2s'}}>{isAp?<span>{step}/{p.actions.length}<span className="blink">_</span></span>:isA?'● ACTIVO':'○'}</div>
            </div>
            <div style={{borderTop:'1px solid #1f1f1f',paddingTop:10,display:'flex',flexDirection:'column',gap:4}}>
              {p.actions.map((a,i)=>{
                const done=isAp?i<step:isA;
                const cur=isAp&&i===step;
                return(<div key={i} style={{fontSize:10,color:isAp?(done?'#d8d8d8':cur?'#fff':'#4a4a4a'):isA?'#9c9c9c':'#5e5e5e',display:'flex',alignItems:'center',gap:6,transition:'color .25s'}}>
                  <span style={{color:done?p.color:cur?'#fff':'#4a4a4a',width:10,flexShrink:0,transition:'color .25s'}}>{done?<span className="check-pop">✓</span>:cur?'›':'>'}</span> {a}
                </div>);
              })}
            </div>
          </div>
        );})}
      </div>
      <div style={{marginTop:14,fontSize:10,color:'#7e7e7e'}}>Los perfiles aplican ajustes reales del sistema (plan de energia, scheduler multimedia, red y servicios). «Equilibrado» restaura los valores de fabrica.</div>
    </div>
  );
}

/* ── System info strip ─────────────── */
function SystemInfo(){
  const [info,setInfo]=useState(null);
  useEffect(()=>{if(api&&api.getSystemInfo)api.getSystemInfo().then(setInfo);},[]);
  if(!info)return null;
  const rows=[['CPU',info.cpu],['Nucleos',info.cores],['GPU',info.gpu],['RAM',info.ramGB+' GB'],['Disco',info.disk],['SO',info.os],['Placa',info.board],['Equipo',info.hostname]];
  return(<div style={{marginTop:16,borderTop:'1.5px solid #262626',paddingTop:14}}>
    <div style={{fontSize:10,color:'#929292',letterSpacing:2,marginBottom:8}}>EQUIPO</div>
    <div style={{display:'flex',flexDirection:'column',gap:3}}>
      {rows.filter(r=>r[1]&&r[1]!=='—').map(([k,v])=>(<div key={k} style={{display:'flex',justifyContent:'space-between',gap:10,fontSize:10}}>
        <span style={{color:'#7e7e7e',flexShrink:0}}>{k}</span><span style={{color:'#a8a8a8',textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={v}>{v}</span>
      </div>))}
    </div>
  </div>);
}

/* ── Dashboard ─────────────────────── */
function Dashboard({onOptimize,optimizing,optimized,metrics}){
  const [tab,setTab]=useState('overview');
  const narrow=useWindowSize().w<1020;
  const {cpu,ram,ext}=metrics;
  const score=optimized?94:Math.max(1,Math.round(100-(cpu*.28+ram.pct*.22+(ext.gpu>0?ext.gpu:0)*.12)*.35));
  const animScore=Math.round(useAnimatedNumber(score,800));
  const status=score>=80?'OPTIMO':score>=60?'NORMAL':'DEGRADADO';
  const quick=[
    {t:'Limpieza rápida',d:'Temp + cachés',fn:()=>runAction('Limpieza',api.cleanJunk(['temp_user','temp_win','thumbs','browser','wer']),{successFreed:true})},
    {t:'Vaciar RAM',d:`${ram.usedGB} GB en uso`,fn:()=>runAction('RAM',api.freeRam(),{successFreed:true})},
    {t:'Flush DNS',d:'Reinicia caché DNS',fn:()=>runAction('Flush DNS',api.flushDns())},
    {t:'Punto restauración',d:'Crea copia segura',fn:()=>runAction('Punto de restauración',api.createRestorePoint())},
    {t:'Reiniciar red',d:'Winsock + pila IP',fn:async()=>{
      const ok=await confirmDialog({title:'Reiniciar la pila de red',lines:['Restablece Winsock y la pila TCP/IP.'],detail:'Hace falta reiniciar el equipo para que surta efecto.',danger:true,confirmLabel:'REINICIAR RED'});
      if(!ok)return;
      const r=await runAction('Red',api.networkReset());
      if(r&&r.ok&&r.reboot)toast('Reinicia el equipo para aplicar el cambio','info');
    }},
  ];
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <AdminBanner/>
      <div style={{display:'flex',gap:0,borderBottom:'1.5px solid #262626',marginBottom:24}}>
        {[['overview','Panel general'],['profiles','Perfiles']].map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:'8px 20px',border:'none',borderBottom:tab===id?'2px solid #fff':'2px solid transparent',background:'transparent',color:tab===id?'#fff':'#8a8a8a',fontSize:11,letterSpacing:2,textTransform:'uppercase',cursor:'pointer',marginBottom:-1.5}}>{lb}</button>
        ))}
      </div>
      {tab==='profiles'&&<ProfilesPanel/>}
      {tab==='overview'&&(<React.Fragment>
        <div style={{display:'grid',gridTemplateColumns:narrow?'1fr':'200px 1fr',gap:narrow?20:32}}>
          <div style={narrow?{display:'flex',flexDirection:'row',alignItems:'center',gap:28,flexWrap:'wrap'}:{display:'flex',flexDirection:'column',gap:0}}>
            <AsciiSphere size={narrow?110:160}/>
            <div style={{marginTop:narrow?0:12}}><div style={{fontSize:narrow?44:60,fontWeight:700,lineHeight:1,color:'#fff'}}>{animScore}</div>
            <div style={{fontSize:10,color:'#9c9c9c',letterSpacing:3,textTransform:'uppercase',marginTop:2}}>&gt; {status}</div></div>
            {!narrow&&<SystemInfo/>}
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:20}}>
            <div><SLabel>Recursos del sistema (tiempo real)</SLabel>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                <BarRow label="CPU" value={Math.round(cpu)} width={28}/>
                <BarRow label="RAM" value={Math.round(ram.pct)} width={28}/>
                <BarRow label="GPU" value={Math.round(ext.gpu>0?ext.gpu:0)} width={28}/>
                <BarRow label="DISCO" value={ext.diskPct||0} width={28}/>
              </div>
            </div>
            <div><SLabel>Estado general</SLabel>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:0,border:'1.5px solid #262626'}}>
                {[['TEMPERATURA',ext.temp>0?`${ext.temp}°C`:'N/D'],['PROCESOS',ext.procs||'—'],['RED',`${ext.netMbps} MB/s`],['UPTIME',ext.uptime],['HILOS ACT.',ext.threads||'—'],['CPU FREQ.',ext.cpuFreq>0?`${ext.cpuFreq} GHz`:'—']].map(([k,v],i)=>(
                  <div key={k} style={{padding:'10px 14px',borderRight:i%3!==2?'1px solid #1f1f1f':'none',borderBottom:i<3?'1px solid #1f1f1f':'none'}}>
                    <div style={{fontSize:10,color:'#9c9c9c',letterSpacing:2,textTransform:'uppercase',marginBottom:3}}>{k}</div>
                    <div style={{fontSize:15,fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:8}}>
              {quick.map(({t,d,fn})=>(
                <button key={t} onClick={fn} style={{padding:'10px 14px',border:'1.5px solid #262626',background:'transparent',color:'#9c9c9c',textAlign:'left',fontSize:11,transition:'all .15s'}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor='#6a6a6a';e.currentTarget.style.color='#fff';e.currentTarget.style.transform='translateY(-2px)';}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor='#262626';e.currentTarget.style.color='#9c9c9c';e.currentTarget.style.transform='none';}}>
                  <div style={{fontWeight:500,marginBottom:2}}>{t}</div><div style={{fontSize:10,color:'#a8a8a8'}}>{d}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{marginTop:28,borderTop:'1.5px solid #262626',paddingTop:20}}>
          <button className="btn-pri" onClick={onOptimize} disabled={optimizing} style={{padding:'12px 28px',border:'1px solid',borderColor:optimized?'#6e6e6e':'#fff',background:'transparent',color:optimized?'#8a8a8a':'#fff',fontSize:12,letterSpacing:3,textTransform:'uppercase',fontWeight:700,cursor:optimizing?'wait':'pointer',transition:'all .15s'}}>
            {optimizing?'> OPTIMIZANDO...':optimized?'> SISTEMA OPTIMIZADO':'> OPTIMIZAR SISTEMA'}
            {optimizing&&<span className="blink"> _</span>}
          </button>
          {optimizing&&<span style={{marginLeft:16,fontSize:10,color:'#9c9c9c',letterSpacing:2}}>LIBERANDO MEMORIA Y CACHÉS</span>}
        </div>
      </React.Fragment>)}
    </div>
  );
}

/* ── File Cleaner (REAL) ───────────── */
function VaporizeOverlay({rects,onDone}){
  const ref=useRef();
  useEffect(()=>{if(!rects||!rects.length){onDone();return;}const c=ref.current,dpr=window.devicePixelRatio||1;c.width=window.innerWidth*dpr;c.height=window.innerHeight*dpr;c.style.width=window.innerWidth+'px';c.style.height=window.innerHeight+'px';const ctx=c.getContext('2d');let parts=[];rects.forEach((r,ri)=>{const dl=ri*120,cols=Math.ceil(r.width/3),rows=Math.ceil(r.height/3);for(let cc=0;cc<cols;cc++)for(let rr=0;rr<rows;rr++){parts.push({x:(r.left+cc*3)*dpr,y:(r.top+rr*3)*dpr,ox:(r.left+cc*3)*dpr,oy:(r.top+rr*3)*dpr,vx:0,vy:0,a:.15+Math.random()*.85,oa:.15+Math.random()*.85,dl,born:false});}});const DUR=1400,S=performance.now();let frame;const anim=now=>{ctx.clearRect(0,0,c.width,c.height);let alive=false;parts.forEach(p=>{const el=now-S-p.dl;if(el<0){alive=true;return;}if(!p.born){p.born=true;const ag=-Math.PI/2+(Math.random()-.5)*1.4,sp=.8+Math.random()*2.2;p.vx=Math.cos(ag)*sp;p.vy=Math.sin(ag)*sp;}const t=Math.min(1,el/DUR),sw=Math.max(0,t-(p.ox/c.width)*.5);p.x+=p.vx*(1+sw*3);p.y+=p.vy*(1+sw*2);p.a=p.oa*(1-sw*1.2);if(p.a>.01){alive=true;ctx.fillStyle=`rgba(255,255,255,${Math.max(0,p.a)})`;ctx.fillRect(p.x,p.y,1.5,1.5);}});if(alive)frame=requestAnimationFrame(anim);else{ctx.clearRect(0,0,c.width,c.height);onDone();}};frame=requestAnimationFrame(anim);return()=>cancelAnimationFrame(frame);},[rects]);
  return <canvas ref={ref} style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:9998}}/>;
}

function FileCleaner(){
  const [groups,setGroups]=useState([]);
  const [sel,setSel]=useState(new Set());
  const [scanning,setScanning]=useState(true);
  const [cleaning,setCleaning]=useState(false);
  const [vapor,setVapor]=useState(null);
  const [lastAct,setLastAct]=useState('—');
  const [scanError,setScanError]=useState(null);
  const refs=useRef({});
  const scan=useCallback(async()=>{
    setScanning(true);setScanError(null);
    if(!api){setGroups([]);setScanning(false);return;}
    try{
      const r=await api.scanJunk();
      if(r&&r.ok===false){setScanError(r.error||'No se pudo escanear el disco');setGroups([]);setScanning(false);return;}
      const g=(r&&r.data)||[];
      setGroups(g);setSel(new Set(g.map((x,i)=>x.sizeBytes>0&&x.risk==='SEGURO'?i:-1).filter(i=>i>=0)));setLastAct('Escaneado '+fmtNow());
    }catch(e){setScanError('Error al escanear');}
    setScanning(false);
  },[]);
  useEffect(()=>{scan();},[scan]);
  const toggle=i=>setSel(p=>{const n=new Set(p);n.has(i)?n.delete(i):n.add(i);return n;});
  const totalBytes=groups.filter((_,i)=>sel.has(i)).reduce((s,g)=>s+(g.sizeBytes||0),0);
  const totalItems=groups.reduce((s,g)=>s+(g.count||0),0);
  const clean=async()=>{
    if(cleaning||!sel.size)return;
    const irreversible=[...sel].map(i=>groups[i]).filter(g=>g&&g.irreversible);
    if(irreversible.length){
      const ok=await confirmDialog({
        title:'Acción irreversible',
        lines:irreversible.map(g=>`${g.label} — ${fmtBytes(g.sizeBytes||0)}, ${g.count||0} elementos`),
        detail:'Esto no se puede deshacer. Los archivos no pasarán por ninguna papelera.',
        danger:true,
        confirmLabel:'ELIMINAR DEFINITIVAMENTE',
      });
      if(!ok)return;
    }
    setCleaning(true);
    const rects=[];sel.forEach(i=>{const el=refs.current[i];if(el)rects.push(el.getBoundingClientRect());});
    const ids=[...sel].map(i=>groups[i]?.id).filter(Boolean);
    const cleanedIdx=new Set(sel);
    await runAction('Limpieza',api.cleanJunk(ids),{successFreed:true});
    setLastAct('Limpiado '+fmtNow());
    setGroups(p=>p.filter((_,i)=>!cleanedIdx.has(i)));
    setSel(new Set());refs.current={};
    setVapor(rects);setCleaning(false);
  };
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      {vapor&&<VaporizeOverlay rects={vapor} onDone={()=>setVapor(null)}/>}
      <StatGrid cols={3} items={[['LIBERABLE SELECCIONADO',fmtBytes(totalBytes)],['ARCHIVOS DETECTADOS',totalItems.toLocaleString()],['ÚLTIMO ESCANEO',lastAct]]}/>
      {scanning&&<div style={{marginBottom:16,border:'1.5px solid #303030',padding:'12px 16px'}} className="fade-in">
        <div style={{fontSize:11,color:'#a8a8a8',letterSpacing:1,marginBottom:10}}>ESCANEANDO DISCO — midiendo tamaños reales<span className="blink">_</span></div>
        <div className="scanbar"/>
      </div>}
      {!scanning&&scanError&&<div style={{marginBottom:16}}><ErrorState message={scanError} onRetry={scan}/></div>}
      {!scanError&&<div style={{border:'1.5px solid #303030'}}>
        <div style={{display:'grid',gridTemplateColumns:'24px 1fr 90px 90px 90px',padding:'8px 16px',borderBottom:'1.5px solid #303030',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}>
          <span></span><span>CATEGORIA</span><span>TAMANO</span><span>ITEMS</span><span>RIESGO</span>
        </div>
        {groups.map((g,i)=>(
          <div key={g.id} ref={el=>refs.current[i]=el} onClick={()=>toggle(i)} className="row-in"
            style={{'--i':i,display:'grid',gridTemplateColumns:'24px 1fr 90px 90px 90px',padding:'11px 16px',borderBottom:'1.5px solid #262626',cursor:'pointer',background:sel.has(i)?'#0a0a0a':'transparent',alignItems:'center',transition:'background .15s'}}
            onMouseEnter={e=>e.currentTarget.style.background='#111'} onMouseLeave={e=>e.currentTarget.style.background=sel.has(i)?'#0a0a0a':'transparent'}>
            <span style={{fontSize:12,color:sel.has(i)?'#fff':'#6e6e6e'}}>{sel.has(i)?'■':'□'}</span>
            <span style={{fontSize:12,color:sel.has(i)?'#fff':'#a8a8a8'}}>{g.label}</span>
            <span style={{fontSize:12,color:'#a8a8a8'}}>{fmtBytes(g.sizeBytes)}</span>
            <span style={{fontSize:12,color:'#9c9c9c'}}>{(g.count||0).toLocaleString()}</span>
            <span style={{fontSize:10,letterSpacing:1,color:g.risk==='SEGURO'?'#929292':g.risk==='IRREVERSIBLE'?'#ff8888':'#b5b5b5',fontWeight:g.risk==='IRREVERSIBLE'?700:500}}>{g.risk}</span>
          </div>
        ))}
        {!scanning&&groups.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>Sistema limpio — nada que eliminar</div>}
      </div>}
      <div style={{marginTop:18,display:'flex',gap:12}}>
        <button className="btn-ghost" onClick={scan} disabled={scanning} style={{padding:'10px 22px',border:'1.5px solid #5a5a5a',background:'transparent',color:scanning?'#6e6e6e':'#9c9c9c',fontSize:11,letterSpacing:2,textTransform:'uppercase',transition:'all .15s'}}>RE-ESCANEAR</button>
        <button className="btn-pri" onClick={clean} disabled={sel.size===0||!!vapor||cleaning} style={{padding:'10px 22px',border:`1px solid ${sel.size>0&&!cleaning?'#fff':'#3a3a3a'}`,background:'transparent',color:sel.size>0&&!cleaning?'#fff':'#6e6e6e',fontSize:11,letterSpacing:2,textTransform:'uppercase',cursor:sel.size>0?'pointer':'default',transition:'all .15s'}}>{cleaning?'LIMPIANDO...':`LIMPIAR (${fmtBytes(totalBytes)})`}</button>
      </div>
    </div>
  );
}

/* ── Apps sin usar + Restos de configuración (REAL) ── */
function daysAgo(iso){ return Math.floor((Date.now()-new Date(iso).getTime())/86400000); }
function fmtLastUsed(a){
  if(!a.lastUsed)return 'Sin datos';
  const d=daysAgo(a.lastUsed);
  const txt=d<=0?'Hoy':d===1?'Hace 1 día':`Hace ${d} días`;
  return a.approximate?txt+' (aprox.)':txt;
}

function UnusedAppsTab(){
  const [apps,setApps]=useState([]);
  const [warning,setWarning]=useState(null);
  const [scanned,setScanned]=useState(false);
  const {scanning,error,elapsed,run,cancel}=useCancelableScan('unused-apps');
  const scan=useCallback(async()=>{
    if(!api){setScanned(true);return;}
    const data=await run(()=>api.scanUnusedApps());
    if(data){setApps(data.apps||[]);setWarning(data.warning||null);setScanned(true);}
  },[run]);
  useEffect(()=>{scan();},[scan]);
  const openFolder=(loc)=>{
    if(!loc){toast('Esta app no tiene carpeta de instalación registrada','err');return;}
    api&&api.openAppFolder(loc);
  };
  const uninstall=async(a)=>{
    const ok=await confirmDialog({
      title:'Lanzar desinstalador',
      lines:[`Se abrirá el desinstalador oficial de "${a.name}".`],
      detail:'Vokoptimizer no borra nada por su cuenta — sigue el proceso del propio instalador (puede pedir confirmación).',
      confirmLabel:'ABRIR DESINSTALADOR',
    });
    if(!ok)return;
    const r=await api.uninstallApp(a);
    if(r&&r.ok)toast('Desinstalador lanzado','ok');else toast((r&&r.error)||'No se pudo lanzar','err');
  };
  return(<div>
    {warning&&<div style={{marginBottom:16,border:'1.5px solid #4a3a1a',background:'#151005',padding:'10px 14px',fontSize:11,color:'#e0b866'}}>⚠ {warning}</div>}
    {scanning&&<ScanProgress label="ESCANEANDO PREFETCH + REGISTRO" elapsed={elapsed} onCancel={cancel}/>}
    {!scanning&&error&&<ErrorState message={error} onRetry={scan}/>}
    {!scanning&&!error&&scanned&&<div style={{border:'1.5px solid #262626'}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 100px 120px 190px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}>
        <span>APP</span><span>TAMAÑO</span><span>ÚLTIMO USO</span><span>ACCIÓN</span>
      </div>
      {apps.map((a,i)=>(
        <div key={i} className="row-in" style={{'--i':Math.min(i,20),display:'grid',gridTemplateColumns:'1fr 100px 120px 190px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',fontSize:11,alignItems:'center'}}>
          <span style={{color:'#e5e5e5',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={a.name}>{a.name}
            {a.publisher&&<div style={{fontSize:10,color:'#7e7e7e',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.publisher}</div>}
          </span>
          <span style={{color:'#9c9c9c'}}>{a.sizeBytes?fmtBytes(a.sizeBytes):'—'}</span>
          <span style={{color:a.hasUsageData?'#9c9c9c':'#7e7e7e',fontSize:10}}>{fmtLastUsed(a)}</span>
          <span style={{display:'flex',gap:6}}>
            <button onClick={()=>openFolder(a.installLocation)} style={{fontSize:10,padding:'4px 8px',border:'1px solid #3a3a3a',background:'transparent',color:'#9c9c9c'}}>CARPETA</button>
            <button onClick={()=>uninstall(a)} style={{fontSize:10,padding:'4px 8px',border:'1px solid #3a3a3a',background:'transparent',color:'#9c9c9c'}}>DESINSTALAR</button>
          </span>
        </div>
      ))}
      {apps.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>No se encontraron apps que revisar</div>}
    </div>}
    <div style={{marginTop:18}}>
      <button className="btn-ghost" onClick={scan} disabled={scanning} style={{padding:'10px 22px',border:'1.5px solid #5a5a5a',background:'transparent',color:scanning?'#6e6e6e':'#9c9c9c',fontSize:11,letterSpacing:2,textTransform:'uppercase'}}>RE-ESCANEAR</button>
    </div>
  </div>);
}

function RemnantsTab(){
  const [remnants,setRemnants]=useState([]);
  const [scanned,setScanned]=useState(false);
  const [quarantine,setQuarantine]=useState([]);
  const {scanning,error,elapsed,run,cancel}=useCancelableScan('config-remnants');
  const loadQuarantine=useCallback(async()=>{
    if(!api)return;
    const r=await api.listQuarantine();
    setQuarantine((r&&r.data)||[]);
  },[]);
  const scan=useCallback(async()=>{
    if(!api){setScanned(true);return;}
    const data=await run(()=>api.scanConfigRemnants());
    if(data){setRemnants(data);setScanned(true);}
  },[run]);
  useEffect(()=>{scan();loadQuarantine();},[scan,loadQuarantine]);

  const quarantineOne=async(r)=>{
    const ok=await confirmDialog({
      title:'Mover a cuarentena',
      lines:[`"${r.name}" — ${fmtBytes(r.sizeBytes)}`,r.confidence==='baja'?'Confianza BAJA: no hay certeza de que esto sea un resto real.':'Confianza ALTA: no coincide con nada instalado ni en uso.'],
      detail:'Se mueve a una carpeta de cuarentena — no se borra. Se puede restaurar a su ruta exacta en cualquier momento desde esta pantalla.',
      confirmLabel:'MOVER A CUARENTENA',
    });
    if(!ok)return;
    const res=await runAction('Cuarentena',api.quarantineRemnant(r));
    if(res&&res.ok){setRemnants(p=>p.filter(x=>x.path!==r.path));loadQuarantine();}
  };
  const restore=async(q)=>{ const res=await runAction('Restaurar',api.restoreRemnant(q.id)); if(res&&res.ok)loadQuarantine(); };
  const purge=async(q)=>{
    const ok=await confirmDialog({title:'Purgar definitivamente',lines:[`"${q.label}" — ${fmtBytes(q.sizeBytes)}`],detail:'Esto sí es irreversible: se borra por completo, sin copia en ningún sitio.',danger:true,confirmLabel:'BORRAR DEFINITIVAMENTE'});
    if(!ok)return;
    const res=await runAction('Purgar',api.purgeRemnant(q.id));
    if(res&&res.ok)loadQuarantine();
  };

  return(<div>
    {scanning&&<ScanProgress label="ANALIZANDO APPDATA / PROGRAMDATA" elapsed={elapsed} onCancel={cancel}/>}
    {!scanning&&error&&<ErrorState message={error} onRetry={scan}/>}
    {!scanning&&!error&&scanned&&<div style={{border:'1.5px solid #262626',marginBottom:24}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 90px 90px 100px 130px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}>
        <span>CARPETA</span><span>TAMAÑO</span><span>ORIGEN</span><span>CONFIANZA</span><span>ACCIÓN</span>
      </div>
      {remnants.map((r,i)=>(
        <div key={r.path} className="row-in" style={{'--i':Math.min(i,20),display:'grid',gridTemplateColumns:'1fr 90px 90px 100px 130px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',fontSize:11,alignItems:'center'}}>
          <span style={{color:'#e5e5e5',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.path}>{r.name}</span>
          <span style={{color:'#9c9c9c'}}>{fmtBytes(r.sizeBytes)}</span>
          <span style={{color:'#8a8a8a',fontSize:10}}>{r.root}</span>
          <span style={{fontSize:10,letterSpacing:1,fontWeight:700,color:r.confidence==='alta'?'#88ddaa':'#bb9955'}}>{r.confidence==='alta'?'ALTA':'BAJA'}</span>
          <button onClick={()=>quarantineOne(r)} style={{fontSize:10,padding:'4px 8px',border:'1px solid #3a3a3a',background:'transparent',color:'#9c9c9c'}}>CUARENTENA</button>
        </div>
      ))}
      {remnants.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>No se encontraron restos de configuración</div>}
    </div>}
    <div style={{marginBottom:24}}>
      <button className="btn-ghost" onClick={scan} disabled={scanning} style={{padding:'10px 22px',border:'1.5px solid #5a5a5a',background:'transparent',color:scanning?'#6e6e6e':'#9c9c9c',fontSize:11,letterSpacing:2,textTransform:'uppercase'}}>RE-ESCANEAR</button>
    </div>
    <div style={{borderTop:'1.5px solid #262626',paddingTop:18}}>
      <SLabel>Cuarentena ({quarantine.length})</SLabel>
      {quarantine.length===0&&<div style={{fontSize:11,color:'#6e6e6e',padding:'6px 0 14px'}}>Nada en cuarentena todavía</div>}
      {quarantine.map(q=>(
        <div key={q.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid #1f1f1f'}}>
          <span style={{fontSize:11,color:'#c5c5c5'}}>{q.label}<span style={{color:'#7e7e7e',marginLeft:8,fontSize:10}}>{fmtBytes(q.sizeBytes)} · {fmtDate(q.quarantinedAt)}</span></span>
          <span style={{display:'flex',gap:8}}>
            <button onClick={()=>restore(q)} style={{fontSize:10,padding:'4px 10px',border:'1px solid #3a5a3a',background:'transparent',color:'#88ddaa'}}>RESTAURAR</button>
            <button onClick={()=>purge(q)} style={{fontSize:10,padding:'4px 10px',border:'1px solid #5a3a3a',background:'transparent',color:'#ff9a9a'}}>PURGAR</button>
          </span>
        </div>
      ))}
    </div>
  </div>);
}

function AppsPanel(){
  const [tab,setTab]=useState('unused');
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <div style={{display:'flex',gap:0,borderBottom:'1.5px solid #262626',marginBottom:24}}>
        {[['unused','Apps sin usar'],['remnants','Restos de configuración']].map(([id,lb])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:'8px 20px',border:'none',borderBottom:tab===id?'2px solid #fff':'2px solid transparent',background:'transparent',color:tab===id?'#fff':'#8a8a8a',fontSize:11,letterSpacing:2,textTransform:'uppercase',cursor:'pointer',marginBottom:-1.5}}>{lb}</button>
        ))}
      </div>
      {tab==='unused'&&<UnusedAppsTab/>}
      {tab==='remnants'&&<RemnantsTab/>}
    </div>
  );
}

/* ── Perfiles de juego (REAL) ──────── */
const GAME_CATEGORY_LABELS={competitivo:'Competitivo (latencia)',aaa:'AAA (rendimiento)',casual:'Casual (ligero)'};

function GamesPanel(){
  const [games,setGames]=useState([]);
  const [scanned,setScanned]=useState(false);
  const [categories,setCategories]=useState({});
  const [activeProfile,setActiveProfile]=useState(null);
  const [busyId,setBusyId]=useState(null);
  const [lastResult,setLastResult]=useState(null);
  const {scanning,error,elapsed,run,cancel}=useCancelableScan('games');

  const loadActive=useCallback(async()=>{
    if(!api)return;
    const r=await api.getActiveGameProfile();
    setActiveProfile((r&&r.data)||null);
  },[]);

  const scan=useCallback(async()=>{
    if(!api){setScanned(true);return;}
    const data=await run(()=>api.scanGames());
    if(data){
      setGames(data);
      setCategories(prev=>{
        const next={...prev};
        data.forEach(g=>{ if(!(g.id in next)) next[g.id]=g.preset.category; });
        return next;
      });
      setScanned(true);
    }
  },[run]);

  useEffect(()=>{scan();loadActive();},[scan,loadActive]);

  const apply=async(g)=>{
    setBusyId(g.id);setLastResult(null);
    const category=categories[g.id]||g.preset.category;
    const r=await api.applyGameProfile(g,category);
    setBusyId(null);
    if(r&&r.ok){
      if(r.applied===0)toast(`${g.name}: no había ningún ajuste que aplicar para "${GAME_CATEGORY_LABELS[category]}" sin ejecutable detectado`,'info');
      else toast(`${g.name} optimizado (${GAME_CATEGORY_LABELS[category]})`,'ok');
      setLastResult({gameName:g.name,failed:r.failed||[]});
      loadActive();
    }else{
      toast((r&&r.error)||'No se pudo aplicar la optimización','err');
    }
  };
  const revert=async()=>{
    setBusyId('__revert__');
    const r=await api.revertGameProfile();
    setBusyId(null);
    if(r&&r.ok){
      toast('Optimización revertida','ok');
      if(r.skipped&&r.skipped.length)toast(`${r.skipped.length} valores no se revirtieron: los modificó otro programa`,'err');
      setActiveProfile(null);
    }else{
      toast((r&&r.error)||'No se pudo revertir','err');
    }
  };

  return(<div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
    {activeProfile&&<div style={{marginBottom:16,border:'1.5px solid #3a5a3a',background:'#0a1208',padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <span style={{fontSize:11,color:'#88ddaa'}}>● {activeProfile.gameName} — optimizado ({GAME_CATEGORY_LABELS[activeProfile.category]||activeProfile.category})</span>
      <button onClick={revert} disabled={busyId==='__revert__'} style={{fontSize:10,padding:'6px 14px',border:'1px solid #5a3a3a',background:'transparent',color:'#ff9a9a'}}>{busyId==='__revert__'?'REVIRTIENDO...':'QUITAR OPTIMIZACIÓN'}</button>
    </div>}
    {lastResult&&lastResult.failed.length>0&&<div style={{marginBottom:16,border:'1.5px solid #4a3a1a',background:'#151005',padding:'10px 14px',fontSize:11,color:'#e0b866'}}>
      ⚠ {lastResult.gameName}: {lastResult.failed.length} ajustes no se pudieron aplicar (posible falta de permisos):
      <ul style={{margin:'6px 0 0',paddingLeft:18}}>{lastResult.failed.map((f,i)=>(<li key={i}>{f.label}: {f.error}</li>))}</ul>
    </div>}
    {scanning&&<ScanProgress label="BUSCANDO JUEGOS INSTALADOS" elapsed={elapsed} onCancel={cancel}/>}
    {!scanning&&error&&<ErrorState message={error} onRetry={scan}/>}
    {!scanning&&!error&&scanned&&<div style={{border:'1.5px solid #262626'}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 130px 150px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}>
        <span>JUEGO</span><span>CATEGORÍA</span><span>ACCIÓN</span>
      </div>
      {games.map(g=>(
        <div key={g.id} className="row-in" style={{display:'grid',gridTemplateColumns:'1fr 130px 150px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',fontSize:11,alignItems:'center'}}>
          <span style={{color:'#e5e5e5'}}>{g.name}
            <div style={{fontSize:10,color:'#7e7e7e'}}>{g.sources.join(' + ')}{!g.hasExe&&' · sin ejecutable detectado (solo ajustes globales)'}</div>
          </span>
          <select value={categories[g.id]||g.preset.category} onChange={e=>setCategories(p=>({...p,[g.id]:e.target.value}))}>
            <option value="competitivo">Competitivo</option>
            <option value="aaa">AAA</option>
            <option value="casual">Casual</option>
          </select>
          <button onClick={()=>apply(g)} disabled={busyId===g.id} style={{fontSize:10,padding:'6px 10px',border:'1px solid #3a3a3a',background:'transparent',color:'#9c9c9c'}}>
            {busyId===g.id?'APLICANDO...':(activeProfile&&activeProfile.gameId===g.id)?'RE-APLICAR':'OPTIMIZAR'}
          </button>
        </div>
      ))}
      {games.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>No se detectaron juegos instalados</div>}
    </div>}
    <div style={{marginTop:18}}>
      <button className="btn-ghost" onClick={scan} disabled={scanning} style={{padding:'10px 22px',border:'1.5px solid #5a5a5a',background:'transparent',color:scanning?'#6e6e6e':'#9c9c9c',fontSize:11,letterSpacing:2,textTransform:'uppercase'}}>RE-ESCANEAR</button>
    </div>
  </div>);
}

/* ── Services (REAL) ───────────────── */
function Services(){
  const [st,reload]=useAsync(()=>api?api.listServices():[]);
  const [busy,setBusy]=useState(null);
  const svcs=st.data||[];
  const act=async(s,action)=>{
    if(!s.safe&&(action==='stop'||action==='disable')){
      const ok=await confirmDialog({
        title:action==='stop'?'Detener servicio':'Desactivar servicio',
        lines:[`"${s.label}" puede ser importante para el sistema.`],
        detail:`¿Seguro que quieres ${action==='stop'?'detenerlo':'desactivarlo'}?`,
        danger:true,
      });
      if(!ok)return;
    }
    setBusy(s.name);await runAction(s.label,api.setService(s.name,action));await reload();setBusy(null);
  };
  const running=svcs.filter(s=>s.state==='Running').length;
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <StatGrid cols={4} items={[['SERVICIOS',svcs.length],['EN EJECUCION',running],['DETENIDOS',svcs.length-running],['IMPACTO ALTO',svcs.filter(s=>s.impact==='ALTO').length]]}/>
      {st.loading&&<Loading label="Consultando servicios del sistema"/>}
      {!st.loading&&st.error&&<ErrorState message={st.error} onRetry={reload}/>}
      {!st.loading&&!st.error&&<div style={{border:'1.5px solid #262626'}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 110px 90px 110px 80px 96px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}>
          <span>SERVICIO</span><span>ESTADO</span><span>IMPACTO</span><span>INICIO</span><span></span><span>ACCION</span>
        </div>
        {svcs.map((s,i)=>{const on=s.state==='Running';return(
          <div key={s.name} className="row-in" style={{'--i':i,display:'grid',gridTemplateColumns:'1fr 110px 90px 110px 80px 96px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',alignItems:'center',transition:'background .15s'}}
            onMouseEnter={e=>e.currentTarget.style.background='#101010'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{fontSize:12}}>{s.label}<div style={{fontSize:10,color:'#7e7e7e'}}>{s.desc}</div></span>
            <span style={{fontSize:10,letterSpacing:1,color:on?'#d8d8d8':'#6e6e6e'}}>{on?'● ':'○ '}{on?'ACTIVO':'DETENIDO'}</span>
            <span style={{fontSize:10,color:s.impact==='ALTO'?'#cc8866':s.impact==='MEDIO'?'#a8a8a8':'#7e7e7e'}}>{s.impact}</span>
            <select value={s.startMode==='Auto'?'auto':s.startMode==='Manual'?'manual':s.startMode==='Disabled'?'disable':'manual'} onChange={e=>act(s,e.target.value)} disabled={busy===s.name}>
              <option value="auto">Automatico</option><option value="manual">Manual</option><option value="disable">Desactivado</option>
            </select>
            <span style={{fontSize:10,color:'#6e6e6e'}}>{busy===s.name&&<span className="spinner"/>}</span>
            <button onClick={()=>act(s,on?'stop':'start')} disabled={busy===s.name} style={{padding:'4px 8px',border:'1px solid #3a3a3a',background:'transparent',color:'#9c9c9c',fontSize:10,letterSpacing:1}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor='#9a9a9a';e.currentTarget.style.color='#fff';}} onMouseLeave={e=>{e.currentTarget.style.borderColor='#3a3a3a';e.currentTarget.style.color='#9c9c9c';}}>
              {on?'DETENER':'INICIAR'}
            </button>
          </div>
        );})}
      </div>}
      <div style={{marginTop:12,fontSize:10,color:'#7e7e7e'}}>Cambia el tipo de inicio en el desplegable o detén el servicio al instante. Los cambios son reversibles.</div>
    </div>
  );
}

/* ── Startup Manager (REAL) ────────── */
function StartupManager(){
  const [st,reload]=useAsync(()=>api?api.listStartup():[]);
  const [busy,setBusy]=useState(null);
  const items=st.data||[];
  const toggle=async(it)=>{setBusy(it.name+it.location);await runAction(it.name,api.toggleStartup(it,!it.enabled));await reload();setBusy(null);};
  const enabled=items.filter(i=>i.enabled).length;
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <StatGrid cols={3} items={[['PROGRAMAS DE ARRANQUE',items.length],['ACTIVOS',enabled],['DESACTIVADOS',items.length-enabled]]}/>
      {st.loading&&<Loading label="Leyendo programas de inicio"/>}
      {!st.loading&&st.error&&<ErrorState message={st.error} onRetry={reload}/>}
      {!st.loading&&!st.error&&<div style={{border:'1.5px solid #262626'}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 2fr 90px 110px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}>
          <span>PROGRAMA</span><span>COMANDO</span><span>ORIGEN</span><span>ESTADO</span>
        </div>
        {items.map((it,i)=>(
          <div key={i} className="row-in" style={{'--i':i,display:'grid',gridTemplateColumns:'1fr 2fr 90px 110px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',alignItems:'center',transition:'background .15s'}}
            onMouseEnter={e=>e.currentTarget.style.background='#101010'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{fontSize:12,color:it.enabled?'#e5e5e5':'#7e7e7e',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={it.name}>{it.name}</span>
            <span style={{fontSize:10,color:'#7e7e7e',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={it.command}>{it.command}</span>
            <span style={{fontSize:10,color:'#8a8a8a'}}>{it.location}·{it.source==='Folder'?'Carpeta':'Registro'}</span>
            <button onClick={()=>toggle(it)} disabled={busy===it.name+it.location} style={{padding:'4px 10px',border:`1px solid ${it.enabled?'#338855':'#553333'}`,background:'transparent',color:it.enabled?'#88ddaa':'#cc7777',fontSize:10,letterSpacing:1}}>
              {busy===it.name+it.location?'...':it.enabled?'● ACTIVO':'○ INACTIVO'}
            </button>
          </div>
        ))}
        {items.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>No hay programas de arranque configurados</div>}
      </div>}
      <div style={{marginTop:12,fontSize:10,color:'#7e7e7e'}}>Desactivar programas de inicio acelera el arranque. Es totalmente reversible (mismo mecanismo que el Administrador de tareas).</div>
    </div>
  );
}

/* ── CPU/RAM Optimizer (REAL) ──────── */
function CpuOptimizer({metrics}){
  const [phase,setPhase]=useState('idle');
  const [step,setStep]=useState(0);
  const [result,setResult]=useState(null);
  const narrow=useWindowSize().w<980;
  const {ram,ext,topProcs}=metrics;
  const steps=['Identificando procesos en segundo plano...','Vaciando working set de procesos inactivos...','Compactando memoria de trabajo...','Ejecutando recolección de basura...','Vaciando caché DNS...','Verificando memoria liberada...'];
  const run=async()=>{
    setPhase('running');setStep(0);setResult(null);
    const tick=setInterval(()=>setStep(s=>Math.min(steps.length,s+1)),420);
    const r=api?await api.freeRam():{ok:true,freed:0,procs:0};
    clearInterval(tick);setStep(steps.length);
    setResult(r);setPhase('done');
    if(r&&r.ok!==false)toast(`RAM liberada: ${fmtBytes(r.freed||0)}`,'ok');
  };
  const kill=async(p)=>{
    if(!p.pid)return;
    const ok=await confirmDialog({title:'Finalizar proceso',lines:[`"${p.Name}" (PID ${p.pid})`],danger:true,confirmLabel:'FINALIZAR'});
    if(!ok)return;
    await runAction('Finalizar '+p.Name,api.killProcess(p.pid));
  };
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <div style={{display:'grid',gridTemplateColumns:narrow?'1fr':'1fr 1fr',gap:28}}>
        <div>
          <SLabel>Proceso de optimización</SLabel>
          <div style={{border:'1.5px solid #262626',padding:16,minHeight:240,background:'#0a0a0a'}}>
            {phase==='idle'&&<div style={{color:'#5a5a5a',fontSize:11}}><div>&gt; Sistema listo para optimización</div><div>&gt; RAM en uso: {ram.pct}% ({ram.usedGB} GB / {ram.totalGB} GB)</div><div>&gt; Procesos activos: {ext.procs}</div><div style={{marginTop:12,color:'#4a4a4a'}}>Esperando inicio<span className="blink">_</span></div></div>}
            {(phase==='running'||phase==='done')&&steps.map((s,i)=>(<div key={i} style={{fontSize:11,marginBottom:4,color:i<step?'#9c9c9c':i===step?'#fff':'#4a4a4a'}}>{i<step?'✓':i===step?'>':' '} {s}</div>))}
            {phase==='done'&&result&&<div style={{marginTop:12,borderTop:'1.5px solid #262626',paddingTop:10}}><div style={{fontSize:11,color:'#fff'}}>&gt; OPTIMIZACIÓN COMPLETADA</div><div style={{fontSize:11,color:'#9c9c9c',marginTop:4}}>Memoria liberada: {fmtBytes(result.freed||0)} · {result.procs||0} procesos · {fmtNow()}</div></div>}
          </div>
          <div style={{marginTop:14,display:'flex',gap:10}}>
            <button className="btn-pri" onClick={run} disabled={phase==='running'} style={{padding:'10px 22px',border:'1px solid',borderColor:phase==='running'?'#3a3a3a':'#fff',background:'transparent',color:phase==='running'?'#6e6e6e':'#fff',fontSize:11,letterSpacing:2,textTransform:'uppercase',transition:'all .15s'}}>{phase==='running'?'EJECUTANDO...':'LIBERAR MEMORIA'}{phase==='running'&&<span className="blink"> _</span>}</button>
            {phase==='done'&&<button onClick={()=>{setPhase('idle');setStep(0);}} style={{padding:'10px 22px',border:'1px solid #3a3a3a',background:'transparent',color:'#7e7e7e',fontSize:11,letterSpacing:2,textTransform:'uppercase'}}>RESET</button>}
          </div>
        </div>
        <div>
          <SLabel>Memoria (tiempo real)</SLabel>
          <div style={{display:'flex',flexDirection:'column',gap:0,border:'1.5px solid #262626'}}>
            {[['RAM instalada',`${ram.totalGB} GB`],['En uso',`${ram.pct}% · ${ram.usedGB} GB`],['Disponible',`${ram.freeGB} GB`]].map(([k,v])=>(<div key={k} style={{display:'flex',justifyContent:'space-between',padding:'10px 16px',borderBottom:'1px solid #1f1f1f'}}><span style={{fontSize:11,color:'#a8a8a8'}}>{k}</span><span style={{fontSize:11,color:'#d8d8d8'}}>{v}</span></div>))}
          </div>
          <div style={{marginTop:20}}><SLabel>Top procesos por memoria</SLabel>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {(topProcs||[]).slice(0,6).map((p,i)=>(<div key={i} style={{display:'flex',gap:8,alignItems:'center'}}>
                <span style={{width:110,fontSize:11,color:'#9c9c9c',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={p.Name}>{p.Name}</span>
                <span style={{fontSize:11,flex:1}}><BarGlyph pct={Math.min(100,Math.round((p.MemMB||0)/2000*100))} w={18}/></span>
                <span style={{fontSize:10,color:'#929292',width:60,textAlign:'right'}}>{p.MemMB||0} MB</span>
                <button onClick={()=>kill(p)} title="Finalizar proceso" style={{border:'1px solid #3a2525',background:'transparent',color:'#774444',fontSize:10,padding:'2px 6px'}} onMouseEnter={e=>{e.currentTarget.style.color='#cc6666';e.currentTarget.style.borderColor='#553333';}} onMouseLeave={e=>{e.currentTarget.style.color='#774444';e.currentTarget.style.borderColor='#3a2525';}}>✕</button>
              </div>))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Maintenance: Registry + Health (REAL) ── */
function RegistryCleaner(){
  const [findings,setFindings]=useState([]);
  const [sel,setSel]=useState(new Set());
  const [scanning,setScanning]=useState(false);
  const [scanned,setScanned]=useState(false);
  const [cleaning,setCleaning]=useState(false);
  const [log,setLog]=useState('');
  const [healthRunning,setHealthRunning]=useState(false);
  const [scanError,setScanError]=useState(null);
  const logRef=useRef();
  useEffect(()=>{if(!api)return;const off1=api.onHealthLog(l=>setLog(p=>(p+l).slice(-8000)));const off2=api.onHealthDone(r=>{setHealthRunning(false);toast(r&&r.cancelled?'Reparación cancelada':'Reparación finalizada',r&&r.cancelled?'info':'ok');});return()=>{off1&&off1();off2&&off2();};},[]);
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);
  const scan=async()=>{
    setScanning(true);setScanned(false);setScanError(null);
    const r=api?await api.scanRegistry():{ok:true,data:[]};
    if(r&&r.ok===false){setScanError(r.error||'No se pudo escanear el registro');setFindings([]);setScanning(false);return;}
    const f=(r&&r.data)||[];
    setFindings(f);setSel(new Set(f.map((_,i)=>i)));setScanned(true);setScanning(false);
    toast(`${f.length} entradas obsoletas encontradas`,'ok');
  };
  const toggle=i=>setSel(p=>{const n=new Set(p);n.has(i)?n.delete(i):n.add(i);return n;});
  const clean=async()=>{
    if(!sel.size)return;
    const ok=await confirmDialog({
      title:'Eliminar entradas del registro',
      lines:[`Se eliminarán ${sel.size} entradas del registro.`],
      detail:'Se creará una copia .reg de seguridad antes de borrar cada una; si el backup falla, esa entrada se omite.',
      danger:true,
    });
    if(!ok)return;
    setCleaning(true);
    const items=[...sel].map(i=>findings[i]).filter(Boolean);
    const r=await api.cleanRegistry(items);
    if(r&&r.ok){toast(`${r.done} entradas eliminadas (backup guardado)`,'ok');setFindings(p=>p.filter((_,i)=>!sel.has(i)));setSel(new Set());}
    else toast((r&&r.error)||'No se pudo limpiar','err');
    setCleaning(false);
  };
  const runHealth=async(kind)=>{setLog('');setHealthRunning(true);const r=await api.runHealth(kind);if(r&&r.ok===false){setHealthRunning(false);toast(r.error||'No disponible','err');}};
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <StatGrid cols={4} items={[['ENTRADAS OBSOLETAS',scanned?findings.length:'—'],['SELECCIONADAS',sel.size],['GRAVEDAD MEDIA+',findings.filter(r=>r.severity!=='BAJA').length],['ESTADO',scanned?(findings.length?'PENDIENTE':'LIMPIO'):'SIN ESCANEAR']]}/>
      {scanning&&<div style={{marginBottom:16,border:'1.5px solid #262626',padding:'12px 16px'}} className="fade-in">
        <div style={{fontSize:11,color:'#a8a8a8',letterSpacing:1,marginBottom:10}}>ANALIZANDO REGISTRO — buscando entradas huérfanas reales<span className="blink">_</span></div>
        <div className="scanbar"/>
      </div>}
      {!scanning&&scanError&&<div style={{marginBottom:16}}><ErrorState message={scanError} onRetry={scan}/></div>}
      {!scanError&&<div style={{border:'1.5px solid #262626'}}>
        <div style={{display:'grid',gridTemplateColumns:'24px 1fr 150px 80px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}><span></span><span>ENTRADA</span><span>TIPO</span><span>GRAVEDAD</span></div>
        {findings.map((r,i)=>(
          <div key={i} onClick={()=>toggle(i)} className="row-in" style={{'--i':i,display:'grid',gridTemplateColumns:'24px 1fr 150px 80px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',cursor:'pointer',alignItems:'center',transition:'background .15s'}}
            onMouseEnter={e=>e.currentTarget.style.background='#101010'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{color:sel.has(i)?'#fff':'#6e6e6e'}}>{sel.has(i)?'■':'□'}</span>
            <span style={{fontSize:10,color:'#9c9c9c',overflow:'hidden'}}><div style={{color:'#c5c5c5',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.name}</div><div style={{color:'#7e7e7e',fontSize:10,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.key}>{r.key}</div></span>
            <span style={{fontSize:10,color:'#a8a8a8'}}>{r.type}</span>
            <span style={{fontSize:10,letterSpacing:1,color:r.severity==='ALTA'?'#cc7766':r.severity==='MEDIA'?'#bb9955':'#7e7e7e'}}>{r.severity}</span>
          </div>
        ))}
        {scanned&&findings.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>Registro limpio — sin entradas huérfanas</div>}
        {!scanned&&!scanning&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>Pulsa ESCANEAR para analizar el registro</div>}
      </div>}
      <div style={{marginTop:18,display:'flex',gap:12,flexWrap:'wrap'}}>
        <button onClick={scan} disabled={scanning} style={{padding:'10px 22px',border:'1.5px solid #4a4a4a',background:'transparent',color:'#9c9c9c',fontSize:11,letterSpacing:2,textTransform:'uppercase'}}
          onMouseEnter={e=>{e.currentTarget.style.color='#fff';e.currentTarget.style.borderColor='#9a9a9a';}} onMouseLeave={e=>{e.currentTarget.style.color='#9c9c9c';e.currentTarget.style.borderColor='#4a4a4a';}}>ESCANEAR REGISTRO</button>
        <button className="btn-pri" onClick={clean} disabled={!sel.size||cleaning} style={{padding:'10px 22px',border:`1.5px solid ${sel.size&&!cleaning?'#fff':'#3a3a3a'}`,background:'transparent',color:sel.size&&!cleaning?'#fff':'#6e6e6e',fontSize:11,letterSpacing:2,textTransform:'uppercase',transition:'all .15s'}}>{cleaning?'LIMPIANDO...':'LIMPIAR (con backup)'}</button>
        <button onClick={()=>api&&api.openBackups()} style={{padding:'10px 22px',border:'1.5px solid #383838',background:'transparent',color:'#8a8a8a',fontSize:11,letterSpacing:2,textTransform:'uppercase'}}>ABRIR BACKUPS</button>
      </div>

      <div style={{marginTop:28,borderTop:'1.5px solid #262626',paddingTop:20}}>
        <SLabel>Salud y reparación del sistema</SLabel>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:14}}>
          <button onClick={()=>runAction('Punto de restauración',api.createRestorePoint())} style={{padding:'9px 18px',border:'1.5px solid #4a4a4a',background:'transparent',color:'#b5b5b5',fontSize:10,letterSpacing:2,textTransform:'uppercase'}}>Crear punto de restauración</button>
          <button className="btn-ghost" onClick={()=>runHealth('sfc')} disabled={healthRunning} style={{padding:'9px 18px',border:'1.5px solid #4a4a4a',background:'transparent',color:healthRunning?'#6e6e6e':'#b5b5b5',fontSize:10,letterSpacing:2,textTransform:'uppercase',transition:'all .15s'}}>SFC /scannow</button>
          <button className="btn-ghost" onClick={()=>runHealth('dism')} disabled={healthRunning} style={{padding:'9px 18px',border:'1.5px solid #4a4a4a',background:'transparent',color:healthRunning?'#6e6e6e':'#b5b5b5',fontSize:10,letterSpacing:2,textTransform:'uppercase',transition:'all .15s'}}>DISM /RestoreHealth</button>
          <button className="btn-pri" onClick={()=>runHealth('all')} disabled={healthRunning} style={{padding:'9px 18px',border:`1.5px solid ${healthRunning?'#3a3a3a':'#fff'}`,background:'transparent',color:healthRunning?'#6e6e6e':'#fff',fontSize:10,letterSpacing:2,textTransform:'uppercase',transition:'all .15s'}}>{healthRunning?'EJECUTANDO...':'Reparación completa'}</button>
          {healthRunning&&<button onClick={()=>api&&api.cancelHealth()} style={{padding:'9px 18px',border:'1.5px solid #6a3a3a',background:'transparent',color:'#ff9a9a',fontSize:10,letterSpacing:2,textTransform:'uppercase'}}>CANCELAR</button>}
        </div>
        {(log||healthRunning)&&<div ref={logRef} style={{border:'1.5px solid #262626',background:'#080808',padding:'12px 14px',height:180,overflowY:'auto',fontSize:10,color:'#9c9c9c',whiteSpace:'pre-wrap',lineHeight:1.5}}>
          {log||'Iniciando...'}{healthRunning&&<span className="blink">_</span>}
        </div>}
        <div style={{marginTop:10,fontSize:10,color:'#7e7e7e'}}>SFC y DISM reparan archivos de sistema dañados. Pueden tardar varios minutos y requieren administrador.</div>
      </div>
    </div>
  );
}

/* ── Monitor (REAL) ────────────────── */
function useH60(init){const [d,setD]=useState(()=>Array(60).fill(init));const push=useCallback(v=>setD(p=>[...p.slice(1),v]),[]);return[d,push];}
function MonitorPanel({metrics}){
  const narrow=useWindowSize().w<980;
  const [cpuH,pC]=useH60(40);const [ramH,pR]=useH60(60);const [gpuH,pG]=useH60(25);const [netH,pN]=useH60(10);
  useEffect(()=>{pC(Math.round(metrics.cpu));pR(Math.round(metrics.ram.pct));pG(Math.round(metrics.ext.gpu>0?metrics.ext.gpu:0));pN(Math.round(metrics.ext.netMbps||0));},[metrics]);
  const charts=[{label:'PROCESADOR',data:cpuH,cur:Math.round(metrics.cpu),unit:'%'},{label:'MEMORIA RAM',data:ramH,cur:Math.round(metrics.ram.pct),unit:'%'},{label:'GPU',data:gpuH,cur:Math.round(metrics.ext.gpu>0?metrics.ext.gpu:0),unit:'%'},{label:'RED',data:netH,cur:Math.round(metrics.ext.netMbps||0),unit:' MB/s'}];
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <div style={{display:'grid',gridTemplateColumns:narrow?'1fr':'1fr 1fr',gap:16,marginBottom:16}}>
        {charts.map(c=>(
          <div key={c.label} style={{border:'1.5px solid #262626',padding:'14px 16px'}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:10}}><span style={{fontSize:10,color:'#6e6e6e',letterSpacing:3,textTransform:'uppercase'}}>{c.label}</span><span style={{fontSize:24,fontWeight:700}}>{c.cur}{c.unit}</span></div>
            <LineCanvas data={c.data} h={64}/>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:6}}>
              <span style={{fontSize:10,color:'#8a8a8a'}}>MIN: {Math.round(Math.min(...c.data))}{c.unit}</span>
              <span style={{fontSize:10,color:'#8a8a8a'}}>AVG: {Math.round(c.data.reduce((a,b)=>a+b,0)/c.data.length)}{c.unit}</span>
              <span style={{fontSize:10,color:'#8a8a8a'}}>MAX: {Math.round(Math.max(...c.data))}{c.unit}</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{border:'1.5px solid #262626'}}>
        <div style={{padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,color:'#9c9c9c',letterSpacing:2}}>// PROCESOS ACTIVOS (TIEMPO REAL)</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 80px 90px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,color:'#8a8a8a',letterSpacing:2,textTransform:'uppercase'}}><span>PROCESO</span><span>CPU</span><span>RAM</span></div>
        {(metrics.topProcs||[]).slice(0,6).map((p,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 80px 90px',padding:'9px 16px',borderBottom:'1px solid #1f1f1f',fontSize:11}}
            onMouseEnter={e=>e.currentTarget.style.background='#101010'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{color:'#9c9c9c'}}>{p.Name}</span><span style={{color:'#a8a8a8'}}>{p.CPU||0}%</span><span style={{color:'#a8a8a8'}}>{p.MemMB||0} MB</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── History (REAL) ────────────────── */
function History(){
  const [st,reload]=useAsync(()=>api?api.getHistory():[]);
  const rows=st.data||[];
  const totalFreed=rows.reduce((s,r)=>s+(r.freed||0),0);
  const clearAll=async()=>{
    const ok=await confirmDialog({title:'Borrar historial',lines:['Se borrará todo el historial de acciones.'],danger:true});
    if(!ok)return;
    await api.clearHistory();reload();
  };
  return(
    <div style={{height:'100%',overflowY:'auto',padding:'24px 28px'}} className="fade-in">
      <StatGrid cols={3} items={[['OPERACIONES',rows.length],['ESPACIO LIBERADO',fmtBytes(totalFreed)],['ÚLTIMA',rows[0]?fmtDate(rows[0].ts):'—']]}/>
      {st.loading&&<Loading/>}
      {!st.loading&&<div style={{border:'1.5px solid #262626'}}>
        <div style={{display:'grid',gridTemplateColumns:'130px 1fr 1fr 90px 60px',padding:'8px 16px',borderBottom:'1.5px solid #262626',fontSize:10,fontWeight:600,color:'#b5b5b5',letterSpacing:2,textTransform:'uppercase'}}><span>FECHA</span><span>OPERACIÓN</span><span>DETALLE</span><span>LIBERADO</span><span>ESTADO</span></div>
        {rows.map((r,i)=>(
          <div key={i} className="row-in" style={{'--i':Math.min(i,20),display:'grid',gridTemplateColumns:'130px 1fr 1fr 90px 60px',padding:'10px 16px',borderBottom:'1px solid #1f1f1f',fontSize:11,alignItems:'center',transition:'background .15s'}}
            onMouseEnter={e=>e.currentTarget.style.background='#101010'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{color:'#9c9c9c',fontSize:10}}>{fmtDate(r.ts)}</span><span style={{color:'#d8d8d8'}}>{r.op}</span>
            <span style={{color:'#8a8a8a',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={r.detail}>{r.detail}</span>
            <span style={{color:'#9c9c9c'}}>{r.freed?fmtBytes(r.freed):'—'}</span>
            <span style={{color:r.status==='OK'?'#8a8a8a':'#bb9955',fontSize:10,letterSpacing:1}}>{r.status==='OK'?'● OK':'! '+r.status}</span>
          </div>
        ))}
        {rows.length===0&&<div style={{padding:'24px 16px',textAlign:'center',fontSize:11,color:'#6e6e6e'}}>Sin operaciones registradas todavía</div>}
      </div>}
      {rows.length>0&&<div style={{marginTop:16}}><button onClick={clearAll} style={{padding:'9px 18px',border:'1.5px solid #383838',background:'transparent',color:'#8a8a8a',fontSize:10,letterSpacing:2,textTransform:'uppercase'}}>Borrar historial</button></div>}
    </div>
  );
}

/* ── Orbital Menu ──────────────────── */
const TOOLS=[{id:'dashboard',label:'Dashboard',sub:'Estado general'},{id:'files',label:'Limpiar archivos',sub:'Escaneo real de disco'},{id:'apps',label:'Apps y restos',sub:'Software arrastrado'},{id:'services',label:'Servicios',sub:'Servicios del sistema'},{id:'startup',label:'Arranque',sub:'Programas de inicio'},{id:'cpu',label:'CPU / RAM',sub:'Optimización memoria'},{id:'games',label:'Perfiles de juego',sub:'Optimización por título'},{id:'registry',label:'Mantenimiento',sub:'Registro y reparación'},{id:'monitor',label:'Monitoreo',sub:'Tiempo real'},{id:'history',label:'Historial',sub:'Operaciones'}];

// Monochrome stroke icons (SVG) — consistent rendering, no emoji fallback
function Icon({id,size=20}){
  const s={width:size,height:size,display:'block'};
  const p={fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'square'};
  switch(id){
    case 'dashboard':return(<svg style={s} viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" {...p}/><rect x="13.5" y="3.5" width="7" height="7" {...p}/><rect x="3.5" y="13.5" width="7" height="7" {...p}/><rect x="13.5" y="13.5" width="7" height="7" {...p}/></svg>);
    case 'files':return(<svg style={s} viewBox="0 0 24 24"><path d="M6.5 3.5 h8 l4 4 v13 h-12 z" {...p}/><path d="M14.5 3.5 v4 h4" {...p}/><path d="M9 12h6M9 15.5h6" {...p}/></svg>);
    case 'apps':return(<svg style={s} viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1" {...p}/><path d="M8 9h8M8 12.5h8M8 16h5" {...p}/></svg>);
    case 'services':return(<svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" {...p}/><path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2M5.3 5.3l2.2 2.2M16.5 16.5l2.2 2.2M18.7 5.3l-2.2 2.2M7.5 16.5l-2.2 2.2" {...p}/></svg>);
    case 'startup':return(<svg style={s} viewBox="0 0 24 24"><path d="M12 3 v8" {...p}/><path d="M7.5 6.2 a7 7 0 1 0 9 0" {...p}/></svg>);
    case 'cpu':return(<svg style={s} viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" {...p}/><rect x="10.5" y="10.5" width="3" height="3" {...p}/><path d="M9.5 2.5v4M14.5 2.5v4M9.5 17.5v4M14.5 17.5v4M2.5 9.5h4M2.5 14.5h4M17.5 9.5h4M17.5 14.5h4" {...p}/></svg>);
    case 'games':return(<svg style={s} viewBox="0 0 24 24"><rect x="2.5" y="8" width="19" height="10" rx="3" {...p}/><path d="M7 11v4M5 13h4" {...p}/><circle cx="16" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="18.5" cy="14.5" r="1" fill="currentColor" stroke="none"/></svg>);
    case 'registry':return(<svg style={s} viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h16" {...p}/><circle cx="9.5" cy="6.5" r="1.8" {...p}/><circle cx="15" cy="12" r="1.8" {...p}/><circle cx="7.5" cy="17.5" r="1.8" {...p}/></svg>);
    case 'monitor':return(<svg style={s} viewBox="0 0 24 24"><path d="M2.5 13 h4.5 l2.5 -7 4 12 2.5 -7 h5.5" {...p}/></svg>);
    case 'history':return(<svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" {...p}/><path d="M12 7.5 v4.5 l3.5 2" {...p}/></svg>);
    default:return null;
  }
}

const SKULL_LINES=['  ████████████████  ','██                ██','██  ████    ████  ██','██  ████    ████  ██','██                ██','██  ████████████  ██','████████████████████','  ██  ████████  ██  ','  ████        ████  ','   ██          ██   '];

function OrbitalMenu({onSelect}){
  const [angle,setAngle]=useState(0);const [hov,setHov]=useState(null);const [exiting,setExiting]=useState(false);const [eyeOpen,setEyeOpen]=useState(true);const raf=useRef();const lt=useRef(0);const paused=hov!==null;
  const {w:vw,h:vh}=useWindowSize();
  useEffect(()=>{const id=setInterval(()=>setEyeOpen(e=>!e),500);return()=>clearInterval(id);},[]);
  useEffect(()=>{const step=t=>{if(!paused){const dt=lt.current?t-lt.current:0;setAngle(a=>(a+dt*.018)%360);}lt.current=t;raf.current=requestAnimationFrame(step);};raf.current=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf.current);},[paused]);
  const sel=id=>{setExiting(true);setTimeout(()=>onSelect(id),420);};const N=TOOLS.length;
  // Elliptical orbit that adapts to the window (title bar = 32px, labels need ~70px below nodes)
  const Rx=Math.max(230,Math.min(430,vw/2-130));
  const Ry=Math.max(150,Math.min(330,(vh-32)/2-105));
  const compact=vh<660||vw<880;
  return(
    <div style={{position:'fixed',top:32,left:0,right:0,bottom:0,background:'#000',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center',opacity:exiting?0:1,transition:'opacity .4s ease',overflow:'hidden'}}>
      <div style={{position:'absolute',width:Rx*2,height:Ry*2,borderRadius:'50%',border:'1.5px solid #444',pointerEvents:'none'}}/>
      <div style={{position:'absolute',width:Math.min(Rx,Ry)*2*.5,height:Math.min(Rx,Ry)*2*.5,borderRadius:'50%',border:'1.5px dashed #2c2c2c',pointerEvents:'none',animation:'spin 90s linear infinite'}}/>
      <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:10,pointerEvents:'none'}}>
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',animation:'floatY 7s ease-in-out infinite'}}>
          <pre style={{fontFamily:'var(--mono)',fontSize:compact?9:12,lineHeight:1.5,color:'#fff',userSelect:'none',margin:0,textAlign:'center',whiteSpace:'pre',fontWeight:700}}>{SKULL_LINES.map((l,i)=>(i>=2&&i<=3&&!eyeOpen?l.replace(/████/g,'░░░░'):l).trim()).join('\n')}</pre>
          <div style={{marginTop:compact?6:10,fontSize:11,fontWeight:700,letterSpacing:4,color:'#fff',textTransform:'uppercase',textAlign:'center'}}>Vokoptimizer</div>
          <div style={{fontSize:9,color:'#6e6e6e',letterSpacing:3,marginTop:3,textTransform:'uppercase'}}>v4.2.0 · System Optimizer</div>
        </div>
      </div>
      {TOOLS.map((tool,i)=>{const deg=((i/N)*360+angle)%360,rad=deg*Math.PI/180,x=Rx*Math.cos(rad),y=Ry*Math.sin(rad),depth=(Math.sin(rad)+1)/2,isH=hov===tool.id;const sz=compact?46:58;return(
        <div key={tool.id} onMouseEnter={()=>setHov(tool.id)} onMouseLeave={()=>setHov(null)} onClick={()=>sel(tool.id)}
          style={{position:'absolute',transform:`translate(${x}px,${y}px)`,zIndex:isH?50:Math.round(10+depth*30),opacity:isH?1:.55+depth*.45,transition:'opacity .2s',cursor:'pointer'}}>
          <div style={{width:sz,height:sz,borderRadius:'50%',border:`1.5px solid ${isH?'#fff':'#a8a8a8'}`,background:isH?'#fff':'#000',display:'flex',alignItems:'center',justifyContent:'center',transform:`translate(-50%,-50%) scale(${isH?1.12:1})`,transition:'border-color .2s,background .2s,box-shadow .2s,transform .25s cubic-bezier(.2,.8,.2,1)',boxShadow:isH?'0 0 36px rgba(255,255,255,.25)':'none',position:'relative',animation:'nodeIn .5s cubic-bezier(.2,.8,.2,1) backwards',animationDelay:`${i*55}ms`}}>
            <span style={{color:isH?'#000':'#e5e5e5',userSelect:'none',transition:'color .2s'}}><Icon id={tool.id} size={compact?17:21}/></span>
            <svg style={{position:'absolute',top:'50%',left:'50%',pointerEvents:'none',overflow:'visible',zIndex:-1}}><line x1={0} y1={0} x2={-x} y2={-y} stroke={isH?'rgba(255,255,255,.3)':'rgba(255,255,255,.1)'} strokeWidth="1" strokeDasharray="3 4"/></svg>
          </div>
          <div style={{position:'absolute',top:compact?30:38,left:'50%',transform:'translateX(-50%)',textAlign:'center',pointerEvents:'none',whiteSpace:'nowrap'}}>
            <div style={{fontSize:compact?10:12,fontWeight:isH?700:600,color:isH?'#fff':'#e5e5e5',letterSpacing:1,transition:'all .2s',textTransform:'uppercase'}}>{tool.label}</div>
            {isH&&<div style={{fontSize:10,color:'#9c9c9c',letterSpacing:1,marginTop:2}}>{tool.sub}</div>}
          </div>
        </div>
      );})}
      <div style={{position:'absolute',bottom:14,fontSize:10,color:'#9c9c9c',letterSpacing:3,textTransform:'uppercase'}}>SELECCIONA UN MODULO</div>
    </div>
  );
}

/* ── Intro ─────────────────────────── */
const BOOT_LINES=['> VOKOPTIMIZER v4.2.0','> Inicializando kernel de optimizacion...','  [OK] Escaneo real de disco','  [OK] Gestor de servicios','  [OK] Gestor de arranque','  [OK] Optimizacion CPU/RAM','  [OK] Mantenimiento y registro','  [OK] Monitor de recursos','> SISTEMA LISTO'];
function Intro({onDone}){
  const [rev,setRev]=useState(0);const [eyeOpen,setEyeOpen]=useState(true);const [bl,setBl]=useState(-1);const [bc,setBc]=useState(0);const [sp,setSp]=useState(false);const [ex,setEx]=useState(false);
  useEffect(()=>{if(rev>=SKULL_LINES.length)return;const id=setTimeout(()=>setRev(r=>r+1),60);return()=>clearTimeout(id);},[rev]);
  useEffect(()=>{if(rev<SKULL_LINES.length)return;const ey=setInterval(()=>setEyeOpen(e=>!e),500);const bt=setTimeout(()=>setBl(0),400);return()=>{clearInterval(ey);clearTimeout(bt);};},[rev]);
  useEffect(()=>{if(bl<0||bl>=BOOT_LINES.length)return;const line=BOOT_LINES[bl];if(bc<line.length){const id=setTimeout(()=>setBc(c=>c+1),16);return()=>clearTimeout(id);}else{const d=bl===BOOT_LINES.length-1?500:60;const id=setTimeout(()=>{setBl(l=>l+1);setBc(0);},d);return()=>clearTimeout(id);}},[bl,bc]);
  useEffect(()=>{if(bl>=BOOT_LINES.length){const id=setTimeout(()=>setSp(true),300);return()=>clearTimeout(id);}},[bl]);
  const exit=useCallback(()=>{if(!sp)return;setEx(true);setTimeout(onDone,500);},[sp,onDone]);
  useEffect(()=>{const h=()=>exit();window.addEventListener('keydown',h);window.addEventListener('click',h);return()=>{window.removeEventListener('keydown',h);window.removeEventListener('click',h);};},[exit]);
  const skull=SKULL_LINES.map((l,i)=>!eyeOpen&&i>=2&&i<=3?l.replace(/████/g,'░░░░'):l);
  return(
    <div style={{position:'fixed',top:32,left:0,right:0,bottom:0,background:'#000',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',cursor:sp?'pointer':'default',opacity:ex?0:1,transition:'opacity .5s ease',overflow:'hidden'}}>
      <div style={{position:'absolute',left:0,right:0,height:3,background:'rgba(255,255,255,.025)',animation:'scanline 4s linear infinite',pointerEvents:'none'}}/>
      <div style={{animation:'glitch 10s step-end infinite',display:'flex',flexDirection:'column',alignItems:'center'}}>
        <pre style={{fontFamily:'var(--mono)',fontSize:14,lineHeight:1.55,color:'#fff',userSelect:'none',margin:0,fontWeight:700}}>{skull.slice(0,rev).join('\n')}</pre>
        {bl>=0&&<div style={{marginTop:18,width:380,fontFamily:'var(--mono)',fontSize:11}}>
          {BOOT_LINES.slice(0,bl).map((l,i)=>(<div key={i} style={{color:l.startsWith('  [OK]')?'#6e6e6e':l==='> SISTEMA LISTO'?'#a8a8a8':'#8a8a8a',marginBottom:2}}>{l}</div>))}
          {bl<BOOT_LINES.length&&<div style={{color:BOOT_LINES[bl].startsWith('  [OK]')?'#9c9c9c':'#fff'}}>{BOOT_LINES[bl].slice(0,bc)}<span className="blink">_</span></div>}
        </div>}
        {sp&&<div style={{marginTop:32,fontSize:10,color:'#8a8a8a',letterSpacing:4,textTransform:'uppercase',animation:'blink 1.6s step-end infinite'}}>[ PRESIONA CUALQUIER TECLA O CLIC ]</div>}
      </div>
    </div>
  );
}

/* ── Pixel skull mark (SVG, no emoji) ─ */
function PixelSkull({size=14}){
  const rows=[[1,2,3,4,5,6,7,8],[0,9],[0,2,3,6,7,9],[0,2,3,6,7,9],[0,9],[0,2,3,4,5,6,7,9],[0,1,2,3,4,5,6,7,8,9],[1,3,4,5,6,8],[1,2,7,8],[2,7]];
  return(<svg width={size} height={size} viewBox="0 0 10 10" style={{display:'block'}} aria-hidden="true">{rows.flatMap((r,y)=>r.map(x=>(<rect key={x+'-'+y} x={x} y={y} width="1.05" height="1.05" fill="currentColor"/>)))}</svg>);
}

/* ── Native Windows Title Bar ──────── */
function TitleBar(){
  const [max,setMax]=useState(false);
  useEffect(()=>{ if(api&&api.onMaximizeChange) return api.onMaximizeChange(setMax); },[]);
  const btn={width:46,height:32,display:'flex',alignItems:'center',justifyContent:'center',border:'none',background:'transparent',color:'#b5b5b5',fontSize:13,WebkitAppRegion:'no-drag',transition:'background .12s,color .12s'};
  const hov=(e,bg,fg)=>{e.currentTarget.style.background=bg;e.currentTarget.style.color=fg;};
  const out=e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='#b5b5b5';};
  return(
    <div style={{height:32,borderBottom:'1.5px solid #262626',display:'flex',alignItems:'center',flexShrink:0,background:'#000',userSelect:'none',WebkitAppRegion:'drag',position:'relative',zIndex:10000}}>
      <div style={{display:'flex',alignItems:'center',gap:9,paddingLeft:13}}>
        <span style={{color:'#fff',display:'flex'}}><PixelSkull size={13}/></span>
        <span style={{fontSize:10,color:'#d8d8d8',letterSpacing:3,fontWeight:700}}>VOKOPTIMIZER</span>
        <span style={{fontSize:10,color:'#6e6e6e',letterSpacing:2}}>· SYSTEM OPTIMIZER</span>
      </div>
      <div style={{flex:1}}/>
      <div style={{display:'flex',WebkitAppRegion:'no-drag'}}>
        <button title="Minimizar" style={btn} onClick={()=>api&&api.minimize()} onMouseEnter={e=>hov(e,'#262626','#fff')} onMouseLeave={out}>
          <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1" fill="currentColor"/></svg>
        </button>
        <button title={max?'Restaurar':'Maximizar'} style={btn} onClick={()=>api&&api.maximize()} onMouseEnter={e=>hov(e,'#262626','#fff')} onMouseLeave={out}>
          {max
            ? <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.5" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1"/><path d="M3.5 3 V1.5 H9.5 V7.5 H8" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            : <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1"/></svg>}
        </button>
        <button title="Cerrar" style={btn} onClick={()=>api?api.close():window.close()} onMouseEnter={e=>hov(e,'#c42b1c','#fff')} onMouseLeave={out}>
          <svg width="11" height="11" viewBox="0 0 11 11"><path d="M1 1 L10 10 M10 1 L1 10" stroke="currentColor" strokeWidth="1.1"/></svg>
        </button>
      </div>
    </div>
  );
}

const PAGE_TITLES={dashboard:'Panel de control',files:'Limpiador de archivos',apps:'Apps y restos',services:'Gestor de servicios',startup:'Gestor de arranque',cpu:'Optimización CPU / RAM',games:'Perfiles de juego',registry:'Mantenimiento del sistema',monitor:'Monitoreo de recursos',history:'Historial de optimizaciones'};

/* ── App ───────────────────────────── */
function App(){
  const [intro,setIntro]=useState(true);const [view,setView]=useState(null);const [optimizing,setOptimizing]=useState(false);const [optimized,setOptimized]=useState(false);
  const metrics=useSystemMetrics(2000);
  const handleOpt=async()=>{
    setOptimizing(true);setOptimized(false);
    let freed=0;
    if(api){try{const a=await api.cleanJunk(['temp_user','temp_win','thumbs','browser','wer']);const b=await api.optimizeCpuRam();freed=(a?.freed||0)+(b?.freed||0);}catch(e){}}
    setOptimizing(false);setOptimized(true);
    toast(`Optimización completa — ${fmtBytes(freed)} liberados`,'ok');
  };
  return(
    <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
      <Toasts/>
      <ConfirmRoot/>
      <TitleBar/>
      {intro&&<Intro onDone={()=>setIntro(false)}/>}
      {!intro&&view===null&&<OrbitalMenu onSelect={setView}/>}
      {!intro&&view!==null&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <div style={{height:42,borderBottom:'1.5px solid #303030',padding:'0 28px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
            <div style={{display:'flex',alignItems:'center',gap:16}}>
              <button onClick={()=>setView(null)} style={{fontSize:10,color:'#9c9c9c',letterSpacing:2,background:'none',border:'none',cursor:'pointer',padding:0}}
                onMouseEnter={e=>e.currentTarget.style.color='#fff'} onMouseLeave={e=>e.currentTarget.style.color='#9c9c9c'}>&lt; MENU</button>
              <span style={{color:'#2e2e2e'}}>|</span><span style={{fontSize:10,color:'#8a8a8a'}}>&gt;</span>
              <span style={{fontSize:12,color:'#f2f2f2',fontWeight:600,letterSpacing:.5}}>{PAGE_TITLES[view]}</span>
            </div>
            <div style={{fontSize:10,color:'#8a8a8a',letterSpacing:2}}><span className="blink" style={{marginRight:6}}>{'●'}</span>CPU <span style={{color:'#f2f2f2',fontWeight:600}}>{Math.round(metrics.cpu)}%</span> · RAM <span style={{color:'#f2f2f2',fontWeight:600}}>{Math.round(metrics.ram.pct)}%</span></div>
          </div>
          <div style={{flex:1,overflow:'hidden'}}>
            {view==='dashboard'&&<Dashboard onOptimize={handleOpt} optimizing={optimizing} optimized={optimized} metrics={metrics}/>}
            {view==='files'&&<FileCleaner/>}
            {view==='apps'&&<AppsPanel/>}
            {view==='services'&&<Services/>}
            {view==='startup'&&<StartupManager/>}
            {view==='cpu'&&<CpuOptimizer metrics={metrics}/>}
            {view==='games'&&<GamesPanel/>}
            {view==='registry'&&<RegistryCleaner/>}
            {view==='monitor'&&<MonitorPanel metrics={metrics}/>}
            {view==='history'&&<History/>}
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
