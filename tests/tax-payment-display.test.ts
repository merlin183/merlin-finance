import test from 'node:test';
import assert from 'node:assert/strict';
import {taxPaymentNotices,taxPaymentStatusLabel} from '../lib/finance/tax-payment-display';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import type {Account,Business} from '../lib/finance/types';

const businesses:Business[]=[{id:'business-one',name:'합성 회사 A',color:'#123456',kind:'법인',representative:'',reserve:0},{id:'business-two',name:'합성 회사 B',color:'#654321',kind:'법인',representative:'',reserve:0}];
const accounts:Account[]=[{id:'bank-one',business_id:'business-one',name:'합성 통장',bank:'합성 은행',masked_number:'0000',opening_balance:100,opening_balance_date:'2027-01-01'}];
const item=(patch:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'notice-one',business_id:'business-one',source_type:'manual',source_key:'notice-one',month:'2027-04',title:'합성 납부 일정',account_id:null,plan_date:'2027-04-12',amount:2000,memo:'',excluded:false,version:1,updated_at:'',payment_kind:'tax',payment_status:'pending',...patch});

test('납부월 밖에서도 다음 납부일·일수와 사업자 합계를 읽는다',()=>{
 const notices=taxPaymentNotices([item(),item({id:'notice-two',business_id:'business-two',amount:3000})],businesses,accounts,'all','2027-03-05');
 assert.equal(notices.length,2);assert.equal(notices[0].daysUntil,38);assert.equal(taxPaymentStatusLabel(notices[0]),'납부까지 38일');assert.equal(notices.reduce((sum,row)=>sum+row.edit.amount,0),5000);
});
test('해당일과 기한 경과를 구분하며 미납 항목은 사라지지 않는다',()=>{
 assert.equal(taxPaymentNotices([item()],businesses,accounts,'all','2027-04-12')[0].status,'today');
 const overdue=taxPaymentNotices([item()],businesses,accounts,'all','2027-05-01')[0];
 assert.equal(overdue.status,'overdue');assert.equal(taxPaymentStatusLabel(overdue),'납기 19일 경과 · 미납 확인');
});
test('계획 제외는 납부 완료가 아니며 납부 완료 표시는 별도 이력에 남는다',()=>{
 const excluded=taxPaymentNotices([item({excluded:true})],businesses,accounts,'all','2027-05-01')[0];assert.equal(excluded.status,'overdue');
 const paid=taxPaymentNotices([item({payment_status:'paid'})],businesses,accounts,'all','2027-05-01')[0];assert.equal(paid.status,'paid');assert.equal(taxPaymentStatusLabel(paid),'납부 완료');
 const reopened=taxPaymentNotices([{...paid.edit,payment_status:'pending',version:2}],businesses,accounts,'all','2027-05-01')[0];assert.equal(reopened.status,'overdue');
});
test('일반 지출·알 수 없는 사업자는 배제하고 선택한 사업자의 세금만 표시한다',()=>{
 const rows=[item(),item({id:'general',payment_kind:'general'}),item({id:'unknown',business_id:'unknown'}),item({id:'other',business_id:'business-two'})];
 assert.deepEqual(taxPaymentNotices(rows,businesses,accounts,'business-one','2027-03-05').map(row=>row.edit.id),['notice-one']);
});
test('출금 계좌를 추측하지 않으며 다른 사업자의 계좌도 표시하지 않는다',()=>{
 assert.equal(taxPaymentNotices([item()],businesses,accounts,'all','2027-03-05')[0].account,undefined);
 assert.equal(taxPaymentNotices([item({business_id:'business-two',account_id:'bank-one'})],businesses,accounts,'all','2027-03-05')[0].account,undefined);
 assert.equal(taxPaymentNotices([item({account_id:'bank-one'})],businesses,accounts,'all','2027-03-05')[0].account?.id,'bank-one');
});
test('납부일 누락·잘못된 날짜는 오늘로 보정하지 않고 확인 필요로 표시한다',()=>{
 for(const date of [null,'2027-02-30']){const notice=taxPaymentNotices([item({plan_date:date})],businesses,accounts,'all','2027-03-05')[0];assert.equal(notice.status,'date-missing');assert.equal(notice.daysUntil,null);}
});
test('오래된 중복 응답은 최신 버전보다 우선하지 않으며 입력 자료를 변경하지 않는다',()=>{
 const rows=[item({version:2,payment_status:'paid'}),item({version:1})],before=JSON.stringify(rows);
 assert.equal(taxPaymentNotices(rows,businesses,accounts,'all','2027-03-05').length,1);assert.equal(taxPaymentNotices(rows,businesses,accounts,'all','2027-03-05')[0].status,'paid');assert.equal(JSON.stringify(rows),before);
});
