import {authenticated,apiError,assertSameOrigin} from '@/lib/supabase/server';
import {getSheetImportData} from '@/lib/finance/data';
import {fetchGoogleSheet,googleSheetUrl,prepareSheetRows,sha256} from '@/lib/finance/google-sheets';
import {buildSheetAppendPlan} from '@/lib/finance/sheet-append';
import {executeSheetAppendSync,sheetImportInput,sheetSyncAvailability,type SavedAppendRun} from '@/lib/finance/sheet-append-sync';
import {parseSheetImportSource,resolveSheetImportMappings} from '@/lib/finance/sheet-import-source';

export const maxDuration=60;
const headers={'Cache-Control':'no-store'};
export async function GET(){
 try{
  const {db}=await authenticated();
  let source=null,availability:{syncAvailable:boolean;syncUnavailableReason:string|null};
  try{source=parseSheetImportSource(process.env.FINANCE_SHEET_IMPORT_SOURCE);availability=sheetSyncAvailability(source);}
  catch(error){availability={syncAvailable:false,syncUnavailableReason:error instanceof Error?error.message:'스프레드시트 연결 설정을 확인해주세요.'};}
  const [{data,error},{data:accounts,error:accountError}]=await Promise.all([
   db.from('fd_sheet_imports').select('id,source_url,created_at,result').not('result','is',null).order('created_at',{ascending:false}).limit(20),
   db.from('fd_accounts').select('id'),
  ]);
  if(error)throw Error('링크 가져오기 기록을 읽지 못했습니다.');
  if(accountError)throw Error('통장 연결을 확인하지 못했습니다.');
  if(source)availability=sheetSyncAvailability(source,new Set((accounts||[]).map(account=>account.id)));
  return Response.json({history:data,defaultSourceUrl:source?.url??null,...availability},{headers});
 }catch(error){return apiError(error);}
}
export async function POST(request:Request){
 const started=performance.now(),timings={auth:0,source:0,context:0};
 const measure=async<T>(stage:keyof typeof timings,operation:()=>Promise<T>)=>{
  const at=performance.now();
  try{return await operation();}finally{timings[stage]+=performance.now()-at;}
 };
 try{
  assertSameOrigin(request);
  const {db}=await measure('auth',authenticated);
  const input=sheetImportInput.parse(await request.json());
  const complete=(value:unknown)=>{
   const durations={...timings,total:performance.now()-started};
   // Timings diagnose slow stages without logging financial rows, identities,
   // source URLs, provider text or credentials. Source/context reads overlap.
   console.info('sheet import completed',{action:input.action,...Object.fromEntries(Object.entries(durations).map(([stage,ms])=>[`${stage}_ms`,Math.round(ms)]))});
   return Response.json(value,{headers:{...headers,'Server-Timing':Object.entries(durations).map(([stage,ms])=>`${stage};dur=${ms.toFixed(1)}`).join(', ')}});
  };
  if(input.action==='sync'){
   const source=parseSheetImportSource(process.env.FINANCE_SHEET_IMPORT_SOURCE);
   if(!source)throw Error('최신 동기화에 사용할 스프레드시트 연결이 등록되지 않았습니다.');
   const result=await executeSheetAppendSync(source,input.runId,{
    findRun:async runId=>{
     const {data,error}=await db.from('fd_sheet_imports').select('source_url,source_hash,result').eq('id',runId).maybeSingle();
     if(error)throw Error('동기화 기록을 확인하지 못했습니다. 잠시 후 같은 동기화로 다시 시도해주세요.');
     return data as SavedAppendRun|null;
    },
    fetchSource:url=>measure('source',()=>fetchGoogleSheet(url)),getDataset:()=>measure('context',()=>getSheetImportData(db)),apply:async payload=>db.rpc('fd_apply_sheet_import',payload),
   });
   return complete(result);
  }
  const canonicalUrl=googleSheetUrl(input.url).url;
  const mappings=input.action==='preview'?resolveSheetImportMappings(canonicalUrl,input.mappings,process.env.FINANCE_SHEET_IMPORT_SOURCE):input.mappings;
  // Bind an idempotency run to both the source snapshot and the reviewed plan.
  const runHash=input.action==='apply'?await sha256(input.sourceHash+':'+input.planHash):null;
  if(input.action==='apply'){
   const {data:previous,error}=await db.from('fd_sheet_imports').select('source_url,source_hash,result').eq('id',input.runId).maybeSingle();
   if(error)throw Error('가져오기 기록을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
   if(previous){
    if(previous.source_url!==canonicalUrl||previous.source_hash!==runHash)throw Error('같은 가져오기 번호의 내용이 다릅니다. 링크를 다시 확인해주세요.');
    if(previous.result)return complete(previous.result);
   }
  }
  const [source,data]=await Promise.all([measure('source',()=>fetchGoogleSheet(canonicalUrl)),measure('context',()=>getSheetImportData(db))]);
  const prepared=await prepareSheetRows(source.bytes,data,mappings,source.sourceUrl);
  const plan=await buildSheetAppendPlan(data,prepared.incoming,prepared.sourceHash);
  const errorCount=prepared.sheets.filter(s=>s.selected).reduce((count,s)=>count+s.errors.length,0);
  const summary={...plan.summary,blocked:plan.summary.blocked+errorCount};
  if(input.action==='preview')return complete({sourceUrl:source.sourceUrl,sourceHash:prepared.sourceHash,planHash:plan.planHash,sheets:prepared.sheets,summary,conflicts:plan.conflicts});
  if(input.sourceHash!==prepared.sourceHash||input.planHash!==plan.planHash)return Response.json({error:'시트 내용 또는 기존 거래가 변경되었습니다. 변경 내용 다시 확인을 누른 후 반영해주세요.'},{status:409,headers});
  if(summary.blocked&&!input.allowPartial)throw Error('확인 필요 행이 있습니다. 원본을 수정하거나 정상 거래만 반영을 선택해주세요.');
  if(!prepared.sheets.some(s=>s.selected))throw Error('반영할 시트를 선택해주세요.');
  if(plan.changes.length>20000)throw Error('한 번에 20,000건까지 반영할 수 있습니다. 시트를 나누어 선택해주세요.');
  const {data:result,error}=await db.rpc('fd_apply_sheet_import',{p_run:input.runId,p_source_url:source.sourceUrl,p_source_hash:runHash,p_changes:plan.changes,p_summary:{unchanged:summary.unchanged,sourceDuplicates:summary.sourceDuplicates,blocked:summary.blocked}});
  if(error){
   console.error('sheet-import RPC failed',error.code,error.message);
   throw Error('기존 거래가 변경되었거나 연결 정보가 충돌해 이번 반영을 취소했습니다. 변경 내용 다시 확인을 눌러주세요.');
  }
  return complete({...summary,...result});
 }catch(error){return apiError(error);}
}
