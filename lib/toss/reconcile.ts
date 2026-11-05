import {parseFinanceDate} from '../finance/date-range';
import {buildLatestCashBalances} from '../finance/latest-cash-balances';
import type {Dataset,Transaction} from '../finance/types';
import type {TossMerchant,TossSettlement,TossSettlementGroup} from './types';

const identity=(row:Transaction)=>[row.description,row.source_details?.basic,row.source_details?.detail,row.source_details?.counterparty,row.source_details?.record]
 .some(value=>typeof value==='string'&&/(?:토스페이먼|tosspayments)/iu.test(value.normalize('NFKC').replace(/[\s._()-]/g,'')));
const money=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
/** Settlement records are expectations, never another bank deposit. Group all
 * MIDs sharing the same account/day so a bank receipt cannot be reused. Today
 * and overdue unmatched amounts stay visible but are not added to cash. */
export function reconcileTossSettlements(data:Dataset,settlements:readonly TossSettlement[],merchants:readonly TossMerchant[],asOf:string):TossSettlementGroup[]{
 if(!parseFinanceDate(asOf))return [];
 const accounts=new Map(data.accounts.map(row=>[row.id,row.business_id]));
 const mappings=new Map(merchants.filter(row=>accounts.get(row.accountId)===row.businessId).map(row=>[row.merchantId,row]));
 const records=new Map<string,TossSettlement>(),conflicts=new Set<string>();
 for(const row of settlements){
  const mapping=mappings.get(row.merchant_id);
  if(!mapping||mapping.accountId!==row.account_id||mapping.businessId!==row.business_id||!parseFinanceDate(row.paid_out_date)||!parseFinanceDate(row.sold_date)||!row.transaction_key||!money(row.pay_out_amount))continue;
  const key=JSON.stringify([row.merchant_id,row.transaction_key]),previous=records.get(key);
  if(previous&&JSON.stringify([previous.paid_out_date,previous.pay_out_amount])!==JSON.stringify([row.paid_out_date,row.pay_out_amount]))conflicts.add(key);
  records.set(key,row);
 }
 const groups=new Map<string,TossSettlementGroup>();
 for(const [key,row] of records){
  const id=JSON.stringify([row.business_id,row.account_id,row.paid_out_date]),group=groups.get(id)??{id,businessId:row.business_id,accountId:row.account_id,date:row.paid_out_date,merchantIds:[],amount:0,receivedAmount:0,pendingAmount:0,status:'pending' as const,matchedTransactionIds:[],reason:null};
  group.amount+=row.pay_out_amount;if(!group.merchantIds.includes(row.merchant_id))group.merchantIds.push(row.merchant_id);
  if(conflicts.has(key))group.reason='같은 정산 거래의 금액이나 지급일이 달라 확인이 필요합니다.';
  groups.set(id,group);
 }
 const snapshotDates=new Map(buildLatestCashBalances(data,asOf).businesses.flatMap(row=>row.accounts.map(item=>[item.account.id,item.snapshot.date??''] as const)));
 const deposits=new Map<string,Transaction[]>(),seenIds=new Map<string,Transaction>(),badIds=new Set<string>();
 for(const row of data.transactions){
  if(row.direction!=='in'||row.txn_date>asOf||!parseFinanceDate(row.txn_date)||!money(row.amount)||row.amount<=0||!identity(row)||accounts.get(row.account_id)!==row.business_id)continue;
  const previous=seenIds.get(row.id);
  if(previous&&JSON.stringify([previous.account_id,previous.txn_date,previous.amount])!==JSON.stringify([row.account_id,row.txn_date,row.amount]))badIds.add(row.id);
  seenIds.set(row.id,row);
 }
 for(const row of seenIds.values()){
  if(badIds.has(row.id))continue;
  const key=JSON.stringify([row.business_id,row.account_id,row.txn_date]),rows=deposits.get(key)??[];rows.push(row);deposits.set(key,rows);
 }
 for(const group of groups.values()){
  const observed=deposits.get(group.id)??[],received=observed.reduce((sum,row)=>sum+row.amount,0);
  if(group.reason||!money(group.amount)||group.amount<0){group.status='confirmation-needed';group.reason??='정산 차감액 또는 합계를 확인해주세요.';continue;}
  if(group.amount===0){group.status='received';group.reason='승인·취소를 합산한 정산액이 0원입니다. 통장 입금 완료를 뜻하지 않습니다.';continue;}
  if(received===group.amount){group.status='received';group.receivedAmount=received;group.matchedTransactionIds=observed.map(row=>row.id);continue;}
  if(observed.length){group.status='confirmation-needed';group.reason='토스 입금과 정산 합계가 다릅니다. 확인 전에는 예정 입금을 더하지 않습니다.';group.receivedAmount=received;group.matchedTransactionIds=observed.map(row=>row.id);continue;}
  if(group.date<asOf){group.status='overdue';group.reason='지급일이 지났지만 일치하는 통장 입금을 확인하지 못했습니다.';continue;}
  if(group.date===asOf||group.date<=(snapshotDates.get(group.accountId)??'')){group.status='confirmation-needed';group.reason='현재 잔액에 포함됐는지 확인 전에는 예정 입금을 더하지 않습니다.';continue;}
  group.pendingAmount=group.amount;
 }
 return [...groups.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.businessId.localeCompare(b.businessId)||a.accountId.localeCompare(b.accountId));
}
