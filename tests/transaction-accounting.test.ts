import test from 'node:test';
import assert from 'node:assert/strict';
import {accountingTransactions,transferFeeDetails} from '../lib/finance/transaction-accounting';
import {spendingMatrix} from '../lib/finance/spending';
import {monthly} from '../lib/finance/aggregate';
import {accountSnapshot} from '../lib/finance/balances';
import {buildCashEstimateBudgetsForRange,cashEstimateRecordedTransactions} from '../lib/finance/cash-estimates';
import {unionBankPlanTransactions} from '../lib/finance/clobe-plan-actuals';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const outgoing:Transaction={id:'bank-out',business_id:'business',account_id:'from',upload_id:null,txn_date:'2027-04-10',txn_time:'12:00:00',amount:10025,balance:19975,direction:'out',description:'Synthetic own transfer',raw_gwamok:'',category_id:'transfer',is_internal:true,tax_invoice:false,dedup_hash:'original-fingerprint',source_details:{basic:'Synthetic own transfer',note:'계좌간 출금'},manually_classified:true,transfer_fee_amount:25,transfer_fee_category_id:'fee'};
const incoming:Transaction={...outgoing,id:'bank-in',account_id:'to',amount:10000,balance:15000,direction:'in',dedup_hash:'incoming-fingerprint',source_details:{basic:'Synthetic own transfer',note:'계좌간 입금'},transfer_fee_amount:0,transfer_fee_category_id:null};
const data:Dataset={...emptyDataset,businesses:[{id:'business',name:'Synthetic business',representative:'',kind:'법인',reserve:0,color:'#000'}],accounts:[{id:'from',business_id:'business',bank:'Bank',name:'From',masked_number:'0001',opening_balance:30000,opening_balance_date:'2027-04-01'},{id:'to',business_id:'business',bank:'Bank',name:'To',masked_number:'0002',opening_balance:5000,opening_balance_date:'2027-04-01'}],categories:[{id:'transfer',name:'계좌간이체',group_name:'내부이동',is_internal:true,is_operating:false},{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],transactions:[outgoing,incoming]};

test('원본 은행 행·잔액·중복키를 보존하며 원금과 수수료 합계는 원본과 같다',()=>{
 const before=JSON.stringify(data),rows=accountingTransactions(data,data.transactions);
 assert.equal(rows.length,3);assert.equal(new Set(rows.map(t=>t.id)).size,3);
 assert.deepEqual(rows.filter(t=>t.accounting_source_id===outgoing.id).map(t=>[t.accounting_component,t.amount,t.category_id,t.is_internal]),[['principal',10000,'transfer',true],['fee',25,'fee',false]]);
 assert.equal(rows.filter(t=>t.accounting_source_id===outgoing.id).reduce((s,t)=>s+t.amount,0),outgoing.amount);
 assert.equal(JSON.stringify(data),before);assert.equal(data.transactions.length,2);
 assert.equal(accountSnapshot(data.accounts[0],data.transactions,'2027-04-10').balance,19975);
 assert.equal(accountSnapshot(data.accounts[1],data.transactions,'2027-04-10').balance,15000);
 assert.equal(rows[0].balance,null);assert.equal(rows[1].accounting_source_amount,10025);
});

test('내부이동 제외·외부 지출·영업 집계에는 수수료만 남고 전체 순현금은 동일하다',()=>{
 const external=accountingTransactions(data,data.transactions,true);
 assert.equal(external.length,1);assert.equal(external[0].amount,25);assert.equal(external[0].category_id,'fee');
 const matrix=spendingMatrix(data,data.transactions,data.businesses,'out');assert.equal(matrix.total,25);assert.equal(matrix.rows[0].name,'지급수수료');assert.equal(matrix.rows[0].cells.business.rows[0].accounting_source_id,'bank-out');
 const operating=external.filter(t=>data.categories.find(c=>c.id===t.category_id)?.is_operating);assert.equal(operating.reduce((s,t)=>s+t.amount,0),25);
 assert.deepEqual(monthly(accountingTransactions(data,data.transactions)),monthly(data.transactions));
 assert.deepEqual(accountingTransactions(data,accountingTransactions(data,data.transactions)),accountingTransactions(data,data.transactions));
 assert.equal(spendingMatrix(data,external,data.businesses,'out').total,25);
});

test('잘못된 수수료·외부 원금·입금·없는 과목에는 비용을 만들어 넣지 않는다',()=>{
 for(const extra of [{transfer_fee_amount:0},{transfer_fee_amount:-1},{transfer_fee_amount:10025},{transfer_fee_amount:10026},{transfer_fee_amount:0.5},{transfer_fee_amount:NaN},{transfer_fee_category_id:null},{transfer_fee_category_id:'missing'},{transfer_fee_category_id:'transfer'},{category_id:'fee'},{is_internal:false},{direction:'in' as const}]){
  const row={...outgoing,...extra};assert.equal(transferFeeDetails(data,row),null);assert.deepEqual(accountingTransactions(data,[row]),[row]);
 }
 assert.deepEqual(accountingTransactions(data,[{...incoming,transfer_fee_amount:undefined,transfer_fee_category_id:undefined}]).map(t=>t.amount),[10000]);
});

test('은행 출금 증거와 동일 원본은 하나로 남고 수수료를 급여·반복 계획 실적으로 오인하지 않는다',()=>{
 const ledger={...data,bank_plan_actuals:[{account_id:'from',business_id:'business',external_transaction_id:'synthetic-provider-ref',txn_date:outgoing.txn_date,txn_time:outgoing.txn_time!,amount:outgoing.amount,balance:outgoing.balance,description:outgoing.description,party:null,source_details:outgoing.source_details!,currency:'KRW' as const,source:'clobe' as const,collected_at:'2027-04-10T14:00:00+09:00',synced_at:'2027-04-10T05:01:00Z',transaction_id:outgoing.id}]};
 const covered={...ledger,bank_plan_coverage:[{account_id:'from',business_id:'business',from:'2027-04-01',to:'2027-04-10',collected_at:'2027-04-10T14:00:00+09:00',synced_at:'2027-04-10T05:01:00Z',status:'complete' as const,reason:null,source:'clobe' as const,currency:'KRW' as const}]};
 const union=unionBankPlanTransactions(covered,'2027-04-10');assert.equal(union.rows.length,1);assert.equal(union.rows.find(t=>t.id==='bank-out')?.amount,10025);assert.equal(union.bankById.size,1);assert.equal(union.blocked.length,0);
 assert.equal(cashEstimateRecordedTransactions(ledger,'2027-04-30').size,0);
 const historical={...data,transactions:['01','02','03'].map(month=>({...outgoing,id:month,txn_date:`2027-${month}-10`,description:'Synthetic payroll recipient'}))};
 const budgets=buildCashEstimateBudgetsForRange(historical,{from:'2027-04-01',to:'2027-04-30'},'2027-04-10');assert.equal(budgets.businesses[0].total,0);
});
