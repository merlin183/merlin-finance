import {z} from 'zod';
import {today} from './format';
import type {Business} from './types';

const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const dateSchema=z.string().refine(validDate,'올바른 날짜를 입력해주세요.');
const amountSchema=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const partyKey=z.string().min(1).max(120);

export const intercompanyBaselineSchema=z.object({
 source_url:z.string().url(),gid:z.string().regex(/^\d+$/),mirror_gid:z.string().regex(/^\d+$/),mirror_sheet_name:z.string().min(1).max(100),as_of:dateSchema,
 coverage_start:dateSchema.nullable(),opening_balance_known:z.literal(false),
 totals_include_additions:z.literal(true),notes:z.array(z.string().max(2000)).max(100),
 businesses:z.array(z.object({key:partyKey,name:z.string().min(1).max(200),business_id:z.string().uuid().nullable()}).strict()).min(2).max(100),
 pairs:z.array(z.object({business_a:partyKey,business_b:partyKey,a_to_b:amountSchema,b_to_a:amountSchema,note:z.string().max(3000)}).strict()).max(1000),
 additions:z.array(z.object({id:z.string().min(1).max(120),date:dateSchema,from_business:partyKey,to_business:partyKey,amount:amountSchema,kind:z.enum(['loan','repayment','source_unspecified']),memo:z.string().max(3000)}).strict()).max(1000),
}).strict().superRefine((value,ctx)=>{
 const keys=new Set(value.businesses.map(b=>b.key)),ids=value.businesses.flatMap(b=>b.business_id?[b.business_id]:[]);
 if(keys.size!==value.businesses.length||new Set(ids).size!==ids.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'사업자 식별자가 중복되었습니다.'});
 const pairs=new Set<string>();
 for(const pair of value.pairs){
  const key=JSON.stringify([pair.business_a,pair.business_b].sort());
  if(!keys.has(pair.business_a)||!keys.has(pair.business_b)||pair.business_a===pair.business_b||pairs.has(key))ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 사업자 쌍을 확인해주세요.'});
  pairs.add(key);
 }
 if(value.coverage_start&&value.coverage_start>value.as_of)ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 집계 기간을 확인해주세요.'});
 for(const entry of value.additions)if(!keys.has(entry.from_business)||!keys.has(entry.to_business)||entry.from_business===entry.to_business||entry.date>value.as_of)ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 추가 기록을 확인해주세요.'});
 if(new Set(value.additions.map(a=>a.id)).size!==value.additions.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 추가 기록이 중복되었습니다.'});
});
export type IntercompanyBaseline=z.infer<typeof intercompanyBaselineSchema>;
export type IntercompanyParty=IntercompanyBaseline['businesses'][number];

const historicalPairSchema=z.object({business_a:partyKey,business_b:partyKey,a_to_b:amountSchema,b_to_a:amountSchema}).strict();
export const intercompanySourceRowSchema=z.object({
 id:partyKey,source_row:z.number().int().min(2).max(10000),date:dateSchema,
 from_business:partyKey,to_business:partyKey,amount:amountSchema.refine(n=>n>0),
 kind:z.enum(['loan','repayment','source_unspecified']),memo:z.string().max(3000),native_id:z.string().uuid().nullable(),
 origin:z.enum(['source','mirror']).default('source'),voided:z.boolean().default(false),
}).strict();
export const intercompanySheetSnapshotInputSchema=z.object({
 fingerprint:z.string().min(1).max(200),through_date:dateSchema,
 historical_base_pairs:z.array(historicalPairSchema).max(1000),rows:z.array(intercompanySourceRowSchema).max(10000),
 mirrored_max_row:z.number().int().min(1).max(10000).default(1),
}).strict().superRefine((value,ctx)=>{
 const pairKeys=value.historical_base_pairs.map(p=>JSON.stringify([p.business_a,p.business_b].sort())),links=value.rows.flatMap(r=>r.native_id?[r.native_id]:[]),positions=value.rows.map(r=>`${r.origin}:${r.source_row}`);
 if(new Set(pairKeys).size!==pairKeys.length||value.historical_base_pairs.some(p=>p.business_a===p.business_b))ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 기준 사업자 쌍을 확인해주세요.'});
 if(new Set(value.rows.map(r=>r.id)).size!==value.rows.length||new Set(links).size!==links.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 기록 식별자나 연결이 중복되었습니다.'});
 if(new Set(positions).size!==positions.length||value.through_date>today()||value.rows.some(r=>r.from_business===r.to_business||r.date>value.through_date||r.date>today()||r.origin==='source'&&(r.source_row<48||r.source_row>70)||r.origin==='mirror'&&r.source_row>value.mirrored_max_row))ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 기록의 사업자·일자·행을 확인해주세요.'});
});
export type IntercompanySourceRow=z.infer<typeof intercompanySourceRowSchema>;
export type IntercompanySheetSnapshotInput=z.infer<typeof intercompanySheetSnapshotInputSchema>;
export const intercompanySheetSnapshotSchema=intercompanySheetSnapshotInputSchema.innerType().extend({revision:z.number().int().min(1).max(2147483646),synced_at:z.string()}).strict().superRefine((value,ctx)=>{
 const {revision: _revision,synced_at: _syncedAt,...input}=value;void _revision;void _syncedAt;
 const parsed=intercompanySheetSnapshotInputSchema.safeParse(input);
 if(!parsed.success)for(const issue of parsed.error.issues)ctx.addIssue(issue);
});
export type IntercompanySheetSnapshot=z.infer<typeof intercompanySheetSnapshotSchema>;

export const intercompanyEntrySchema=z.object({
 id:z.string().uuid(),from_party:partyKey,to_party:partyKey,entry_date:dateSchema,
 amount:amountSchema.refine(n=>n>0,'금액은 1원 이상 입력해주세요.'),kind:z.enum(['loan','repayment']),memo:z.string().max(2000),
 version:z.number().int().min(1).max(2147483646),voided:z.boolean(),sheet_row:z.number().int().min(2).max(10000),
 created_at:z.string(),updated_at:z.string(),
 sheet_status:z.enum(['pending','syncing','synced','error']),sheet_synced_at:z.string().nullable(),sheet_error:z.string(),
 source_row_key:partyKey.nullable().optional(),
 sheet_previous_row:z.array(z.union([z.string(),z.number().finite()])).length(9).nullable().optional(),
}).strict();
export type IntercompanyEntry=z.infer<typeof intercompanyEntrySchema>;
export const intercompanyRegisterSchema=z.object({baseline:intercompanyBaselineSchema.nullable(),entries:z.array(intercompanyEntrySchema),sheet_sync:intercompanySheetSnapshotSchema.nullable().optional()}).strict();
export type IntercompanyRegisterData=z.infer<typeof intercompanyRegisterSchema>;

const createSchema=z.object({
 action:z.literal('create'),id:z.string().uuid(),from_party:partyKey,to_party:partyKey,entry_date:dateSchema,
 amount:amountSchema.refine(n=>n>0,'금액은 1원 이상 입력해주세요.'),kind:z.enum(['loan','repayment']),memo:z.string().trim().max(2000),
}).strict();
export const intercompanyChangeSchema=z.discriminatedUnion('action',[
 createSchema,
 z.object({action:z.literal('set_voided'),id:z.string().uuid(),version:z.number().int().min(1).max(2147483646),voided:z.boolean()}).strict(),
]).superRefine((value,ctx)=>{
 if(value.action==='create'){
  if(value.from_party===value.to_party)ctx.addIssue({code:z.ZodIssueCode.custom,message:'보내는 사업자와 받는 사업자를 다르게 선택해주세요.',path:['to_party']});
  if(value.entry_date>today())ctx.addIssue({code:z.ZodIssueCode.custom,message:'실제 자금 이동일은 오늘까지 입력할 수 있습니다.',path:['entry_date']});
 }
});
export type IntercompanyChange=z.infer<typeof intercompanyChangeSchema>;

export type IntercompanyPair={
 key:string;businessA:IntercompanyParty;businessB:IntercompanyParty;aToB:number;bToA:number;net:number;
 creditor:IntercompanyParty|null;debtor:IntercompanyParty|null;amount:number;
 baselineAtoB:number;baselineBtoA:number;manualEntries:IntercompanyEntry[];note:string;
};
export type IntercompanyBusinessSummary={party:IntercompanyParty;sent:number;received:number;receivable:number;payable:number;net:number};
export type IntercompanySourceAddition=IntercompanyBaseline['additions'][number]&{source_row?:number;origin?:'source'|'mirror';voided?:boolean};
export type IntercompanyRegisterModel={pairs:IntercompanyPair[];businesses:IntercompanyBusinessSummary[];entries:IntercompanyEntry[];sourceAdditions:IntercompanySourceAddition[];asOf:string|null;sourceAsOf:string|null;totalPairNet:number;pendingCount:number;openingBalanceKnown:false};
const checked=(value:bigint)=>{if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(-Number.MAX_SAFE_INTEGER))throw Error('대여금 합계가 표시 가능한 금액을 초과했습니다.');return Number(value);};

/** The original snapshot is immutable; refreshed history and active records replace its additions. */
export function buildIntercompanyRegister(register:IntercompanyRegisterData,businesses:readonly Business[]):IntercompanyRegisterModel{
 const baseline=register.baseline;
 const snapshot=register.sheet_sync;
 const sourceAdditions:IntercompanySourceAddition[]=snapshot?snapshot.rows.filter(r=>!r.native_id&&!r.voided).map(r=>({id:r.id,date:r.date,from_business:r.from_business,to_business:r.to_business,amount:r.amount,kind:r.kind,memo:r.memo,source_row:r.source_row,origin:r.origin,voided:r.voided})):baseline?.additions??[];
 const parties=(baseline?.businesses??[]).map(p=>({...p,name:businesses.find(b=>b.id===p.business_id)?.name??p.name}));
 const byKey=new Map(parties.map(p=>[p.key,p]));
 const pairs=new Map<string,IntercompanyPair>();
 const pairFor=(from:string,to:string)=>{
  const [a,b]=[from,to].sort(),key=JSON.stringify([a,b]);
  const businessA=byKey.get(a),businessB=byKey.get(b);
  if(!businessA||!businessB||a===b)throw Error('대여금 사업자 연결을 확인해주세요.');
  let pair=pairs.get(key);
  if(!pair){pair={key,businessA,businessB,aToB:0,bToA:0,net:0,creditor:null,debtor:null,amount:0,baselineAtoB:0,baselineBtoA:0,manualEntries:[],note:''};pairs.set(key,pair);}
  return pair;
 };
 for(const source of snapshot?.historical_base_pairs??baseline?.pairs??[]){
  const pair=pairFor(source.business_a,source.business_b),forward=pair.businessA.key===source.business_a;
  pair.aToB=forward?source.a_to_b:source.b_to_a;pair.bToA=forward?source.b_to_a:source.a_to_b;
  pair.baselineAtoB=pair.aToB;pair.baselineBtoA=pair.bToA;pair.note='note'in source&&typeof source.note==='string'?source.note:'';
 }
 if(snapshot)for(const source of sourceAdditions){
  const pair=pairFor(source.from_business,source.to_business);
  if(source.from_business===pair.businessA.key)pair.aToB=checked(BigInt(pair.aToB)+BigInt(source.amount));else pair.bToA=checked(BigInt(pair.bToA)+BigInt(source.amount));
 }
 const entries=[...register.entries].sort((a,b)=>b.entry_date.localeCompare(a.entry_date)||b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
 let asOf=snapshot?.through_date??baseline?.as_of??null;
 for(const entry of entries){
  if(entry.voided)continue;
  const pair=pairFor(entry.from_party,entry.to_party);
  if(entry.from_party===pair.businessA.key)pair.aToB=checked(BigInt(pair.aToB)+BigInt(entry.amount));else pair.bToA=checked(BigInt(pair.bToA)+BigInt(entry.amount));
  pair.manualEntries.push(entry);
  if(!asOf||entry.entry_date>asOf)asOf=entry.entry_date;
 }
 const summaries=new Map(parties.map(p=>[p.key,{party:p,sent:0,received:0,receivable:0,payable:0,net:0}]));
 for(const pair of pairs.values()){
  pair.net=checked(BigInt(pair.aToB)-BigInt(pair.bToA));pair.amount=Math.abs(pair.net);
  pair.creditor=pair.net===0?null:pair.net>0?pair.businessA:pair.businessB;
  pair.debtor=pair.net===0?null:pair.net>0?pair.businessB:pair.businessA;
  const a=summaries.get(pair.businessA.key)!,b=summaries.get(pair.businessB.key)!;
  a.sent=checked(BigInt(a.sent)+BigInt(pair.aToB));a.received=checked(BigInt(a.received)+BigInt(pair.bToA));
  b.sent=checked(BigInt(b.sent)+BigInt(pair.bToA));b.received=checked(BigInt(b.received)+BigInt(pair.aToB));
  if(pair.creditor&&pair.debtor){const creditor=summaries.get(pair.creditor.key)!,debtor=summaries.get(pair.debtor.key)!;creditor.receivable=checked(BigInt(creditor.receivable)+BigInt(pair.amount));debtor.payable=checked(BigInt(debtor.payable)+BigInt(pair.amount));}
 }
 for(const summary of summaries.values())summary.net=checked(BigInt(summary.receivable)-BigInt(summary.payable));
 return {pairs:[...pairs.values()].sort((a,b)=>b.amount-a.amount||a.key.localeCompare(b.key)),businesses:[...summaries.values()],entries,sourceAdditions,asOf,sourceAsOf:snapshot?.through_date??baseline?.as_of??null,
  totalPairNet:checked([...pairs.values()].reduce((sum,pair)=>sum+BigInt(pair.amount),BigInt(0))),pendingCount:entries.filter(e=>e.sheet_status!=='synced').length,openingBalanceKnown:false};
}
