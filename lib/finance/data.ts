import {authenticated} from '@/lib/supabase/server';
import {resources,type Dataset} from './types';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {normalizeBankPlanDataset} from './clobe-plan-actuals';
import {intercompanyRegisterSchema,type IntercompanyRegisterData} from './intercompany-register';
import {readCashPlanSeries} from './cash-plan-series';
import {readCashPlanSeriesRevisions} from './cash-plan-series-revision';
type FinanceClient=Awaited<ReturnType<typeof authenticated>>['db'];
const compress=promisify(gzip);

/** Reuse the authenticated request client; the RPC independently checks current access. */
export async function getData(client?:FinanceClient):Promise<Dataset>{
 const db=client??(await authenticated()).db;
 const started=performance.now();
 // The JSON snapshot preserves the complete projection without repeatedly
 // rebuilding the whole ledger as JSONB. A timeout is reported, not retried.
 const result=await db.rpc('fd_read_finance_snapshot');
 const {data,error,status}=result;
 if(error){
  // Diagnose production transport/SQL failures without logging payloads,
  // owner IDs, source text, provider messages, tokens or query parameters.
  console.error('finance dataset RPC failed',{code:typeof error.code==='string'&&/^[A-Z0-9_]{1,24}$/.test(error.code)?error.code:'unknown',status:Number.isInteger(status)?status:null});
  if(error.message.includes('UNAUTHORIZED'))throw Error('UNAUTHORIZED');
  if(error.message.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
  throw Error('자료를 불러오지 못했습니다. 데이터베이스 연결과 초기 설정을 확인하세요.');
 }
 if(!data||Object.keys(resources).some(key=>!Array.isArray(data[key])))throw Error('자료 형식을 확인하지 못했습니다. 새로고침 후 다시 시도하세요.');
 // Numeric timing only: no financial rows, identities or provider text.
 console.info('finance dataset read',{db_ms:Math.round(performance.now()-started)});
 readCashPlanSeries(data.cash_plan_series,data as Dataset);
 readCashPlanSeriesRevisions(data.cash_plan_series_revisions,{series:data.cash_plan_series,accounts:data.accounts});
 return normalizeBankPlanDataset(data as Dataset);
}

/** Import matching needs the complete ledger and classification context, but
 * not cash-plan observations, revisions or display history. This internal-only
 * projection must never replace the shared browser Dataset. */
export async function getSheetImportData(db:FinanceClient):Promise<Dataset>{
 const {data,error,status}=await db.rpc('fd_read_sheet_import_context');
 if(error){
  console.error('sheet import context RPC failed',{code:typeof error.code==='string'&&/^[A-Z0-9_]{1,24}$/.test(error.code)?error.code:'unknown',status:Number.isInteger(status)?status:null});
  if(error.message.includes('UNAUTHORIZED'))throw Error('UNAUTHORIZED');
  if(error.message.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
  throw Error('자료를 불러오지 못했습니다. 데이터베이스 연결과 초기 설정을 확인하세요.');
 }
 const keys=['businesses','accounts','categories','rules','aliases','transactions','links','notes'] as const;
 if(!data||keys.some(key=>!Array.isArray(data[key])))throw Error('자료 형식을 확인하지 못했습니다. 새로고침 후 다시 시도하세요.');
 return {businesses:data.businesses,accounts:data.accounts,categories:data.categories,rules:data.rules,aliases:data.aliases,transactions:data.transactions,links:data.links,notes:data.notes,recurring:[],uploads:[],audit:[]};
}

function acceptsGzip(value:string|null){
 if(value===null)return true;
 const entries=value.toLowerCase().split(',').map(entry=>{
  const [name,...parameters]=entry.trim().split(';'),quality=parameters.find(p=>p.trim().startsWith('q='));
  const q=quality?Number(quality.trim().slice(2)):1;return {name:name.trim(),q:Number.isFinite(q)?q:0};
 });
 const explicit=entries.find(entry=>entry.name==='gzip');return ((explicit??entries.find(entry=>entry.name==='*'))?.q??0)>0;
}
/** Browser fetch transparently decodes this JSON response. Compressing on the
 * Node server keeps complete finance rows below the hosting payload limit;
 * no fields or transactions are removed to make the response smaller. */
export async function financeDatasetResponse(data:Dataset,started:number,request?:Request){
 const json=JSON.stringify(data),bytes=Buffer.from(json,'utf8');
 const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','Vary':'Accept-Encoding','X-Content-Type-Options':'nosniff','Server-Timing':`dataset;dur=${(performance.now()-started).toFixed(1)}`};
 if(bytes.length>=65536&&acceptsGzip(request?.headers.get('accept-encoding')??null)){
  const encoded=await compress(bytes,{level:1});
  if(encoded.length>4*1024*1024)throw Error('전체 재무자료의 응답 크기가 너무 큽니다. 조회 범위를 나눌 수 있도록 관리자에게 알려주세요.');
  headers['Content-Encoding']='gzip';return new Response(new Uint8Array(encoded),{headers});
 }
 if(bytes.length>4*1024*1024)throw Error('전체 재무자료를 받으려면 압축 응답을 지원하는 브라우저를 사용해주세요.');
 return new Response(json,{headers});
}

/** Full JSON backups retain every stored column, unlike the display projection. */
export async function getBackupData(db:FinanceClient):Promise<Dataset&{intercompany_register:IntercompanyRegisterData}>{
 const snapshot=new Date().toISOString();
 const [entries,register]=await Promise.all([Promise.all([...Object.entries(resources),['cash_plan_series','fd_cash_plan_series'],['cash_plan_series_revisions','fd_cash_plan_series_revisions']].map(async([key,table])=>{
  const rows:Record<string,unknown>[]=[];let lastId:string|undefined;
  while(true){
   let query=db.from(table).select('*').lte('created_at',snapshot).order(key==='audit'?'created_at':'id',{ascending:key!=='audit'}).limit(key==='audit'?100:1000);
   if(lastId)query=query.gt('id',lastId);
   const {data,error}=await query;
   if(error)throw Error('자료를 불러오지 못했습니다. 데이터베이스 연결과 초기 설정을 확인하세요.');
   rows.push(...data);if(data.length<1000||key==='audit')break;lastId=data[data.length-1].id;
  }
  if(key==='uploads')rows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  return [key,rows];
 })),(async()=>{
  // The register has its own safe projection, not bank-ledger rows. Lease
  // tokens and private bookkeeping columns must never enter an export.
  const {data,error}=await db.rpc('fd_read_intercompany_register');
  if(error)throw Error('대여금 기록을 불러오지 못해 전체 백업을 중단했습니다. 다시 시도해주세요.');
  const parsed=intercompanyRegisterSchema.safeParse(data);
  if(!parsed.success)throw Error('대여금 기록 형식을 확인하지 못해 전체 백업을 중단했습니다. 다시 시도해주세요.');
  return parsed.data;
 })()]);
 return {...Object.fromEntries(entries),intercompany_register:register} as Dataset&{intercompany_register:IntercompanyRegisterData};
}
