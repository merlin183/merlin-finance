import {cashEstimateRecordedTransactions,cashPlanInternalOrLoan,type CashEstimateOptions,type CashEstimates} from './cash-estimates';
import {parseFinanceDate} from './date-range';
import {calendarMonthRange} from './transaction-calendar';
import {normalizeSourceDetails,sourceDetailFields} from './source-details';
import type {Dataset,SourceDetails,Transaction} from './types';

/** Private, observed bank withdrawals used only for plan reconciliation. These
 * are not classified ledger transactions, and never train historical budgets. */
export type BankPlanActual={account_id:string;business_id:string;external_transaction_id:string;txn_date:string;txn_time:string|null;amount:number;balance:number|null;description:string;party:string|null;source_details:SourceDetails|null;currency:'KRW';source:'clobe';collected_at:string;synced_at:string;transaction_id:string|null};
export type BankPlanCoverage={account_id:string;business_id:string;from:string;to:string;collected_at:string|null;synced_at:string;status:'complete'|'confirmation-needed';reason:string|null;source:'clobe';currency:'KRW'};
export type BankPlanEvidence='none'|'bank-query'|'mixed';
export type BankPlanCoverageStatus='complete'|'confirmation-needed'|'uncollected';
export type CashPlanActualTarget={key:string;businessId:string;source_type:'estimated'|'registered'|'manual';source_key:string;month:string;title:string;accountId:string|null;sourceAccountId:string|null;categoryId?:string|null;categoryConflictReason?:string|null;paymentKind?:'general'|'tax';active?:boolean};
export type CashPlanActualMatch={transactions:Transaction[];bankTransactionIds:Set<string>;coverage:BankPlanCoverageStatus;reason:string|null;known:boolean;ambiguous:boolean};

const normalized=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const generic=/^(?:급여|입금|출금|현금|이체|계좌이체|자동이체|수수료|카드|카드대금|카드결제|은행|기업|농협|신한|국민|우리|하나|bank|card|transfer|deposit|withdrawal)$/i;
const meaningful=(value:string)=>{const text=normalized(value);return text.length>=3&&/\p{L}/u.test(text)&&!generic.test(text);};
const texts=(row:Pick<Transaction,'description'|'source_details'>)=>[row.description,row.source_details?.basic,row.source_details?.detail,row.source_details?.counterparty,row.source_details?.record].filter((value):value is string=>!!value&&meaningful(value)).map(normalized);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max=1000):value is string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const timestamp=(value:unknown):value is string=>text(value,100)&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
const time=(value:unknown):value is string|null=>value===null||typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
const safeMoney=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
const BANK_PLAN_DESCRIPTION_LIMIT=8003;

/** Bound optional RPC additions without weakening the existing dataset. Invalid
 * observations are discarded; an invalid scope cannot establish completeness. */
export function normalizeBankPlanDataset(data:Dataset):Dataset{
 if(!Object.hasOwn(data,'bank_plan_actuals')&&!Object.hasOwn(data,'bank_plan_coverage'))return data;
 const owners=new Map(data.accounts.map(account=>[account.id,account.business_id]));
 const invalidScopes=new Set<string>();
 const bank_plan_actuals=(Array.isArray(data.bank_plan_actuals)?data.bank_plan_actuals:[]).flatMap((input:unknown):BankPlanActual[]=>{
  const reject=():BankPlanActual[]=>{
   if(object(input)&&typeof input.account_id==='string'&&owners.get(input.account_id)===input.business_id){
    const month=typeof input.txn_date==='string'&&/^\d{4}-(?:0[1-9]|1[0-2])-/.test(input.txn_date)?input.txn_date.slice(0,7):'*';
    invalidScopes.add(JSON.stringify([input.account_id,month]));
   }
   return [];
  };
  if(!object(input)||!text(input.account_id,200)||owners.get(input.account_id)!==input.business_id||!text(input.external_transaction_id,200)||!input.external_transaction_id
   ||!text(input.txn_date,10)||!parseFinanceDate(input.txn_date)||!time(input.txn_time)||!safeMoney(input.amount)||input.amount<=0||input.balance!==null&&!safeMoney(input.balance)
   ||!text(input.description,BANK_PLAN_DESCRIPTION_LIMIT)||input.party!==null&&!text(input.party)||input.currency!=='KRW'||input.source!=='clobe'||!timestamp(input.collected_at)||!timestamp(input.synced_at)
   ||input.transaction_id!==null&&!text(input.transaction_id,200))return reject();
  const details=input.source_details;
  if(details!==null&&details!==undefined&&(!object(details)||sourceDetailFields.some(field=>details[field]!==undefined&&!text(details[field]))))return reject();
  return [{...input,source_details:normalizeSourceDetails(input.source_details)} as BankPlanActual];
 });
 const bank_plan_coverage=(Array.isArray(data.bank_plan_coverage)?data.bank_plan_coverage:[]).flatMap((input:unknown):BankPlanCoverage[]=>{
  if(!object(input)||!text(input.account_id,200)||owners.get(input.account_id)!==input.business_id||!text(input.from,10)||!text(input.to,10)||!parseFinanceDate(input.from)||!parseFinanceDate(input.to)||input.from>input.to
   ||input.collected_at!==null&&!timestamp(input.collected_at)||!timestamp(input.synced_at)||!['complete','confirmation-needed'].includes(String(input.status))
   ||input.reason!==null&&!text(input.reason)||input.currency!=='KRW'||input.source!=='clobe')return [];
  const invalid=invalidScopes.has(JSON.stringify([input.account_id,'*']))||invalidScopes.has(JSON.stringify([input.account_id,input.from.slice(0,7)]));
  return [invalid?{...input,status:'confirmation-needed',reason:'은행 출금 자료의 형식을 확인하지 못했습니다. 다시 동기화해주세요.'} as BankPlanCoverage:input as BankPlanCoverage];
 });
 return {...data,bank_plan_actuals,bank_plan_coverage};
}

const core=(row:Transaction)=>JSON.stringify([row.business_id,row.account_id,row.txn_date,row.direction,row.amount]);
const different=(bank:Transaction,saved:Transaction)=>!!bank.txn_time&&!!saved.txn_time&&bank.txn_time!==saved.txn_time||bank.balance!==null&&saved.balance!==null&&bank.balance!==saved.balance;
const sameEvidence=(bank:Transaction,saved:Transaction)=>{
 if(different(bank,saved))return false;
 const sameTime=!!bank.txn_time&&!!saved.txn_time,sameBalance=bank.balance!==null&&saved.balance!==null;
 return sameTime&&sameBalance||(sameTime||sameBalance)&&texts(bank).some(label=>texts(saved).includes(label));
};
const bankRow=(row:BankPlanActual):Transaction=>({id:`bank-plan:${JSON.stringify([row.account_id,row.external_transaction_id])}`,business_id:row.business_id,account_id:row.account_id,upload_id:null,txn_date:row.txn_date,txn_time:row.txn_time,amount:row.amount,direction:'out',description:row.description,raw_gwamok:'',category_id:null,is_internal:false,balance:row.balance,tax_invoice:false,dedup_hash:'',manually_classified:false,source_details:row.source_details??(row.party?{counterparty:row.party}:null)});

/** Provider IDs first, then the same strict financial evidence used by import.
 * Uncertain identity never becomes a second payment beside the existing row. */
export function unionBankPlanTransactions(input:Dataset,asOf:string){
 const data=normalizeBankPlanDataset(input),ledger=data.transactions.filter(row=>row.direction==='out'&&!!parseFinanceDate(row.txn_date)&&row.txn_date<=asOf&&safeMoney(row.amount)&&row.amount>0);
 const rows=[...ledger],bankById=new Map<string,BankPlanActual>(),blocked:Transaction[]=[];
 const byId=new Map(ledger.map(row=>[row.id,row])),byCore=new Map<string,Transaction[]>();
 for(const row of ledger){const key=core(row),group=byCore.get(key)??[];group.push(row);byCore.set(key,group);}
 const external=new Map<string,BankPlanActual[]>();
 for(const actual of data.bank_plan_actuals??[]){
  if(actual.txn_date>asOf||actual.txn_date>actual.collected_at.slice(0,10))continue;
  const scope=(data.bank_plan_coverage??[]).some(item=>item.account_id===actual.account_id&&item.business_id===actual.business_id&&item.from<=actual.txn_date&&item.to>=actual.txn_date&&item.collected_at===actual.collected_at);
  if(!scope)continue;
  const key=JSON.stringify([actual.account_id,actual.external_transaction_id]),group=external.get(key)??[];group.push(actual);external.set(key,group);
 }
 const ledgerClaims=new Map<string,{actual:BankPlanActual;row:Transaction}[]>(),newRows:{actual:BankPlanActual;row:Transaction}[]=[];
 for(const entries of external.values()){
  const actual=entries[0],row=bankRow(actual),identity=JSON.stringify([row.txn_date,row.txn_time,row.amount,row.balance]);
  if(entries.some(item=>JSON.stringify([item.txn_date,item.txn_time,item.amount,item.balance])!==identity)){blocked.push(row);continue;}
  if(actual.transaction_id){
   const saved=byId.get(actual.transaction_id);
   if(!saved||core(saved)!==core(row)||different(row,saved)){blocked.push(row);continue;}
   const claims=ledgerClaims.get(saved.id)??[];claims.push({actual,row:saved});ledgerClaims.set(saved.id,claims);continue;
  }
  const possible=(byCore.get(core(row))??[]).filter(saved=>!different(row,saved));
  if(possible.length){
   if(possible.length!==1||!sameEvidence(row,possible[0])){blocked.push(row);continue;}
   const saved=possible[0],claims=ledgerClaims.get(saved.id)??[];claims.push({actual,row:saved});ledgerClaims.set(saved.id,claims);
  }else newRows.push({actual,row});
 }
 for(const [id,claims] of ledgerClaims){
  if(claims.length!==1){blocked.push(...claims.map(item=>bankRow(item.actual)));continue;}
  bankById.set(id,claims[0].actual);
 }
 // Different provider IDs with an indistinguishable complete financial
 // fingerprint cannot safely establish two separate withdrawals.
 const financial=new Map<string,typeof newRows>();
 for(const entry of newRows){const key=JSON.stringify([core(entry.row),entry.row.txn_time,entry.row.balance,texts(entry.row)]),group=financial.get(key)??[];group.push(entry);financial.set(key,group);}
 for(const group of financial.values()){
  if(group.length>1){blocked.push(...group.map(entry=>entry.row));continue;}
  const entry=group[0];rows.push(entry.row);bankById.set(entry.row.id,entry.actual);
 }
 return {data,rows,bankById,blocked};
}

/** Allocate every observed payment to at most one plan in its own month. A
 * duplicate manual/registered/estimated candidate requires user confirmation. */
export function reconcileCashPlanActuals(data:Dataset,asOf:string,targets:readonly CashPlanActualTarget[],original:CashEstimates,options:CashEstimateOptions={}):Map<string,CashPlanActualMatch>{
 const union=unionBankPlanTransactions(data,asOf),result=new Map<string,CashPlanActualMatch>();
 const categories=new Map(data.categories.map(category=>[category.id,category]));
 const ledgerIds=new Set(data.transactions.map(row=>row.id)),bankCategoryGuards=new Map<string,string>();
 const categoryLabel=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,'').toLowerCase();
 for(const row of union.rows){
  if(ledgerIds.has(row.id)||!union.bankById.has(row.id))continue;
  // This exact provider-only label is a compatibility guard, never a ledger
  // classification. A saved row always keeps its administrator-selected category.
  const label=/^Clobe 원본 분류\(표시용\): ([^\r\n]+)$/.exec(row.source_details?.note??'')?.[1];
  if(!label)continue;
  const matching=data.categories.filter(category=>categoryLabel(category.name)===categoryLabel(label));
  if(matching.length===1)bankCategoryGuards.set(row.id,matching[0].id);
 }
 const keys=targets.filter(item=>item.source_type==='estimated').map(item=>item.source_key);
 const recorded=new Map<string,Transaction[]>();
 for(const month of new Set(targets.map(target=>target.month))){
  const monthly=targets.filter(item=>item.source_type==='estimated'&&item.month===month&&!item.categoryConflictReason),monthlyKeys=monthly.map(item=>item.source_key);
  const sourceCategories=new Map(monthly.map(item=>[item.source_key,item.categoryId??null]));
  const matches=cashEstimateRecordedTransactions({...data,transactions:union.rows},asOf,options,original,monthlyKeys,sourceCategories,bankCategoryGuards);
  for(const [key,rows] of matches){const combined=recorded.get(key)??[];combined.push(...rows.filter(row=>row.txn_date.slice(0,7)===month));recorded.set(key,combined);}
 }
 const groupById=new Map<string,string>();for(const [key,rows] of recorded)for(const row of rows)groupById.set(row.id,key);
 const coverageFor=(target:CashPlanActualTarget):{coverage:BankPlanCoverageStatus;reason:string|null}=>{
  const account=target.source_type==='estimated'?target.sourceAccountId:target.accountId;
  const full=calendarMonthRange(target.month),through=asOf<full.to?asOf:full.to;
  const scopes=(union.data.bank_plan_coverage??[]).filter(scope=>scope.business_id===target.businessId&&scope.account_id===account&&scope.from<=full.to&&scope.to>=full.from);
  if(!scopes.length)return {coverage:'uncollected',reason:null};
  const complete=scopes.some(scope=>scope.status==='complete'&&scope.collected_at!==null&&scope.from<=full.from&&scope.to>=through&&scope.collected_at.slice(0,10)>=through);
  return complete?{coverage:'complete',reason:null}:{coverage:'confirmation-needed',reason:'통장 출금 조회가 일부이거나 최신 조회를 완료하지 못했습니다.'};
 };
 for(const target of targets){
  const coverage=coverageFor(target),manualKnown=target.paymentKind!=='tax'&&target.accountId!==null&&meaningful(target.title)&&coverage.coverage==='complete';
  result.set(target.key,{transactions:[],bankTransactionIds:new Set(),...coverage,known:target.source_type==='estimated'||manualKnown,ambiguous:false});
 }
 const candidates=(row:Transaction,group:string|undefined,allowManual:boolean,labels=row)=>targets.filter(target=>{
  if(target.active===false||target.businessId!==row.business_id||target.month!==row.txn_date.slice(0,7))return false;
  const savedCategory=categories.get(row.category_id??''),category=savedCategory??categories.get(bankCategoryGuards.get(row.id)??'');
  if(category&&target.categoryId&&target.categoryId!==category.id)return false;
  // Provisional provider compatibility must never weaken raw loan/internal
  // evidence. Only an actual saved ledger classification can take precedence.
  if(cashPlanInternalOrLoan(row,savedCategory)&&(!savedCategory||target.categoryId!==savedCategory.id))return false;
  if(data.links.some(link=>link.out_transaction_id===row.id))return false;
  if(target.source_type==='estimated')return target.source_key===group;
  if(!allowManual||target.paymentKind==='tax'||target.accountId!==row.account_id||!meaningful(target.title))return false;
  return texts(labels).includes(normalized(target.title));
 });
 const ambiguous=(found:readonly CashPlanActualTarget[])=>{for(const target of found){const match=result.get(target.key)!;match.reason='같은 출금을 연결할 계획 항목이 여러 개이거나 은행 거래의 중복 여부가 불명확합니다.';match.known=false;match.ambiguous=true;}};
 for(const rows of recorded.values())for(const row of rows){
  const actual=union.bankById.get(row.id),labels=actual?bankRow(actual):row;
  const found=candidates(row,groupById.get(row.id),!!actual,labels);
  if(found.length>1){ambiguous(found);continue;}
  if(found.length!==1)continue;
  const match=result.get(found[0].key)!;match.transactions.push(row);match.known=true;if(actual)match.bankTransactionIds.add(row.id);
 }
 // Rows outside historical expense groups can still match a specific manual
 // plan, but observed loan/internal labels must never be guessed as payroll.
 const matchedIds=new Set([...recorded.values()].flatMap(rows=>rows.map(row=>row.id)));
 for(const row of union.rows){
  if(matchedIds.has(row.id)||!union.bankById.has(row.id))continue;
  const found=candidates(row,undefined,true,bankRow(union.bankById.get(row.id)!));
  if(found.length>1){ambiguous(found);continue;}
  if(found.length===1){const match=result.get(found[0].key)!;match.transactions.push(row);match.known=true;match.bankTransactionIds.add(row.id);}
 }
 for(const row of union.blocked){
  const matches=cashEstimateRecordedTransactions({...data,transactions:[...data.transactions.filter(item=>item.txn_date<original.basis.to),row]},asOf,options,original,keys);
  const group=[...matches].find(([,rows])=>rows.some(item=>item.id===row.id))?.[0];
  ambiguous(candidates(row,group,true));
 }
 if((union.data.bank_plan_coverage?.length??0)>0)for(const target of targets){
  const match=result.get(target.key)!;
  if(target.active!==false&&target.month<=asOf.slice(0,7)&&match.coverage==='uncollected'&&!match.reason&&match.transactions.length===0)
   match.reason='이 출금 계좌의 해당 월 은행 거래를 조회하지 못했습니다.';
 }
 return result;
}
