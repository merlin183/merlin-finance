import {addDays} from './format';
import {isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import {calendarMonthRange,shiftCalendarMonth} from './transaction-calendar';
import {resolveCashPlanPeriod} from './cash-plan-period';
import type {Business,Category,Dataset,Transaction} from './types';
import type {PaymentKind,PaymentStatus} from './cash-plan-edits';

export type CashEstimateOptions={excludedBusinessCategories?:readonly {businessId:string;categoryId:string}[]};
export type CashEstimateGroup={key:string;businessId:string;accountId:string;label:string;categoryNames:string[];monthlyAverage:number;monthlyAmounts:{month:string;amount:number;count:number}[];sourceCount:number;sourceIds:string[];expectedDay:number|null;monthEnd:boolean};
export type CashDatedEstimate={groupKey:string;businessId:string;accountId:string;title:string;date:string;amount:number;originalAmount?:number;recordedAmount?:number;memo?:string;sourceType?:'estimated'|'manual';sourceAccountId?:string;paymentKind?:PaymentKind;paymentStatus?:PaymentStatus};
export type CashUndatedBudget={groupKey:string;businessId:string;accountId:string;title:string;month:string;from:string;to:string;coveredDays:number;monthDays:number;monthlyAmount:number;amount:number;kind:'period-budget';originalAmount?:number;recordedAmount?:number;expectedDate?:string;status?:'date-passed';memo?:string;sourceType?:'estimated'|'manual';sourceAccountId?:string;paymentKind?:PaymentKind;paymentStatus?:PaymentStatus};
export type CashEstimateExclusion={groupKey:string;businessId:string;accountId:string;label:string;reason:string;sourceCount:number};
export type CashEstimateBusiness={business:Business;total:number;dated:CashDatedEstimate[];undated:CashUndatedBudget[];groups:CashEstimateGroup[];exclusions:CashEstimateExclusion[]};
export type CashEstimates={asOf:string;horizon:number;range:DateRange;basis:{from:string;to:string;months:string[];groupingBasis:string};businesses:CashEstimateBusiness[];reminders:string[]};

const normalized=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
const categoryKey=(value:string)=>normalized(value).replace(/\s+/g,'');
const internalCategories=new Set(['대여금','대여금상환','대여금반환','가수금','차입금','차입금상환','차입금반환','대출','대출금','대출금상환','대출상환','미수금','미수금상환','미수금반환','현금대체','다행이체','계좌이체','내부이동']);
const genericMerchant=/^(?:급여|입금|출금|현금|현금출금|현금입금|이체|계좌이체|인터넷이체|인터넷당행|타행|타행이체|타행mb|bz뱅크|신한체|fb자동|op이체)$/i;
const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;

function sourceIdentity(transaction:Transaction){
 const counterparty=transaction.source_details?.counterparty?.trim();
 const label=counterparty||transaction.description.trim();
 return {label,key:`${counterparty?'counterparty':'description'}:${normalized(label)}`,ambiguous:!label||genericMerchant.test(normalized(label))};
}

export function cashEstimateSourceKey(transaction:Transaction,identity=sourceIdentity(transaction)){
 return JSON.stringify([transaction.business_id,transaction.account_id,identity.key]);
}
const sourceGroupKey=cashEstimateSourceKey;

function isInternalOrLoan(transaction:Transaction,category:Category|undefined):boolean {
 return transaction.is_internal||!!category?.is_internal||categoryKey(category?.group_name||'')==='내부이동'
  ||internalCategories.has(categoryKey(category?.name||transaction.raw_gwamok));
}

function projectionMonths(range:DateRange){
 const monthIndex=(date:string)=>Number(date.slice(0,4))*12+Number(date.slice(5,7))-1;
 const result:{month:string;from:string;to:string;coveredDays:number;monthDays:number}[]=[];
 for(let index=monthIndex(range.from);index<=monthIndex(range.to);index++){
  const month=`${String(Math.floor(index/12)).padStart(4,'0')}-${String(index%12+1).padStart(2,'0')}`;
  const full=calendarMonthRange(month),from=range.from>full.from?range.from:full.from,to=range.to<full.to?range.to:full.to;
  result.push({month,from,to,coveredDays:Number(to.slice(-2))-Number(from.slice(-2))+1,monthDays:Number(full.to.slice(-2))});
 }
 return result;
}

/** Read-only budget estimates. They never become transactions, registered
 * schedules, confirmed due dates, or matches against an actual payment. */
export function buildCashEstimates(data:Dataset,asOf:string,horizon=30,options:CashEstimateOptions={}):CashEstimates {
 if(!parseFinanceDate(asOf))throw new RangeError('추정 기준일을 확인해주세요.');
 if(!Number.isSafeInteger(horizon)||horizon<1)throw new RangeError('예정 기간은 1일 이상의 정수로 입력해주세요.');
 const range={from:addDays(asOf,1),to:addDays(asOf,horizon)};
 if(!isValidDateRange(range))throw new RangeError('조회할 추정 기간을 확인해주세요.');
 return estimatePeriod(data,asOf,horizon,range,asOf.slice(0,7),options);
}

/** The evidence is the three completed months before the selected start month,
 * independently of the balance cutoff or the day this screen is opened. */
export function buildCashEstimatesForRange(data:Dataset,range:DateRange,options:CashEstimateOptions={}):CashEstimates {
 const period=resolveCashPlanPeriod(range);
 return estimatePeriod(data,period.asOf,period.horizon,period.range,range.from.slice(0,7),options);
}

/** Whole budgets before payment reconciliation. Editors use this so a fully
 * consumed budget remains editable and dates can move into the selected range. */
export function buildCashEstimateBudgetsForRange(data:Dataset,range:DateRange,asOf:string,options:CashEstimateOptions={}):CashEstimates {
 if(!parseFinanceDate(asOf))throw new RangeError('현재 잔액의 조회 기준일을 확인해주세요.');
 const period=resolveCashPlanPeriod(range);
 const sourceData={...data,transactions:data.transactions.filter(row=>!!parseFinanceDate(row.txn_date)&&row.txn_date<=asOf)};
 const evidenceMonth=range.from.slice(0,7)<asOf.slice(0,7)?range.from.slice(0,7):asOf.slice(0,7);
 return estimatePeriod(sourceData,asOf,period.horizon,period.range,evidenceMonth,options);
}

/** A provider may preserve the bank label in basic/detail while adding a
 * counterparty or a composite description. Reconcile only an exact, unique
 * description-only budget label; historical counterparty identities stay apart. */
function bankLabelBudgetMatcher(data:Dataset,original:CashEstimates|undefined,protectedSourceKeys:Iterable<string>){
 const protectedKeys=new Set(protectedSourceKeys),sourceKeys=new Set(protectedKeys),activeKeys=new Set<string>();
 const targets=new Map<string,string>(),owners=new Map<string,Set<string>>(),protectedTargets=new Set<string>();
 const compositeOwners=new Map<string,Set<string>>();
 const currentParties=new Map<string,Set<string>>();
 const labelKey=(businessId:string,accountId:string,label:string)=>JSON.stringify([businessId,accountId,normalized(label)]);
 const currentLabelKey=(row:Transaction,label:string)=>JSON.stringify([row.business_id,row.account_id,row.txn_date.slice(0,7),normalized(label)]);
 const meaningful=(label:string)=>!!label&&!genericMerchant.test(label)&&/\p{L}/u.test(label);
 for(const business of original?.businesses??[]){
  for(const group of business.groups){
   sourceKeys.add(group.key);activeKeys.add(group.key);
   const label=normalized(group.label);
   if(meaningful(label)&&group.key===JSON.stringify([group.businessId,group.accountId,`description:${label}`]))
    targets.set(labelKey(group.businessId,group.accountId,label),group.key);
  }
  for(const excluded of business.exclusions)sourceKeys.add(excluded.groupKey);
 }
 // A saved estimate remains a plan after its source leaves the rolling
 // estimator. Only canonical description identities can supply a bank label;
 // the saved title and destination account are never matching evidence.
 for(const key of protectedKeys){
  try{
   const parsed:unknown=JSON.parse(key);
   if(!Array.isArray(parsed)||parsed.length!==3||parsed.some(value=>typeof value!=='string')||JSON.stringify(parsed)!==key)continue;
   const [businessId,accountId,identity]=parsed as string[];
   if(!identity.startsWith('description:'))continue;
   const label=identity.slice('description:'.length);
   if(label!==normalized(label)||!meaningful(label))continue;
   targets.set(labelKey(businessId,accountId,label),key);protectedTargets.add(key);
  }catch{/* Invalid or legacy identities keep exact-key-only matching. */}
 }
 const compositeTarget=(row:Transaction,exactKey:string):string|null=>{
  if(protectedKeys.has(exactKey)||activeKeys.has(exactKey)||row.source_details?.counterparty?.trim())return null;
  const basic=normalized(row.source_details?.basic??''),detail=normalized(row.source_details?.detail??'');
  if(!meaningful(basic)||!meaningful(detail)||basic===detail||normalized(row.description)!==`${basic} · ${detail}`)return null;
  const found=new Set([targets.get(labelKey(row.business_id,row.account_id,basic)),targets.get(labelKey(row.business_id,row.account_id,detail))]
   .filter((key):key is string=>!!key&&protectedTargets.has(key)));
  return found.size===1?[...found][0]:null;
 };
 if(original)for(const row of data.transactions){
  if(row.direction!=='out'||!parseFinanceDate(row.txn_date)||row.txn_date<original.basis.from||row.txn_date>original.asOf)continue;
  const sourceKey=sourceGroupKey(row),composite=compositeTarget(row,sourceKey);
  if(composite){const aliases=compositeOwners.get(composite)??new Set<string>();aliases.add(sourceKey);compositeOwners.set(composite,aliases);}
  if(row.txn_date>original.basis.to){
   const party=row.source_details?.counterparty?.trim();
   if(party)for(const label of [row.source_details?.basic,row.source_details?.detail]){
    if(!label||!targets.has(labelKey(row.business_id,row.account_id,label)))continue;
    const key=currentLabelKey(row,label),found=currentParties.get(key)??new Set<string>();
    found.add(normalized(party));currentParties.set(key,found);
   }
   continue;
  }
  for(const label of [sourceIdentity(row).label,row.description,row.source_details?.basic,row.source_details?.detail]){
   if(!label||!meaningful(normalized(label)))continue;
   const key=labelKey(row.business_id,row.account_id,label),found=owners.get(key)??new Set<string>();
   found.add(sourceKey);owners.set(key,found);
  }
 }
 return (row:Transaction,exactKey:string):string=>{
  // Existing matching budgets (including excluded identities) take precedence.
  // Every actual transaction is assigned to only one key, never credited twice.
  const composite=compositeTarget(row,exactKey);
  if(sourceKeys.has(exactKey)&&!composite)return exactKey;
  const candidates=new Set<string>();
  for(const label of [row.source_details?.basic,row.source_details?.detail]){
   if(!label||!meaningful(normalized(label)))continue;
   const key=labelKey(row.business_id,row.account_id,label),target=targets.get(key);
   if(!target)continue;
   const identities=owners.get(key);
   const aliases=protectedTargets.has(target)?compositeOwners.get(target):undefined;
   // The sole format-only historical alias must not itself own another plan.
   // More than one composite source, a counterparty identity, or a second
   // description owner is evidence of ambiguity rather than a merchant alias.
   const uniqueOwner=identities?.has(target)&&[...identities].every(identity=>identity===target||aliases?.size===1&&aliases.has(identity));
   if(!uniqueOwner||(aliases?.size??0)>1||(currentParties.get(currentLabelKey(row,label))?.size??0)>1)return exactKey;
   if(sourceKeys.has(exactKey)&&composite!==target)continue;
   candidates.add(target);
  }
  return candidates.size===1?[...candidates][0]:exactKey;
 };
}

/** Exact source identities, with an optional unambiguous original-bank-label
 * bridge. Edited titles and destination account guesses are never evidence. */
export function cashEstimateRecordedTransactions(data:Dataset,asOf:string,options:CashEstimateOptions={},original?:CashEstimates,protectedSourceKeys:Iterable<string>=[]):Map<string,Transaction[]> {
 const categories=new Map(data.categories.map(category=>[category.id,category]));
 const linkedInternalWithdrawals=new Set(data.links.map(link=>link.out_transaction_id));
 const excludedPolicies=new Set((options.excludedBusinessCategories??[]).map(item=>JSON.stringify([item.businessId,item.categoryId])));
 const result=new Map<string,Transaction[]>();
 const matchBudget=bankLabelBudgetMatcher(data,original,protectedSourceKeys);
 for(const row of data.transactions){
  if(!parseFinanceDate(row.txn_date)||row.txn_date>asOf||row.direction!=='out'||!Number.isSafeInteger(row.amount)||row.amount<=0
   ||linkedInternalWithdrawals.has(row.id)||isInternalOrLoan(row,categories.get(row.category_id??''))
   ||excludedPolicies.has(JSON.stringify([row.business_id,row.category_id])))continue;
  const key=matchBudget(row,sourceGroupKey(row)),rows=result.get(key);
  if(rows)rows.push(row);else result.set(key,[row]);
 }
 return result;
}

/** Subtract already recorded spending from a budget, never infer that an
 * invoice is paid. Exact bank/business/source identities are shared with the
 * historical estimate builder. Incoming refunds and other months stay apart. */
export function buildRemainingCashEstimatesForRange(data:Dataset,range:DateRange,asOf:string,options:CashEstimateOptions={}):CashEstimates {
 const original=buildCashEstimateBudgetsForRange(data,range,asOf,options);
 const recordedByGroup=cashEstimateRecordedTransactions(data,asOf,options,original);
 const sumRecorded=(key:string,from:string,to:string)=>(recordedByGroup.get(key)??[]).reduce((sum,row)=>sum+(row.txn_date>=from&&row.txn_date<=to?row.amount:0),0);
 const periods=new Map(projectionMonths(range).map(item=>[item.month,item]));
 const businesses=original.businesses.map((business):CashEstimateBusiness=>{
  const dated:CashDatedEstimate[]=[];
  const undated:CashUndatedBudget[]=[];
  for(const item of business.dated){
   const month=item.date.slice(0,7),full=calendarMonthRange(month);
   const recordedAmount=sumRecorded(item.groupKey,full.from,full.to),amount=Math.max(0,item.amount-recordedAmount);
   if(amount===0)continue;
   if(item.date<asOf){
    const covered=periods.get(month)!;
    undated.push({groupKey:item.groupKey,businessId:item.businessId,accountId:item.accountId,title:item.title,
     ...covered,monthlyAmount:item.amount,amount,kind:'period-budget',originalAmount:item.amount,recordedAmount,
     expectedDate:item.date,status:'date-passed',
    });
   }else dated.push({...item,amount,originalAmount:item.amount,recordedAmount});
  }
  for(const item of business.undated){
   // This amount is already prorated to this exact selected period. Do not
   // charge an earlier/later period's spending against it or prorate it twice.
   const recordedAmount=sumRecorded(item.groupKey,item.from,item.to),amount=Math.max(0,item.amount-recordedAmount);
   if(amount>0)undated.push({...item,amount,originalAmount:item.amount,recordedAmount});
  }
  undated.sort((left,right)=>compareText(left.month,right.month)||compareText(left.title,right.title)||compareText(left.groupKey,right.groupKey));
  return {...business,dated,undated,total:dated.reduce((sum,item)=>sum+item.amount,0)+undated.reduce((sum,item)=>sum+item.amount,0)};
 });
 return {...original,businesses,reminders:[
  '같은 사업자·통장·원본 거래처의 확인된 출금 실적을 예상 예산에서 차감한 잔여 예산입니다. 실제 청구서의 지급 완료나 미지급 의무를 확정하지 않습니다.',
  '현재 기록 잔액에는 이미 발생한 입출금이 반영되어 있으므로 남은 지출 예산만 추가로 차감합니다. 입금·환불이나 다른 월·항목의 초과 지출은 서로 상계하지 않습니다.',
  '원래 예상일이 지났는데 남은 예산이 있으면 지급 여부 확인이 필요한 날짜 미정 항목으로 보존합니다. 과거 예상일을 새로운 입금 기한으로 표시하지 않습니다.',
  '날짜 미정 기간 예산은 선택 기간에 안분한 원래 예산에서 같은 기간의 출금 실적만 차감합니다. 날짜별 추가 입금 계산에는 포함하지 않습니다.',
  '추정 근거는 계획 시작월과 오늘 중 이른 월의 직전 3개 완료 월입니다. 통장 원본이 누락되면 현재 잔액과 잔여 예산도 달라질 수 있습니다.',
  '등록된 예정 항목과 합산하지 않으며 미래 수입을 추정하지 않습니다. 카드대금·충전액과 개별 결제가 함께 들어갈 수 있어 확정 비용 합계로 사용할 수 없습니다.',
 ]};
}

function estimatePeriod(data:Dataset,asOf:string,horizon:number,range:DateRange,currentMonth:string,options:CashEstimateOptions):CashEstimates {
 const months=[-3,-2,-1].map(delta=>shiftCalendarMonth(currentMonth,delta));
 if(new Set(months).size!==3||months[2]===currentMonth)throw new RangeError('직전 3개월 자료를 조회할 수 있는 기준일을 선택해주세요.');
 const basis={from:calendarMonthRange(months[0]).from,to:calendarMonthRange(months[2]).to,months,groupingBasis:'같은 사업자·통장과 명시된 거래상대방, 없으면 원본 적요의 정확한 표기 기준(전각문자·공백·대소문자 통일)'};
 const categories=new Map(data.categories.map(category=>[category.id,category]));
 const linkedInternalWithdrawals=new Set(data.links.map(link=>link.out_transaction_id));
 const excludedPolicies=new Set((options.excludedBusinessCategories||[]).map(item=>JSON.stringify([item.businessId,item.categoryId])));
 const sourceGroups=new Map<string,{businessId:string;accountId:string;label:string;ambiguous:boolean;rows:Transaction[]}>();
 for(const transaction of data.transactions){
  if(transaction.direction!=='out'||transaction.txn_date<basis.from||transaction.txn_date>basis.to||!parseFinanceDate(transaction.txn_date))continue;
  const identity=sourceIdentity(transaction),key=sourceGroupKey(transaction,identity);
  const found=sourceGroups.get(key);
  if(found)found.rows.push(transaction);
  else sourceGroups.set(key,{businessId:transaction.business_id,accountId:transaction.account_id,label:identity.label,ambiguous:identity.ambiguous,rows:[transaction]});
 }
 const periods=projectionMonths(range);
 const businesses=data.businesses.map((business):CashEstimateBusiness=>({business,total:0,dated:[],undated:[],groups:[],exclusions:[]}));
 const byBusiness=new Map(businesses.map(item=>[item.business.id,item]));
 for(const [key,source] of sourceGroups){
  const business=byBusiness.get(source.businessId);if(!business)continue;
  const rows=[...source.rows].sort((left,right)=>compareText(left.txn_date,right.txn_date)||compareText(left.id,right.id));
  const monthlyAmounts=months.map(month=>{
   const matching=rows.filter(row=>row.txn_date.startsWith(`${month}-`));
   return {month,amount:matching.reduce((sum,row)=>sum+row.amount,0),count:matching.length};
  });
  const observed=monthlyAmounts.filter(item=>item.count>0);
  let reason='';
  if(rows.some(row=>excludedPolicies.has(JSON.stringify([row.business_id,row.category_id]))))reason='사용자가 제외한 사업자·계정과목';
  else if(rows.some(row=>linkedInternalWithdrawals.has(row.id)||isInternalOrLoan(row,categories.get(row.category_id||''))))reason='대여·차입 또는 내부이동 포함';
  else if(source.ambiguous)reason='거래처를 구분할 원본 내역 확인 필요';
  else if(rows.some(row=>!Number.isSafeInteger(row.amount)||row.amount<=0))reason='원본 출금 금액 확인 필요';
  else if(observed.length<2)reason='직전 3개월 중 2개월 이상 출금 근거 없음';
  else if(!monthlyAmounts[2].count)reason='가장 최근 완료 월의 출금 없음';
  if(reason){
   business.exclusions.push({groupKey:key,businessId:source.businessId,accountId:source.accountId,label:source.label,reason,sourceCount:rows.length});
   continue;
  }
  const days=rows.map(row=>Number(row.txn_date.slice(-2))).sort((left,right)=>left-right);
  const stable=observed.every(item=>item.count===1)&&days.at(-1)!-days[0]<=6;
  // Late-month payments are not automatically month-end payments. A fixed
  // 28th stays the 28th unless every observation was its actual month's end.
  const monthEnd=stable&&rows.every(row=>row.txn_date===calendarMonthRange(row.txn_date.slice(0,7)).to);
  const median=days.length%2?days[Math.floor(days.length/2)]:(days[days.length/2-1]+days[days.length/2])/2;
  const expectedDay=stable?(monthEnd?31:Math.round(median)):null;
  const monthlyAverage=Math.round(monthlyAmounts.reduce((sum,item)=>sum+item.amount,0)/3);
  const categoryNames=[...new Set(rows.map(row=>categories.get(row.category_id||'')?.name||row.raw_gwamok||'미분류'))].sort(compareText);
  const group:CashEstimateGroup={key,businessId:source.businessId,accountId:source.accountId,label:source.label,categoryNames,monthlyAverage,monthlyAmounts,sourceCount:rows.length,sourceIds:rows.map(row=>row.id),expectedDay,monthEnd};
  business.groups.push(group);
  for(const period of periods){
   if(expectedDay!==null){
    const date=`${period.month}-${String(Math.min(expectedDay,period.monthDays)).padStart(2,'0')}`;
    if(date<period.from||date>period.to)continue;
    business.dated.push({groupKey:key,businessId:source.businessId,accountId:source.accountId,title:source.label,date,amount:monthlyAverage});
    business.total+=monthlyAverage;
   }else{
    const amount=Math.round(monthlyAverage*period.coveredDays/period.monthDays);
    business.undated.push({groupKey:key,businessId:source.businessId,accountId:source.accountId,title:source.label,...period,monthlyAmount:monthlyAverage,amount,kind:'period-budget'});
    business.total+=amount;
   }
  }
 }
 for(const business of businesses){
  business.groups.sort((left,right)=>compareText(left.label,right.label)||compareText(left.key,right.key));
  business.dated.sort((left,right)=>compareText(left.date,right.date)||compareText(left.title,right.title)||compareText(left.groupKey,right.groupKey));
  business.undated.sort((left,right)=>compareText(left.month,right.month)||compareText(left.title,right.title)||compareText(left.groupKey,right.groupKey));
  business.exclusions.sort((left,right)=>compareText(left.label,right.label)||compareText(left.groupKey,right.groupKey));
 }
 return {asOf,horizon,range,basis,businesses,reminders:[
  '과거 출금의 반복 패턴으로 계산한 예산 추정입니다. 확정 청구액·지급일 또는 미지급액이 아닙니다.',
  '날짜가 일정하지 않은 항목은 월 예상액에 조회기간의 월별 일수 비율을 적용한 기간 예산이며 특정 출금일을 지정하지 않습니다.',
  '직전 3개월은 달력상 완료 월입니다. 통장 원본이 누락되면 추정액도 달라질 수 있습니다.',
  '등록된 예정 항목과 합산하지 않습니다. 실제 거래와 지급 여부를 자동 대조하거나 미래 수입을 추정하지 않습니다.',
  '카드대금·충전액과 개별 결제가 함께 들어갈 수 있어 확정 비용 합계로 사용할 수 없습니다.',
 ]};
}
