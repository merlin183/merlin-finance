import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {validClobeDate} from './read';
import {assertClobeImportScope,buildClobeAppendPlan,clobeHash,type ClobeImportChange,type ClobeImportRow,type ClobeImportScope,type ExternalTransactionRef} from '../finance/clobe-import';
import type {Category,Dataset} from '../finance/types';
import {needsCategoryReview,isHistoricalDate} from '../finance/category-status';
import {clobeSyncRange} from '../finance/clobe-sync-range';
import type {ClobeImportChoice,ClobeImportInput,ClobeImportPreview,ClobeImportPreviewRow,ClobeImportResult,ClobeImportSettings,ClobeSyncAccountScope,ClobeSyncPrepared,ClobeSyncApplied,ClobeSyncSource} from './import-types';
import {ClobeImportError,CLOBE_PREVIEW_TTL,openClobePreview,sealClobePreview} from './import-security';

const mapping=z.object({company_id:z.string().min(1).max(200),external_account_id:z.string().regex(/^[1-9]\d{0,15}$/).refine(v=>Number.isSafeInteger(Number(v))),account_id:z.string().uuid()}).strict();
export const clobeImportInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('preview'),start_date:z.string().refine(validClobeDate),end_date:z.string().refine(validClobeDate),mappings:z.array(mapping).min(1).max(100)}).strict(),
 z.object({action:z.literal('apply'),previewId:z.string().uuid(),choices:z.array(z.object({key:z.string().min(1).max(1000),category_id:z.string().uuid().nullable()}).strict()).max(20000)}).strict(),
 z.object({action:z.literal('sync_prepare'),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).strict(),
 z.object({action:z.literal('sync_apply'),previewId:z.string().uuid()}).strict(),
]);
export function parseClobeImportInput(value:unknown):ClobeImportInput{
 const input=clobeImportInputSchema.safeParse(value);if(!input.success)throw new ClobeImportError('invalid_request');
 if(input.data.action==='preview'&&input.data.start_date>input.data.end_date)throw new ClobeImportError('invalid_request');return input.data;
}
type PreviewSnapshot={version:1;scope:ClobeImportScope;incoming:ClobeImportRow[];identities:{key:string;kind:string;transaction_id:string}[];mode?:'automatic';choices?:ClobeImportChoice[];collections?:ClobeSyncAccountScope[];configuredMappings?:ClobeImportScope['mappings']};
type StoredSnapshot={ciphertext:string;expires_at:string;request_hash:string|null;result:ClobeImportResult|null};
export type ClobeImportDependencies={
 getDataset:()=>Promise<Dataset>;getRefs:(accountIds:string[])=>Promise<ExternalTransactionRef[]>;
 fetchSource:(scope:ClobeImportScope)=>Promise<ClobeImportRow[]>;
 validateSource?:(scope:ClobeImportScope)=>Promise<void>;
 fetchSyncSource?:(scope:ClobeImportScope)=>Promise<ClobeSyncSource>;
 validateSyncSource?:(scope:ClobeImportScope,collections:ClobeSyncAccountScope[])=>Promise<void>;
 rpc:(action:'store'|'read'|'apply'|'settings',payload:Record<string,unknown>)=>Promise<unknown>;
 userId:string;ownerId:string;now?:()=>number;
 seal?:(value:unknown,id:string)=>string;open?:(ciphertext:string,id:string)=>unknown;
};
const rowKey=(change:ClobeImportChange)=>JSON.stringify([change.company_id,change.external_account_id,change.external_transaction_id]);
const identity=(change:ClobeImportChange)=>({key:rowKey(change),kind:change.kind,transaction_id:change.transaction_id});
function validateCategory(category:Category|undefined,categoryId:string|null,direction:'in'|'out',date:string){
 if(categoryId&&!category)throw new ClobeImportError('stale','선택한 계정과목이 삭제되었거나 접근할 수 없습니다. 다시 확인해주세요.');
 if(category&&(category.name==='과거완료'&&!isHistoricalDate(date)||category.name==='입금'&&direction!=='in'||category.name==='출금'&&direction!=='out'))throw new ClobeImportError('invalid_request','거래 일자·입출금 구분과 계정과목 선택을 확인해주세요.');
}
export function applyClobeCategoryChoices(changes:ClobeImportChange[],choices:ClobeImportChoice[],data:Dataset){
 const selected=new Map(choices.map(choice=>[choice.key,choice.category_id])),inserts=changes.filter(c=>c.kind==='insert');
 if(selected.size!==choices.length||selected.size!==inserts.length||inserts.some(c=>!selected.has(rowKey(c))))throw new ClobeImportError('invalid_request','신규 거래에만 계정과목을 지정해주세요. 기존 거래의 분류는 변경하지 않습니다.');
 const categories=new Map(data.categories.map(c=>[c.id,c]));
 return changes.map(change=>{
  if(change.kind==='reference')return change;
  const categoryId=selected.get(rowKey(change))??null,category=categoryId?categories.get(categoryId):undefined;
  validateCategory(category,categoryId,change.row.direction,change.row.txn_date);
  return {...change,row:{...change.row,raw_gwamok:'',category_id:categoryId,is_internal:category?.is_internal??false,manually_classified:!!category&& !['미매핑','입금','출금'].includes(category.name)}};
 });
}
export async function previewClobeImport(input:Extract<ClobeImportInput,{action:'preview'}>,deps:ClobeImportDependencies):Promise<ClobeImportPreview>{
 const scope:ClobeImportScope={connection_id:null,mappings:input.mappings,start_date:input.start_date,end_date:input.end_date};
 const data=await deps.getDataset();assertClobeImportScope(scope,data);
 const [incoming,refs]=await Promise.all([deps.fetchSource(scope),deps.getRefs(scope.mappings.map(m=>m.account_id))]);
 const plan=await buildClobeAppendPlan(data,incoming,refs,scope),id=randomUUID(),expiresAt=new Date((deps.now??Date.now)()+CLOBE_PREVIEW_TTL).toISOString();
 const byId=new Map(data.transactions.map(t=>[t.id,t]));
 const rows:ClobeImportPreviewRow[]=plan.changes.map(change=>{
  const saved=change.kind==='reference'?byId.get(change.transaction_id):undefined;
  return {key:rowKey(change),kind:change.kind,account_id:change.account_id,company_id:change.company_id,external_account_id:change.external_account_id,external_transaction_id:change.external_transaction_id,txn_date:change.row.txn_date,txn_time:change.row.txn_time??null,amount:change.row.amount,direction:change.row.direction,balance:change.row.balance,description:change.row.description,source_details:change.row.source_details??null,category_id:saved?saved.category_id:change.row.category_id,is_internal:saved?saved.is_internal:change.row.is_internal,existing_transaction_id:saved?.id??null};
 });
 const response={previewId:id,expiresAt,scope,rows,summary:plan.summary,conflicts:plan.conflicts};
 // Keep actual HTTP response comfortably below the hosting response size cap.
 if(Buffer.byteLength(JSON.stringify(response))>3*1024*1024)throw new ClobeImportError('too_large');
 const snapshot:PreviewSnapshot={version:1,scope,incoming,identities:plan.changes.map(identity)};
 const ciphertext=deps.seal?deps.seal(snapshot,id):sealClobePreview(snapshot,id,deps.userId,deps.ownerId);
 await deps.rpc('store',{id,expires_at:expiresAt,ciphertext,scope});return response;
}
export async function applyClobeImport(input:Extract<ClobeImportInput,{action:'apply'}>,deps:ClobeImportDependencies):Promise<ClobeImportResult>{
 const requestHash=await clobeHash(['clobe-preview-apply-v1',input.previewId,[...input.choices].sort((a,b)=>a.key.localeCompare(b.key))]);
 const stored=await deps.rpc('read',{id:input.previewId}) as StoredSnapshot|null;
 if(!stored)throw new ClobeImportError('expired');
 if(stored.result){if(stored.request_hash!==requestHash)throw new ClobeImportError('stale');return {...stored.result,replayed:true};}
 if(new Date(stored.expires_at).getTime()<=(deps.now??Date.now)())throw new ClobeImportError('expired');
 const decoded=deps.open?deps.open(stored.ciphertext,input.previewId):openClobePreview(stored.ciphertext,input.previewId,deps.userId,deps.ownerId);
 const snapshot=decoded as PreviewSnapshot;
 if(!snapshot||snapshot.version!==1||!Array.isArray(snapshot.incoming)||!Array.isArray(snapshot.identities))throw new ClobeImportError('invalid_request');
 if(snapshot.mode==='automatic')throw new ClobeImportError('invalid_request');
 return applyPreparedImport(input.previewId,requestHash,snapshot,input.choices,deps);
}
async function applyPreparedImport(previewId:string,requestHash:string,snapshot:PreviewSnapshot,choices:ClobeImportChoice[],deps:ClobeImportDependencies){
 if(snapshot.mode==='automatic'){
  if(!deps.validateSyncSource||!snapshot.collections)throw new ClobeImportError('configuration');
  await deps.validateSyncSource(snapshot.scope,snapshot.collections);
  const current=(await deps.rpc('settings',{})) as ClobeImportSettings;
  const currentMappings=mapping.array().min(1).max(100).safeParse(current?.mappings);
  const configured=snapshot.configuredMappings??snapshot.scope.mappings;
  if(!currentMappings.success||mappingSignature(currentMappings.data)!==mappingSignature(configured)||snapshot.scope.mappings.some(active=>!configured.some(m=>m.account_id===active.account_id&&m.company_id===active.company_id&&m.external_account_id===active.external_account_id)))throw new ClobeImportError('stale','저장된 통장 연결이 변경되었습니다. 최신 동기화를 다시 시작해주세요.');
 }else await deps.validateSource?.(snapshot.scope);
 const [data,refs]=await Promise.all([deps.getDataset(),deps.getRefs(snapshot.scope.mappings.map(m=>m.account_id))]);
 const plan=await buildClobeAppendPlan(data,snapshot.incoming,refs,snapshot.scope);
 // A concurrent import may have made a previewed new row an existing row.
 // Require review again; never apply its category choice to that existing row.
 if(JSON.stringify(plan.changes.map(identity))!==JSON.stringify(snapshot.identities))throw new ClobeImportError('stale');
 const changes=applyClobeCategoryChoices(plan.changes,choices,data);
 return await deps.rpc('apply',{id:previewId,request_hash:requestHash,scope:snapshot.scope,changes,summary:{unchanged:plan.summary.unchanged,sourceDuplicates:plan.summary.sourceDuplicates,blocked:plan.summary.blocked}}) as ClobeImportResult;
}
const mappingSignature=(mappings:ClobeImportScope['mappings'])=>JSON.stringify(mappings.map(m=>[m.account_id,m.company_id,m.external_account_id]).sort((a,b)=>a[0].localeCompare(b[0])));
export function clobeSyncMonthRange(month:string,now=Date.now()){
 const range=clobeSyncRange(now),today=range.to;
 if(!range.months.includes(month))throw new ClobeImportError('invalid_request','자동 동기화는 지난달과 이번 달의 최근 2개월만 가능합니다.');
 const [year,index]=month.split('-').map(Number),last=new Date(Date.UTC(year,index,0)).toISOString().slice(0,10);
 return {start_date:`${month}-01`,end_date:month===today.slice(0,7)?today:last};
}
/** Automatic preparation uses server-confirmed mappings and only saved user
 * classification rules; financial rows and choices never come from a browser. */
export async function prepareClobeSync(input:Extract<ClobeImportInput,{action:'sync_prepare'}>,deps:ClobeImportDependencies):Promise<ClobeSyncPrepared>{
 const range=clobeSyncMonthRange(input.month,(deps.now??Date.now)());
 if(!deps.fetchSyncSource)throw new ClobeImportError('configuration');
 const [data,settings]=await Promise.all([deps.getDataset(),deps.rpc('settings',{}) as Promise<ClobeImportSettings>]);
 const parsed=mapping.array().min(1).max(100).safeParse(settings?.mappings);
 if(!parsed.success)throw new ClobeImportError('stale','저장된 Clobe 통장 연결이 없습니다. 거래 불러오기에서 통장을 연결한 뒤 다시 시도해주세요.');
 const configuredScope:ClobeImportScope={connection_id:null,mappings:parsed.data,...range};assertClobeImportScope(configuredScope,data);
 const [source,refs]=await Promise.all([deps.fetchSyncSource(configuredScope),deps.getRefs(configuredScope.mappings.map(m=>m.account_id))]);
 const activeIds=new Set(source.accounts.map(account=>account.account_id)),skipped=source.skipped??[];
 if(activeIds.size!==source.accounts.length||!activeIds.size||source.accounts.some(account=>!parsed.data.some(m=>m.account_id===account.account_id))||new Set(skipped.map(item=>item.account_id)).size!==skipped.length||skipped.some(item=>activeIds.has(item.account_id)||!parsed.data.some(m=>m.account_id===item.account_id))||activeIds.size+skipped.length!==parsed.data.length)throw new ClobeImportError('incomplete');
 const scope:ClobeImportScope={...configuredScope,mappings:parsed.data.filter(m=>activeIds.has(m.account_id))};assertClobeImportScope(scope,data);
 const plan=await buildClobeAppendPlan(data,source.rows,refs,scope),categories=new Map(data.categories.map(c=>[c.id,c]));
 const choices=plan.changes.filter(change=>change.kind==='insert').map(change=>({key:rowKey(change),category_id:needsCategoryReview(categories.get(change.row.category_id??'')?.name)?null:change.row.category_id}));
 const id=randomUUID(),expiresAt=new Date((deps.now??Date.now)()+CLOBE_PREVIEW_TTL).toISOString();
 const snapshot:PreviewSnapshot={version:1,mode:'automatic',scope,configuredMappings:parsed.data,incoming:source.rows,identities:plan.changes.map(identity),choices,collections:source.accounts};
 const ciphertext=deps.seal?deps.seal(snapshot,id):sealClobePreview(snapshot,id,deps.userId,deps.ownerId);
 await deps.rpc('store',{id,expires_at:expiresAt,ciphertext,scope});
 return {previewId:id,expiresAt,month:input.month,scope:{...range,account_count:scope.mappings.length,configured_account_count:parsed.data.length,business_count:new Set(scope.mappings.map(m=>data.accounts.find(a=>a.id===m.account_id)!.business_id)).size,accounts:source.accounts},summary:plan.summary,unclassified:choices.filter(choice=>choice.category_id===null).length,conflicts:plan.conflicts.slice(0,100),conflicts_truncated:plan.conflicts.length>100,skipped};
}
export async function applyClobeSync(input:Extract<ClobeImportInput,{action:'sync_apply'}>,deps:ClobeImportDependencies):Promise<ClobeSyncApplied>{
 const requestHash=await clobeHash(['clobe-preview-sync-v1',input.previewId]),stored=await deps.rpc('read',{id:input.previewId}) as StoredSnapshot|null;
 if(!stored)throw new ClobeImportError('expired');
 if(stored.result){if(stored.request_hash!==requestHash)throw new ClobeImportError('stale');return {...stored.result,replayed:true,unclassified:null};}
 if(new Date(stored.expires_at).getTime()<=(deps.now??Date.now)())throw new ClobeImportError('expired');
 const snapshot=(deps.open?deps.open(stored.ciphertext,input.previewId):openClobePreview(stored.ciphertext,input.previewId,deps.userId,deps.ownerId)) as PreviewSnapshot;
 if(!snapshot||snapshot.version!==1||snapshot.mode!=='automatic'||!Array.isArray(snapshot.incoming)||!Array.isArray(snapshot.identities)||!Array.isArray(snapshot.choices)||!Array.isArray(snapshot.collections))throw new ClobeImportError('invalid_request');
 // Recover a committed run above regardless of its old window. An unapplied
 // historical automatic preview must never add older rows under this policy.
 const range=clobeSyncRange((deps.now??Date.now)()),month=snapshot.scope.start_date.slice(0,7);
 if(!range.months.includes(month)||snapshot.scope.start_date!==`${month}-01`||snapshot.scope.end_date<snapshot.scope.start_date||snapshot.scope.end_date>range.to||snapshot.scope.end_date.slice(0,7)!==month)throw new ClobeImportError('stale','자동 동기화 조회 기간이 지났습니다. 최근 2개월 자료를 다시 동기화해주세요.');
 const choiceSchema=clobeImportInputSchema.options[1].shape.choices.safeParse(snapshot.choices);
 if(!choiceSchema.success)throw new ClobeImportError('invalid_request');
 const result=await applyPreparedImport(input.previewId,requestHash,snapshot,choiceSchema.data,deps);
 return {...result,unclassified:choiceSchema.data.filter(choice=>choice.category_id===null).length};
}
export async function readClobeImportSettings(deps:Pick<ClobeImportDependencies,'rpc'>):Promise<ClobeImportSettings>{
 return await deps.rpc('settings',{}) as ClobeImportSettings;
}
