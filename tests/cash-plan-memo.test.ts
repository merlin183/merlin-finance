import assert from 'node:assert/strict';
import test from 'node:test';
import {cashPlanMemoDisplay,cashPlanUserMemo,mergeCashPlanUserMemo} from '../lib/finance/cash-plan-memo';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildClobeCardPlanChanges} from '../lib/finance/clobe-card-plan';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Dataset} from '../lib/finance/types';

const b1='10000000-0000-4000-8000-000000000001',a1='10000000-0000-4000-8000-000000000002',billId='10000000-0000-4000-8000-000000000003';
const marker=`[clobe-card-bill:synthetic-company:${billId}]`;
const keys='대체 계획 키: ["synthetic-plan-key"]';
const stored=`${marker}\n${keys}`;

test('ordinary and tax memos are unchanged, including marker-like user text without import provenance',()=>{
 for(const memo of ['', '  합성 사용자 메모\n계좌 확인  ', '고지서 확인 · 납부기일 확인', '대체 계획 키: 이 문장은 사용자 메모', '참고: [clobe-card-bill:예시]']){
  assert.equal(cashPlanMemoDisplay(memo),memo);assert.equal(cashPlanUserMemo(memo),memo);
  assert.equal(mergeCashPlanUserMemo(memo,'새 사용자 메모'),'새 사용자 메모');
 }
});

test('card provenance is hidden from display and form input while user text remains visible',()=>{
 assert.equal(cashPlanMemoDisplay(stored),'클로브 카드 청구 반영');assert.equal(cashPlanUserMemo(stored),'');
 const withUser=`${stored}\n합성 사용자 메모\n지급일 확인`;
 assert.equal(cashPlanUserMemo(withUser),'합성 사용자 메모\n지급일 확인');
 assert.equal(cashPlanMemoDisplay(withUser),'클로브 카드 청구 반영 · 합성 사용자 메모\n지급일 확인');
 assert.equal(cashPlanMemoDisplay(cashPlanMemoDisplay(withUser)),cashPlanMemoDisplay(withUser),'safe display can be used more than once');
 assert.doesNotMatch(cashPlanMemoDisplay(withUser),/clobe-card-bill|synthetic-plan-key|대체 계획 키/);
});

test('editing, clearing and previewing user memo preserve exact original provenance',()=>{
 const original=`${stored}\n이전 사용자 메모`;
 assert.equal(mergeCashPlanUserMemo(original,'새 사용자 메모'),`${stored}\n새 사용자 메모`);
 assert.equal(mergeCashPlanUserMemo(original,''),stored);
 assert.equal(cashPlanUserMemo(mergeCashPlanUserMemo(original,'')),'');
 assert.equal(mergeCashPlanUserMemo(mergeCashPlanUserMemo(original,'수정 1'),'수정 2'),`${stored}\n수정 2`);
 // Hide malformed internal source JSON as well; retaining it must not expose IDs.
 const malformed=`${marker}\n대체 계획 키: [unclosed\n사용자 문장`;
 assert.equal(cashPlanMemoDisplay(malformed),'클로브 카드 청구 반영 · 사용자 문장');
 assert.match(mergeCashPlanUserMemo(malformed,'수정 문장'),/대체 계획 키: \[unclosed/);
});

const data:Dataset={...emptyDataset,businesses:[{id:b1,name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:a1,business_id:b1,name:'합성 계좌',bank:'합성',masked_number:'0001',opening_balance:1000,opening_balance_date:'2027-03-31'}]};
const edit:CashPlanEdit={id:billId,business_id:b1,source_type:'manual',source_key:billId,month:'2027-04',title:'클로브 카드대금 · ****9876',account_id:a1,plan_date:'2027-04-18',amount:450,memo:`${stored}\n합성 사용자 메모`,excluded:false,version:2,updated_at:'2027-04-01T00:00:00Z'};
const range={from:'2027-04-01',to:'2027-04-30'};

test('shared plan outputs sanitize dated and undated memos while editor identity stays raw',()=>{
 const before=JSON.stringify({data,edit});
 for(const planDate of ['2027-04-18',null]){
  const saved={...edit,plan_date:planDate};
  const model=buildEditableCashPlan(data,range,'2027-04-01',[saved]);
  assert.equal(model.items[0].memo,saved.memo,'replacement validation/editor save uses original stored metadata');
  const estimateMemo=planDate?model.estimates.businesses[0].dated[0].memo:model.estimates.businesses[0].undated[0].memo;
  const occurrenceMemo=planDate?model.plan.businesses[0].scheduledExpenses[0].memo:model.plan.businesses[0].undatedExpenses?.[0].memo;
  for(const memo of [estimateMemo,occurrenceMemo])assert.equal(memo,'클로브 카드 청구 반영 · 합성 사용자 메모');
  for(const basis of ['estimated','registered'] as const){
   const funding=buildAccountFunding(model.plan.businesses,new Map(model.estimates.businesses.map(item=>[item.business.id,item])),basis);
   assert.doesNotMatch(funding[0].accounts[0].items[0].note,/clobe-card-bill|대체 계획 키|synthetic-plan-key/);
   assert.match(funding[0].accounts[0].items[0].note,/클로브 카드 청구 반영.*합성 사용자 메모/);
  }
 }
 assert.equal(JSON.stringify({data,edit}),before);
});

test('saving user-only form text keeps bill refresh idempotent without reintroducing metadata into reports',()=>{
 const saved={...edit,memo:mergeCashPlanUserMemo(edit.memo,'수정한 사용자 메모'),version:3};
 const changes=buildClobeCardPlanChanges({data,edits:[saved],asOf:'2027-04-01',selections:[{companyId:'synthetic-company',businessId:b1,accountId:a1,replacementKeys:[],bill:{key:billId,maskedCard:'****9876',date:'2027-04-18',amount:450,kind:'REGULAR',itemCount:1,replaceable:true,reason:null}}]});
 assert.deepEqual(changes,[]);
 assert.equal(cashPlanMemoDisplay(saved.memo),'클로브 카드 청구 반영 · 수정한 사용자 메모');
});
