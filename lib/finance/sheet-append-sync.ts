import {z} from 'zod';
import {prepareSheetRowsFromSnapshot,sha256} from './google-sheets';
import {assertCompleteSheetMappings,buildSheetAppendPlan} from './sheet-append';
import type {SheetImportSource} from './sheet-import-source';
import type {Dataset} from './types';

const mapping=z.object({sheet:z.string().min(1).max(200),account_id:z.string().uuid().nullable(),selected:z.boolean()});
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const sheetImportInput=z.discriminatedUnion('action',[
 z.object({action:z.literal('preview'),url:z.string().max(2000),mappings:z.array(mapping).max(40).optional(),allowPartial:z.boolean().optional()}),
 z.object({action:z.literal('apply'),url:z.string().max(2000),mappings:z.array(mapping).min(1).max(40),sourceHash:hash,planHash:hash,runId:z.string().uuid(),allowPartial:z.boolean().default(false)}),
 // A browser cannot override the reviewed server source or account scope.
 z.object({action:z.literal('sync'),runId:z.string().uuid()}).strict(),
]);
export type AppendSummary=Awaited<ReturnType<typeof buildSheetAppendPlan>>['summary'];
export type AppendResult=AppendSummary&{run_id:string};
export type SavedAppendRun={source_url:string;source_hash:string;result:AppendResult|null};
export type AppendRequest={p_run:string;p_source_url:string;p_source_hash:string;p_changes:Awaited<ReturnType<typeof buildSheetAppendPlan>>['changes'];p_summary:Pick<AppendSummary,'unchanged'|'sourceDuplicates'|'blocked'>};
type SyncDependencies={
 findRun:(runId:string)=>Promise<SavedAppendRun|null>;
 fetchSource:(url:string)=>Promise<{sourceUrl:string;bytes:Uint8Array}>;
 getDataset:()=>Promise<Dataset>;
 apply:(request:AppendRequest)=>Promise<{data:AppendResult|null;error:{code?:string;message:string}|null}>;
};

export function sheetSyncAvailability(source:SheetImportSource|null,accountIds?:Set<string>){
 if(!source)return {syncAvailable:false,syncUnavailableReason:'최신 동기화에 사용할 스프레드시트 연결이 등록되지 않았습니다.'};
 if(source.mappings.some(mapping=>!mapping.selected||!mapping.account_id||accountIds&&!accountIds.has(mapping.account_id)))
  return {syncAvailable:false,syncUnavailableReason:'모든 통장 시트의 계좌 연결과 선택을 확인해주세요.'};
 return {syncAvailable:true,syncUnavailableReason:null};
}

export async function executeSheetAppendSync(source:SheetImportSource,runId:string,deps:SyncDependencies){
 const available=sheetSyncAvailability(source);
 if(!available.syncAvailable)throw Error(available.syncUnavailableReason!);
 // This run identifies one button click. Replaying a committed run returns
 // its result even if the workbook has changed since an uncertain response.
 const runHash=await sha256(JSON.stringify(['append-sync-v1',source.url,source.mappings]));
 const savedResult=async()=>{
  const previous=await deps.findRun(runId);
  if(!previous)return null;
  if(previous.source_url!==source.url||previous.source_hash!==runHash)throw Error('같은 동기화 번호의 연결 정보가 다릅니다. 새 동기화를 시작해주세요.');
  if(previous.result&&(previous.result.updated!==0||previous.result.removed!==0))throw Error('이전 동기화 결과의 추가 전용 설정을 확인해주세요.');
  return previous.result;
 };
 const replay=await savedResult();
 if(replay)return {...replay,sourceUrl:source.url,replayed:true};
 const [download,initialData]=await Promise.all([deps.fetchSource(source.url),deps.getDataset()]);
 const snapshot=assertCompleteSheetMappings(download.bytes,source.mappings);
 let data=initialData;
 for(let attempt=0;attempt<3;attempt++){
  const available=sheetSyncAvailability(source,new Set(data.accounts.map(account=>account.id)));
  if(!available.syncAvailable)throw Error(available.syncUnavailableReason!);
  const prepared=await prepareSheetRowsFromSnapshot(snapshot,data,source.mappings,source.url);
  const plan=await buildSheetAppendPlan(data,prepared.incoming,prepared.sourceHash);
  const parseConflicts=prepared.sheets.flatMap(sheet=>sheet.errors.map(error=>({sheet:sheet.name,...error})));
  const conflicts=[...plan.conflicts,...parseConflicts];
  const summary={...plan.summary,blocked:plan.summary.blocked+parseConflicts.length};
  if(plan.changes.length>20000)throw Error('한 번에 20,000건까지 추가할 수 있습니다. 통장 시트의 거래 수를 확인해주세요.');
  // Persist zero-change runs as well, so retries cannot import later edits.
  const result=await deps.apply({p_run:runId,p_source_url:source.url,p_source_hash:runHash,p_changes:plan.changes,p_summary:{unchanged:summary.unchanged,sourceDuplicates:summary.sourceDuplicates,blocked:summary.blocked}});
  if(!result.error&&result.data)return {...result.data,sourceUrl:source.url,sheets:prepared.sheets,conflicts};
  const replay=await savedResult();
  if(replay)return {...replay,sourceUrl:source.url,replayed:true};
  const concurrent=result.error?.code==='23505'||result.error?.message.includes('SHEET_STALE');
  if(!concurrent||attempt===2)throw Error('동기화 저장을 완료하지 못했습니다. 같은 동기화로 다시 시도해주세요. 기존 거래는 변경하지 않았습니다.');
  // A different run may have inserted the same bank transaction while this
  // request was planning. Re-read and recompute rather than upserting it.
  data=await deps.getDataset();
 }
 throw Error('동기화를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.');
}
