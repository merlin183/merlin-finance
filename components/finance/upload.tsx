"use client";
import {useFinancialVisibility,FinancialValue,FinancialText} from './financial-visibility';

import {useEffect,useMemo,useRef,useState} from 'react';
import {Upload,Check,ArrowRight,LoaderCircle,ChevronDown,Sparkles,RotateCcw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Checkbox} from '@/components/ui/checkbox';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from '@/components/ui/collapsible';
import {Panel,Picker,ConfirmButton,api,action,NoData} from './common';
import {type Mapping,type ParseOptions} from '@/lib/finance/parser';
import {detect,fieldLabels,matchingPreset,type Detection} from '@/lib/finance/auto-mapping';
import {previewSheets,transactionOverview,previewPage,type SheetPlan} from '@/lib/finance/import-preview';
import type {Dataset} from '@/lib/finance/types';
import type {WorkBook} from '@e965/xlsx';
import {toast} from 'sonner';
import './upload.css';
import {GoogleSheetImport} from './google-sheet-import';
import {ClobePanel} from './clobe-panel';
import {settleDatasetMutation} from '@/lib/finance/dataset-refresh';
import {TossSettlementsPanel} from './toss-settlements-panel';
import {useTossSettlements} from './use-toss-settlements';
import {today} from '@/lib/finance/format';

type UploadResult={success:number;duplicate:number;errors:{sheet?:string;row:number;message:string}[];skipped?:number;warning?:string};
type Loaded={file:File;workbook:WorkBook;sheet:string;rows:unknown[][];detected:Detection;sheets:SheetPlan[];preset?:unknown};
const money=(n:number)=>n.toLocaleString('ko-KR')+'원';
export function UploadView({data,biz,refresh}:{data:Dataset;biz:string;refresh:()=>Promise<void>}){
 const {privateText,amountsVisible}=useFinancialVisibility();
 const toss=useTossSettlements({data,asOf:today(),refresh});
 const [business,setBusiness]=useState(biz==='all'?data.businesses[0]?.id:biz);
 const [account,setAccount]=useState('');
 const [files,setFiles]=useState<File[]>([]),[fileIndex,setFileIndex]=useState(0);
 const [loaded,setLoaded]=useState<Loaded|null>(null);
 const [mapping,setMapping]=useState<Mapping>({}),[headerRow,setHeaderRow]=useState(0);
 const [year,setYear]=useState(''),[month,setMonth]=useState('');
 const [amountMode,setAmountMode]=useState<ParseOptions['amountMode']>();
 const [remembered,setRemembered]=useState(false),[manual,setManual]=useState(false);
 const [savePreset,setSavePreset]=useState(true),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false);
 const [result,setResult]=useState<UploadResult|null>(null);
 const [directionFilter,setDirectionFilter]=useState('all'),[monthFilter,setMonthFilter]=useState('all'),[page,setPage]=useState(0);
 const [partialConsent,setPartialConsent]=useState<string|null>(null);
 const input=useRef<HTMLInputElement>(null),requestId=useRef(0);
 useEffect(()=>()=>{requestId.current++},[]);
 const busy=loading||saving;
 function reset(){requestId.current++;setLoaded(null);setFiles([]);setResult(null);setLoading(false);setYear('');setMonth('');setManual(false);setAllowPartial(false);setPage(0);setDirectionFilter('all');setMonthFilter('all');if(input.current)input.current.value='';}
 function applyDetection(next:Loaded,allowPreset=true){
  const d=next.detected,p=allowPreset?matchingPreset(next.preset,d,next.rows):undefined;
  setLoaded(next);setHeaderRow(d.headerRow);setMapping(p?.columns||d.mapping);setYear(d.year?String(d.year):'');setMonth(d.month?String(d.month):'');
  setAmountMode(p?.amountMode||d.amountMode);setRemembered(!!p);setResult(null);setManual(false);
 }
 async function loadFile(file:File,index:number){
  const id=++requestId.current;setLoading(true);setLoaded(null);setResult(null);
  try{
   if(!file.size||file.size>4194304||!/\.(xlsx|xls|csv)$/i.test(file.name))throw Error('4MB 이하의 Excel 또는 CSV 파일을 선택하세요.');
   const {readTransactions,transactionSheets}=await import('@/lib/finance/workbook');
   const workbook=readTransactions(await file.arrayBuffer()),candidates=transactionSheets(workbook,file.name);
   let preset:unknown;
   try{const response=await fetch('/api/presets?account='+account,{cache:'no-store'});if(response.ok){const p=await response.json() as {preset?:unknown;mapping?:unknown}|null;preset=p?.preset??p?.mapping;}}catch{/* Recognition still works without a saved format. */}
   if(requestId.current!==id)return;
   const sheets:SheetPlan[]=candidates.map(s=>{const p=matchingPreset(preset,s.detected,s.rows),d=s.detected;return {...s,mapping:p?.columns||d.mapping,options:{headerRow:d.headerRow,year:d.year,month:d.month,amountMode:p?.amountMode||d.amountMode}};});
   if(sheets.length&&!sheets.some(s=>s.selected))sheets[0].selected=true;
   const first=sheets.find(s=>s.selected)||sheets[0];if(!first)throw Error('읽을 수 있는 거래 시트가 없습니다.');
   applyDetection({file,workbook,sheet:first.name,rows:first.rows,detected:first.detected,sheets,preset});
   setPage(0);setDirectionFilter('all');setMonthFilter('all');setAllowPartial(false);
   setFileIndex(index);
  }finally{if(requestId.current===id)setLoading(false);}
 }
 async function choose(list:File[]){if(!account)throw Error('먼저 사업자와 계좌를 선택하세요.');if(!list.length)return;setFiles(list);await loadFile(list[0],0);}
 async function switchSheet(sheet:string){
  if(!loaded)return;const sheets=currentPlans(),next=sheets.find(s=>s.name===sheet);if(!next)return;
  setLoaded({...loaded,sheets,sheet,rows:next.rows,detected:next.detected});setMapping(next.mapping);setHeaderRow(next.options.headerRow);setYear(next.options.year?String(next.options.year):'');setMonth(next.options.month?String(next.options.month):'');setAmountMode(next.options.amountMode);setRemembered(false);setManual(false);
 }
 function changeHeader(value:number){
  if(!loaded||!Number.isInteger(value)||value<0||value>=loaded.rows.length)return;
  const detected=detect(loaded.rows,{fileName:loaded.file.name,sheetName:loaded.sheet,headerRow:value});
  applyDetection({...loaded,detected},false);setManual(true);
 }
 const opts=useMemo(()=>({headerRow,year:Number(year)||undefined,month:Number(month)||undefined,amountMode}),[headerRow,year,month,amountMode]);
 function currentPlans(){return (loaded?.sheets||[]).map(s=>s.name===loaded?.sheet?{...s,detected:loaded.detected,mapping,options:opts}:s);}
 const plans=useMemo(()=>(loaded?.sheets||[]).map(s=>s.name===loaded?.sheet?{...s,detected:loaded.detected,mapping,options:opts}:s),[loaded,mapping,opts]);
 const preview=useMemo(()=>previewSheets(plans,data.categories,data.rules,data.aliases,account),[plans,data.categories,data.rules,data.aliases,account]);
 const exclusionKey=useMemo(()=>JSON.stringify([preview.errors,plans.map(p=>({name:p.name,selected:p.selected,mapping:p.mapping,options:p.options}))]),[preview.errors,plans]);
 const allowPartial=partialConsent===exclusionKey;
 function setAllowPartial(value:boolean){setPartialConsent(value?exclusionKey:null);}
 const overview=useMemo(()=>transactionOverview(preview.parsed),[preview.parsed]);
 const paged=useMemo(()=>previewPage(preview.parsed,directionFilter,monthFilter,page),[preview.parsed,directionFilter,monthFilter,page]);
 const columns=(loaded?.detected.headers||[]).map((v,i)=>({value:String(i),label:`${i+1}열 · ${v||'이름 없음'}`}));
 function mappingField(key:keyof Mapping){return <label key={key} className="form-field">{fieldLabels[key]}<Picker label={privateText(String((fieldLabels[key]+' 열')||''))} value={mapping[key]===undefined?'none':String(mapping[key])} onChange={v=>{setResult(null);setRemembered(false);setMapping(m=>{const next={...m};if(v==='none')delete next[key];else next[key]=Number(v);return next;});}} options={[{value:'none',label:'사용 안 함'},...columns]}/></label>;}
 const needsDirection=mapping.amount!==undefined&&mapping.income===undefined&&mapping.expense===undefined&&mapping.direction===undefined;
 const needsYear=mapping.day!==undefined&&!loaded?.detected.year&&(mapping.year===undefined||!loaded?.rows.slice(headerRow+1).some(r=>String(r[mapping.year!]??'').trim()));
 const needsMonth=mapping.day!==undefined&&!loaded?.detected.month&&(mapping.month===undefined||!loaded?.rows.slice(headerRow+1).some(r=>String(r[mapping.month!]??'').trim()));
 const directionControl=<label className="form-field">금액의 입출금 기준<Picker label="금액의 입출금 기준" value={amountMode||'none'} onChange={v=>{setAmountMode(v==='none'?undefined:v as ParseOptions['amountMode']);setResult(null);}} options={[{value:'none',label:'기준 선택'},{value:'signed',label:'양수는 입금 · 음수는 출금'},{value:'in',label:'모두 입금'},{value:'out',label:'모두 출금'}]}/></label>;
 async function submit(){
  if(!loaded||!account||busy||preview.problems.length||!preview.parsed.length||(preview.errors.length&&!allowPartial))return;
  setSaving(true);
  try{
   const form=new FormData();form.set('file',loaded.file);form.set('account',account);form.set('sheet',loaded.sheet);form.set('mapping',JSON.stringify(mapping));form.set('headerRow',String(headerRow));form.set('year',year);form.set('month',month);form.set('amountMode',amountMode||'');form.set('savePreset',String(savePreset));
   form.set('sheets',JSON.stringify(plans.filter(p=>p.selected).map(p=>({name:p.name,mapping:p.mapping,options:p.options}))));form.set('allowPartial',String(allowPartial));
   const response=await fetch('/api/upload',{method:'POST',body:form});const parsed=await response.json() as UploadResult&{error?:string};
   if(!response.ok)throw Error(parsed.error||'거래를 저장하지 못했습니다.');
   const completion=await settleDatasetMutation(Promise.resolve(parsed),refresh);
   setResult(parsed);
   if(completion.refreshed)toast.success(<FinancialText value={String(`${parsed.success}건을 저장하고 화면 자료를 갱신했습니다.`)}/>);
   else toast.warning('파일 저장은 완료됐지만 화면 자료를 갱신하지 못했습니다. 자료 새로고침으로 다시 확인해주세요.');
   if(parsed.warning)toast.warning(<FinancialText value={String(parsed.warning)}/>);
  }finally{setSaving(false);}
 }
 async function errorDownload(errors:UploadResult['errors']){if(!amountsVisible)return;const {utils,writeFile}=await import('@e965/xlsx');const wb=utils.book_new();utils.book_append_sheet(wb,utils.json_to_sheet(errors.map(e=>({시트:e.sheet||'',원본행:e.row,확인사항:e.message}))),'확인필요');writeFile(wb,'확인필요_거래.xlsx');}

 return <>
  <TossSettlementsPanel state={toss} data={data} biz={biz} showButton/>
  <ClobePanel data={data} refresh={refresh}/>
  <GoogleSheetImport data={data} refresh={refresh}/>
  <div className="upload-steps">{['사업자·계좌 선택','엑셀 자동 인식','저장 결과 확인'].map((label,i)=><div key={label} className={i===(result?2:files.length?1:0)?'active':''}><span>{i+1}</span>{label}{i<2&&<ArrowRight size={16}/>}</div>)}</div>
  <Panel title="엑셀 파일" subtitle="사업자와 계좌를 선택하고 파일을 올리세요."><fieldset disabled={busy} className="upload-account">
   <div><label>사업자</label><Picker label="업로드 사업자" value={business} onChange={v=>{if(busy)return;setBusiness(v);setAccount('');reset();}} options={data.businesses.map(b=>({value:b.id,label:b.name}))}/></div>
   <div><label>계좌</label><Picker label="업로드 계좌" value={account} onChange={v=>{if(busy)return;setAccount(v);reset();}} options={data.accounts.filter(a=>a.business_id===business).map(a=>({value:a.id,label:a.name}))}/></div>
   <p>날짜·입출금 자동 인식 · 중복 제외 · 원본 비공개 보관</p>
  </fieldset></Panel>
  <Panel>
   <input ref={input} className="sr-only" aria-label="거래 파일 선택" type="file" accept=".xlsx,.xls,.csv" multiple disabled={!account||busy} onChange={e=>void action(()=>choose(Array.from(e.target.files||[])))}/>
   <button className={'drop-zone '+(!account?'disabled':'')} disabled={!account||busy} onClick={()=>input.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(account&&!busy)void action(()=>choose(Array.from(e.dataTransfer.files)));}}>
    <span className="upload-icon">{loading?<LoaderCircle className="animate-spin" size={27}/>:<Upload size={27}/>}</span>
    <strong><FinancialText value={String((loading?'거래 인식 중…':loaded?.file.name||'파일을 놓거나 클릭해서 선택')??'')}/></strong>
    <p>{account?'선택한 시트의 전체 기간을 가져옵니다':'먼저 사업자와 계좌를 선택하세요'}</p>
    <small>XLSX · XLS · CSV / 파일당 최대 4MB · 시트당 20,000행</small>
   </button>
   {loaded&&!loading&&<div className="mapping-section">
    <div className="mapping-heading"><h3 className="flex items-center gap-2"><Sparkles size={18}/>{preview.problems.length?'이 항목만 확인해주세요':preview.parsed.length?'거래를 자동으로 인식했습니다':'인식 결과를 확인해주세요'}</h3><span>{fileIndex+1} / {files.length} 파일</span></div>
    <p className="text-sm muted mb-4">{plans.filter(p=>p.selected).length}개 시트 · 원본 거래일 기준{remembered?' · 저장한 파일 형식 적용':''}</p>
    {loaded.sheets.length>1&&<div className="sheet-selection mb-4"><strong>저장할 거래 시트</strong><p className="text-sm muted">선택한 계좌의 거래만 포함하세요. 표지와 안내 시트는 기본으로 제외합니다.</p>{plans.map(s=>{const summary=preview.summaries.find(p=>p.name===s.name);return <label key={s.name}><Checkbox disabled={busy||!!result} checked={s.selected} onCheckedChange={v=>{setLoaded({...loaded,sheets:currentPlans().map(p=>p.name===s.name?{...p,selected:v===true}:p)});setPage(0);setAllowPartial(false);}}/><span><FinancialText value={s.name}/></span><small>{s.selected?summary?`${summary.count.toLocaleString()}건${summary.from?' · '+summary.from+' ~ '+summary.to:''}${summary.errors?' · 확인 필요 '+summary.errors+'행':''}`:'인식 결과 확인 필요':'제외됨'}</small></label>;})}</div>}
    <div className="mb-4"><Picker label="열 인식을 확인할 시트" value={loaded.sheet} onChange={v=>{if(!busy)void action(()=>switchSheet(v));}} options={loaded.sheets.map(s=>({value:s.name,label:s.name}))}/><p className="text-sm muted"><FinancialText value={String((loaded.sheet)??'')}/> · 헤더 {headerRow+1}행</p></div>
    <fieldset disabled={saving||!!result} className="space-y-4">
     {(preview.problems.length>0||needsYear||needsMonth||(needsDirection&&!loaded.detected.amountMode))&&<div className="auto-review">
      {preview.problems.map(p=><p key={p}>{p}</p>)}
      <div className="mapping-grid mt-4">
       {mapping.date===undefined&&mapping.day===undefined&&mappingField('date')}
       {mapping.income===undefined&&mapping.expense===undefined&&mapping.amount===undefined&&(['income','expense','amount'] as const).map(mappingField)}
       {needsYear&&<label className="form-field">기준 연도<Input aria-label="기준 연도" type="number" min={1900} max={9999} value={year} onChange={e=>setYear(e.target.value)}/></label>}
       {needsMonth&&<label className="form-field">기준 월<Input aria-label="기준 월" type="number" min={1} max={12} value={month} onChange={e=>setMonth(e.target.value)}/></label>}
       {needsDirection&&!loaded.detected.amountMode&&directionControl}
      </div>
     </div>}
     {preview.parsed.length>0&&<>
      <div className="auto-summary" aria-label="자동 인식 요약">
       <div><span>전체 인식 기간 · {overview.months.length}개월</span><strong>{preview.parsed.length.toLocaleString()}건</strong><small>{overview.from} ~ {overview.to}</small></div>
       <div><span>입금 {overview.incomeCount.toLocaleString()}건</span><strong className="positive"><FinancialValue value={money(overview.income)}/></strong></div>
       <div><span>출금 {overview.expenseCount.toLocaleString()}건</span><strong className="negative"><FinancialValue value={money(overview.expense)}/></strong></div>
      </div>
      <div className="flex flex-wrap gap-2 text-sm" aria-label="자동 연결한 항목">{Object.entries(mapping).map(([key,col])=><span key={key} className="auto-field">{fieldLabels[key as keyof Mapping]} ← {loaded.detected.headers[col!]||`${col!+1}열`}</span>)}</div>
      <div className="preview-controls"><strong>전체 거래 미리보기</strong><Picker label="입출금 구분" value={directionFilter} onChange={v=>{setDirectionFilter(v);setPage(0);}} options={[{value:'all',label:'입금·출금 전체'},{value:'in',label:`입금 (${overview.incomeCount}건)`},{value:'out',label:`출금 (${overview.expenseCount}건)`}]}/><Picker label="미리보기 월" value={monthFilter} onChange={v=>{setMonthFilter(v);setPage(0);}} options={[{value:'all',label:'전체 기간'},...overview.months.map(m=>({value:m.month,label:`${m.month} · 입금 ${m.incomeCount} / 출금 ${m.expenseCount}건`}))]}/></div>
      <p className="text-sm muted">미리보기 {paged.total.toLocaleString()}건 · 저장은 필터와 관계없이 선택한 시트 전체 기간에 적용됩니다.</p>
      <Table><TableHeader><TableRow><TableHead>거래일자</TableHead><TableHead>구분</TableHead><TableHead>거래내용</TableHead><TableHead>출금금액(원)</TableHead><TableHead>입금금액(원)</TableHead><TableHead>거래 후 잔액(원)</TableHead><TableHead>원본 위치</TableHead></TableRow></TableHeader><TableBody>
       {paged.rows.map(row=><TableRow key={`${row.sheet}:${row.source_row}`}><TableCell>{row.txn_date}</TableCell><TableCell><span className={row.direction==='in'?'direction-badge positive':'direction-badge negative'}>{row.direction==='in'?'입금':'출금'}</span></TableCell><TableCell><FinancialText value={String((row.description||'—')||'')}/></TableCell><TableCell className="negative"><FinancialValue value={row.direction==='out'?money(row.amount):'—'}/></TableCell><TableCell className="positive"><FinancialValue value={row.direction==='in'?money(row.amount):'—'}/></TableCell><TableCell><FinancialValue value={row.balance===null?'—':money(row.balance)}/></TableCell><TableCell><FinancialText value={String((row.sheet)??'')}/> · {row.source_row}행</TableCell></TableRow>)}
      </TableBody></Table>
      <div className="preview-pagination"><span>{paged.total?`${paged.current*50+1}–${Math.min((paged.current+1)*50,paged.total)} / ${paged.total.toLocaleString()}건`:'해당 거래 없음'}</span><Button type="button" variant="outline" size="sm" disabled={paged.current===0} onClick={()=>setPage(0)}>처음</Button><Button type="button" variant="outline" size="sm" disabled={paged.current===0} onClick={()=>setPage(paged.current-1)}>이전</Button><span>{paged.current+1} / {paged.pages}</span><Button type="button" variant="outline" size="sm" disabled={paged.current+1>=paged.pages} onClick={()=>setPage(paged.current+1)}>다음</Button><Button type="button" variant="outline" size="sm" disabled={paged.current+1>=paged.pages} onClick={()=>setPage(paged.pages-1)}>마지막</Button></div>
     </>}
     {preview.errors.length>0&&<div className="auto-review" role="alert"><strong>{preview.errors.length}행은 확인이 필요합니다.</strong><p>날짜나 금액을 읽지 못한 행이 있어 전체 기간이 아직 완전하지 않을 수 있습니다. 아래 항목을 먼저 확인해주세요.</p>{preview.errors.slice(0,5).map(e=><p key={`${e.sheet}:${e.row}`}><FinancialText value={String((e.sheet)??'')}/> · {e.row}행 · <FinancialText value={String((e.message)||'')}/></p>)}<Button variant="outline" size="sm" type="button" disabled={!amountsVisible} onClick={()=>void action(()=>errorDownload(preview.errors))}>확인 필요 행 다운로드</Button><label className="partial-confirm"><Checkbox checked={allowPartial} onCheckedChange={v=>setAllowPartial(v===true)}/>확인 필요 {preview.errors.length}행을 제외하고 정상 거래 {preview.parsed.length}건만 저장</label></div>}
     {preview.skipped>0&&<p className="text-sm muted">합계·반복 헤더·월 제목 {preview.skipped}행은 거래에서 제외했습니다.</p>}
     <Collapsible open={manual} onOpenChange={setManual}>
      <CollapsibleTrigger asChild><Button variant="outline" type="button" size="sm">인식 결과 수정<ChevronDown size={15}/></Button></CollapsibleTrigger>
      <CollapsibleContent className="pt-4 space-y-4">
       <div className="mapping-meta"><Picker label="시트" value={loaded.sheet} onChange={v=>void action(()=>switchSheet(v))} options={loaded.workbook.SheetNames.map(s=>({value:s,label:s}))}/><label>헤더 행<Input aria-label="헤더 행" type="number" min="1" max={loaded.rows.length} value={headerRow+1} onChange={e=>changeHeader(Number(e.target.value)-1)}/></label><label>기준 연도<Input aria-label="보완 기준 연도" placeholder="연도가 없을 때만" type="number" value={year} onChange={e=>setYear(e.target.value)}/></label><label>기준 월<Input aria-label="보완 기준 월" type="number" min="1" max="12" value={month} onChange={e=>setMonth(e.target.value)}/></label></div>
       <div className="mapping-grid">{(Object.keys(fieldLabels) as (keyof Mapping)[]).map(mappingField)}{needsDirection&&directionControl}</div>
       <Button variant="ghost" size="sm" type="button" onClick={()=>applyDetection({...loaded,detected:detect(loaded.rows,{fileName:loaded.file.name,sheetName:loaded.sheet})},false)}><RotateCcw size={14}/>다시 자동 인식</Button>
       <p className="text-sm muted">원본 미리보기</p>{amountsVisible?<Table><TableHeader><TableRow>{loaded.detected.headers.map((v,i)=><TableHead key={i}>{v||`${i+1}열`}</TableHead>)}</TableRow></TableHeader><TableBody>{loaded.rows.slice(headerRow+1,headerRow+5).map((row,i)=><TableRow key={i}>{row.map((v,j)=><TableCell key={j}>{String(v)}</TableCell>)}</TableRow>)}</TableBody></Table>:<p className="text-sm muted">금액 표시를 켜면 원본 미리보기를 확인할 수 있습니다.</p>}
      </CollapsibleContent>
     </Collapsible>
    </fieldset>
    <div className="upload-confirm"><label><Checkbox disabled={busy||!!result} checked={savePreset} onCheckedChange={v=>setSavePreset(v===true)}/>확인한 파일 형식 기억하기</label><Button disabled={busy||!!result||!!preview.problems.length||!preview.parsed.length||(preview.errors.length>0&&!allowPartial)} onClick={()=>void action(submit)}>{saving?<LoaderCircle className="animate-spin" size={16}/>:<Check size={16}/>} {saving?'저장 중…':`전체 기간 ${preview.parsed.length.toLocaleString()}건 저장하기`}</Button></div>
    {result&&<div className="upload-result" role="status"><div><strong>{result.success}</strong><span>저장 완료</span></div><div><strong>{result.duplicate}</strong><span>중복 제외</span></div><div><strong>{result.errors.length}</strong><span>확인 필요</span></div>{result.errors.length>0&&<Button variant="outline" disabled={!amountsVisible} onClick={()=>void action(()=>errorDownload(result.errors))}>오류행 다운로드</Button>}{fileIndex+1<files.length&&<Button onClick={()=>void action(()=>loadFile(files[fileIndex+1],fileIndex+1))}>다음 파일 자동 인식<ArrowRight size={16}/></Button>}</div>}
    <p className="upload-hint">모든 선택 시트는 위 계좌에 저장됩니다. 동일 거래는 중복 제외합니다.</p>
   </div>}
  </Panel>
  <Panel title="업로드 기록" subtitle="업로드 취소는 해당 파일에 연결된 거래를 삭제합니다. 링크로 갱신한 거래는 유지됩니다.">{data.uploads.length?<Table><TableHeader><TableRow><TableHead>파일 / 계좌</TableHead><TableHead>등록일</TableHead><TableHead>저장 / 중복 / 오류</TableHead><TableHead>관리</TableHead></TableRow></TableHeader><TableBody>{data.uploads.map(u=><TableRow key={u.id}><TableCell><FinancialText value={u.filename}/><small className="cell-secondary"><FinancialText value={String((data.accounts.find(a=>a.id===u.account_id)?.name)||'')}/></small></TableCell><TableCell>{new Date(u.created_at).toLocaleDateString('ko-KR')}</TableCell><TableCell>{u.success_count} / {u.duplicate_count} / {u.error_count}</TableCell><TableCell><div className="flex gap-1"><Button size="sm" variant="ghost" disabled={!amountsVisible} onClick={()=>void action(async()=>{if(!amountsVisible)return;const result=await api('/api/files',{id:u.id});location.href=result.url;})}>원본</Button>{u.error_count>0&&<Button size="sm" variant="ghost" disabled={!amountsVisible} onClick={()=>void action(()=>errorDownload(u.errors))}>오류행</Button>}<ConfirmButton label="취소" title="이 업로드를 취소할까요?" description={privateText(String(`${u.filename}의 원본과 이 파일에 연결된 거래를 삭제합니다. 링크로 갱신한 거래는 유지됩니다. 이 작업은 되돌릴 수 없습니다.`))} onConfirm={async()=>{await api('/api/files',{id:u.id,action:'delete'});await refresh();toast.success('업로드를 취소했습니다.');}}/></div></TableCell></TableRow>)}</TableBody></Table>:<NoData title="업로드한 파일이 없습니다" text="위에서 첫 거래내역을 추가하세요." href=""/>}</Panel>
 </>;
}
