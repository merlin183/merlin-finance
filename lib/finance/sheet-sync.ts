import {fetchGoogleSheet,googleSheetUrl,prepareSheetRows,sha256,sheetSnapshot,sheetSourceHash,type SheetMapping} from './google-sheets';
import {buildSheetMergePlan,type SheetMergeRow} from './sheet-merge';
import type {Dataset,Transaction} from './types';

export type SyncSummary={inserted:number;updated:number;removed:number;unchanged:number;sourceDuplicates:number;blocked:number};
type RpcResult={data:unknown;error:{message?:string;code?:string}|null};
export type SyncRpc=(name:string,args:Record<string,unknown>)=>PromiseLike<RpcResult>;
type SyncContext={source_id:string;source_url:string;mappings:SheetMapping[];dataset:Dataset;source_fingerprints?:string[]};
export class SheetSyncError extends Error{constructor(readonly code:string){super(code);}}

export const syncErrorMessages:Record<string,string>={
 SHEET_SYNC_NOT_CONFIGURED:'자동 연동 설정을 확인하고 있습니다.',
 SHEET_SYNC_UNAUTHORIZED:'자동 연동 인증을 확인해주세요.',
 SHEET_SYNC_CONTEXT_FAILED:'자동 연동의 계좌 연결과 권한을 확인하지 못했습니다.',
 SHEET_SYNC_SOURCE_FAILED:'Google 시트를 읽지 못했습니다. 원본 링크와 읽기 권한을 확인해주세요.',
 SHEET_SYNC_MAPPING_CHANGED:'거래 시트 목록이 변경되었습니다. 자동 연동의 시트·계좌 연결을 확인해주세요.',
 SHEET_SYNC_SOURCE_ROWS_CHANGED:'이전에 반영한 거래가 시트에서 삭제되었거나 날짜·금액·기본내역이 바뀌었습니다. 중복 반영을 막기 위해 자동 연동을 보류했습니다. 링크 가져오기에서 변경 내역을 확인해주세요.',
 SHEET_SYNC_PARSE_FAILED:'시트의 날짜·금액·계정과목 형식을 확인해주세요.',
 SHEET_SYNC_TOO_LARGE:'자동 연동은 한 번에 거래 20,000건까지 처리할 수 있습니다.',
 SHEET_SYNC_APPLY_FAILED:'거래가 변경되어 이번 반영을 취소했습니다. 다음 확인 때 다시 시도합니다.',
 SHEET_SYNC_STATUS_FAILED:'동기화 결과를 기록하지 못했습니다. 거래 반영 여부는 가져오기 기록에서 확인해주세요.',
 SHEET_SYNC_FAILED:'자동 동기화를 완료하지 못했습니다. 다시 동기화해주세요.',
};
export function syncErrorMessage(code:string|null|undefined){return code?(syncErrorMessages[code]||syncErrorMessages.SHEET_SYNC_FAILED):null;}

// A checkpoint describes the supplied bank values, not a row number or a
// dashboard classification. Appending/reordering the sheet must not reset a
// classification the administrator edited after an earlier successful sync.
export async function sourceFingerprint(row:SheetMergeRow){
 const details=row.source_details;
 const identity=await sha256(JSON.stringify([row.account_id,row.sheet,row.txn_date,row.amount,row.direction,row.description.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()]));
 const content=await sha256(JSON.stringify([
  row.account_id,row.sheet,row.txn_date,row.amount,row.direction,row.description,
  row.raw_gwamok,row.provided.balance?row.balance:null,row.provided.time?row.txn_time:null,
  row.provided.tax?row.tax_invoice:null,row.provided,
  details?.basic??null,details?.detail??null,details?.counterparty??null,
  details?.record??null,details?.memo??null,details?.note??null,
 ]));
 return `${identity}:${content}`;
}
const sourceKey=(sheet:string,row:number)=>JSON.stringify([sheet,row]);
const monetaryKey=(row:Pick<Transaction,'account_id'|'txn_date'|'amount'|'direction'>)=>JSON.stringify([row.account_id,row.txn_date,row.amount,row.direction]);
function compatibleBankEvidence(a:Pick<Transaction,'balance'|'txn_time'>,b:Pick<Transaction,'balance'|'txn_time'>){
 return !(a.balance!==null&&a.balance!==undefined&&b.balance!==null&&b.balance!==undefined&&a.balance!==b.balance)
  &&!(a.txn_time&&b.txn_time&&a.txn_time!==b.txn_time);
}
export async function prepareAutomaticSheetSync(bytes:Uint8Array,context:SyncContext){
 const currentSheets=sheetSnapshot(bytes),names=new Set(currentSheets.map(s=>s.name));
 const configured=new Map(context.mappings.map(m=>[m.sheet,m]));
 if(configured.size!==context.mappings.length||!context.mappings.some(m=>m.selected&&m.account_id)
  ||context.mappings.some(m=>m.selected&&!names.has(m.sheet))
  ||currentSheets.some(s=>!configured.has(s.name)))throw new SheetSyncError('SHEET_SYNC_MAPPING_CHANGED');
 const mappings=currentSheets.map(s=>{const mapping=configured.get(s.name)!;return mapping.selected?mapping:{...mapping,account_id:null};});
 const prepared=await prepareSheetRows(bytes,context.dataset,mappings,context.source_url);
 if(prepared.incoming.length>20000)throw new SheetSyncError('SHEET_SYNC_TOO_LARGE');
 const plan=await buildSheetMergePlan(context.dataset,prepared.incoming,prepared.sourceHash);
 const fingerprints=new Map(await Promise.all(prepared.incoming.map(async row=>[sourceKey(row.sheet,row.source_row),await sourceFingerprint(row)] as const)));
 const previous=new Set(context.source_fingerprints||[]);
 const currentIdentities=new Set([...fingerprints.values()].map(hash=>hash.slice(0,64)));
 // The bank sheet has no immutable transaction ID. A removed identity may
 // be an edited old payment, not a new payment: never silently insert it.
 if([...previous].some(hash=>!currentIdentities.has(hash.slice(0,64))))throw new SheetSyncError('SHEET_SYNC_SOURCE_ROWS_CHANGED');
 const pending=plan.changes.filter(change=>!previous.has(fingerprints.get(sourceKey(change.row.source_sheet!,change.row.source_row!))!));
 const existingByMoney=new Map<string,Transaction[]>();
 for(const transaction of context.dataset.transactions){
  const key=monetaryKey(transaction),group=existingByMoney.get(key)||[];
  group.push(transaction);existingByMoney.set(key,group);
 }
 const blocked=new Set(plan.conflicts.map(c=>sourceKey(c.sheet,c.row)));
 const changes=pending.filter(change=>{
  // Bank-file descriptions and the bot's basic details can name the same
  // payment differently, including on the first automatic import. Missing
  // balance/time cannot prove a separate payment. Hold only that row instead
  // of changing an existing description or inventing a second transaction.
  const possibleExisting=change.kind==='insert'&&(existingByMoney.get(monetaryKey({...change.row,account_id:change.account_id}))||[])
   .some(transaction=>compatibleBankEvidence(change.row,transaction));
  if(change.duplicates.length||possibleExisting){blocked.add(sourceKey(change.row.source_sheet!,change.row.source_row!));return false;}
  return true;
 });
 const checkpoint=[...new Set([...fingerprints].filter(([key])=>!blocked.has(key)).map(([,hash])=>hash))].sort();
 const summary:SyncSummary={
  inserted:changes.filter(c=>c.kind==='insert').length,
  updated:changes.filter(c=>c.kind==='update').length,
  removed:changes.reduce((sum,c)=>sum+c.duplicates.length,0),
  unchanged:plan.summary.unchanged+plan.changes.length-pending.length,
  sourceDuplicates:plan.summary.sourceDuplicates,
  blocked:plan.summary.blocked+pending.length-changes.length+prepared.sheets.filter(s=>s.selected).reduce((sum,s)=>sum+s.errors.length,0),
 };
 const planHash=await sha256(JSON.stringify({changes,summary,checkpoint}));
 return {changes,summary,checkpoint,sourceHash:prepared.sourceHash,planHash};
}

export async function runSheetSync(options:{token:string;rpc:SyncRpc;fetchSource?:typeof fetchGoogleSheet;dryRun?:boolean;force?:boolean}){
 const {token,rpc}=options;
 if(!/^[a-f0-9]{64}$/.test(token))throw new SheetSyncError('SHEET_SYNC_UNAUTHORIZED');
 const probeResult=await rpc('fd_sheet_sync_probe',{p_token:token});
 if(probeResult.error||!probeResult.data)throw new SheetSyncError('SHEET_SYNC_CONTEXT_FAILED');
 const probe=probeResult.data as {source_id:string;source_url:string;last_source_hash:string|null;last_result:SyncSummary|null};
 let code='SHEET_SYNC_SOURCE_FAILED';
 try{
  const source=await (options.fetchSource||fetchGoogleSheet)(googleSheetUrl(probe.source_url).url);
  code='SHEET_SYNC_PARSE_FAILED';
  const snapshotHash=await sheetSourceHash(source.bytes);
  // Do not transfer every financial row out of Supabase every five minutes.
  // Manual retry still rechecks held rows against the current database.
  if(!options.dryRun&&!options.force&&probe.last_source_hash===snapshotHash){
   const result={inserted:0,updated:0,removed:0,unchanged:(probe.last_result?.unchanged||0)+(probe.last_result?.inserted||0)+(probe.last_result?.updated||0),sourceDuplicates:probe.last_result?.sourceDuplicates||0,blocked:probe.last_result?.blocked||0};
   const finished=await rpc('fd_sheet_sync_finish',{p_token:token,p_result:result,p_error:null});
   if(finished.error)throw new SheetSyncError('SHEET_SYNC_STATUS_FAILED');
   return {source_id:probe.source_id,...result,skipped:true};
  }
  code='SHEET_SYNC_CONTEXT_FAILED';
  const contextResult=await rpc('fd_sheet_sync_context',{p_token:token});
  if(contextResult.error||!contextResult.data)throw new SheetSyncError(code);
  const context=contextResult.data as SyncContext;
  if(context.source_id!==probe.source_id||context.source_url!==probe.source_url)throw new SheetSyncError('SHEET_SYNC_MAPPING_CHANGED');
  code='SHEET_SYNC_PARSE_FAILED';
  const plan=await prepareAutomaticSheetSync(source.bytes,context);
  if(options.dryRun)return {source_id:context.source_id,...plan.summary,dry_run:true};
  let result:SyncSummary&{run_id?:string}=plan.summary;
  if(plan.changes.length){
   code='SHEET_SYNC_APPLY_FAILED';
   // Stable run identity makes network retries safe; the DB additionally
   // compares the complete request and optimistic row snapshots.
   const runHash=await sha256(context.source_id+':'+plan.sourceHash+':'+plan.planHash);
   const runId=`${runHash.slice(0,8)}-${runHash.slice(8,12)}-5${runHash.slice(13,16)}-a${runHash.slice(17,20)}-${runHash.slice(20,32)}`;
   const applied=await rpc('fd_apply_sheet_sync',{
    p_token:token,p_run:runId,p_source_hash:runHash,p_changes:plan.changes,
    p_summary:{unchanged:plan.summary.unchanged,sourceDuplicates:plan.summary.sourceDuplicates,blocked:plan.summary.blocked},
    p_fingerprints:plan.checkpoint,p_expected_fingerprints:context.source_fingerprints||[],p_snapshot_hash:plan.sourceHash,
   });
   if(applied.error)throw new SheetSyncError(code);
   result={...plan.summary,...applied.data as object};
  }
  code='SHEET_SYNC_STATUS_FAILED';
  const finished=await rpc('fd_sheet_sync_finish',{
   p_token:token,p_result:result,p_error:null,
   ...(plan.changes.length?{}:{p_fingerprints:plan.checkpoint,p_expected_fingerprints:context.source_fingerprints||[],p_source_hash:plan.sourceHash}),
  });
  if(finished.error)throw new SheetSyncError(code);
  return {source_id:context.source_id,...result};
 }catch(error){
  const safeCode=error instanceof SheetSyncError?error.code:code;
  if(!options.dryRun){
   // Never log a token, source contents or raw DB errors. A failed status
   // write cannot turn a failed import into a successful result.
   try{await rpc('fd_sheet_sync_finish',{p_token:token,p_result:null,p_error:safeCode});}catch{}
  }
  throw new SheetSyncError(safeCode);
 }
}
