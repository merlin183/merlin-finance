import assert from 'node:assert/strict';
import test from 'node:test';
import {createDatasetUpdates,mergeClassificationResult} from '../lib/finance/dataset-updates';
import {emptyDataset,type Transaction} from '../lib/finance/types';
import type {ClassificationResult} from '../lib/finance/classification-result';

const transaction:Transaction={id:'one',business_id:'business',account_id:'account',upload_id:null,txn_date:'2026-09-01',amount:100,direction:'out',description:'Synthetic',raw_gwamok:'',category_id:null,is_internal:false,balance:900,tax_invoice:false,dedup_hash:'synthetic',manually_classified:false};
const initial={...emptyDataset,transactions:[transaction,{...transaction,id:'two'}]};
const result:ClassificationResult={updated:1,learned:0,transactions:[{id:'one',category_id:'fee',is_internal:false,manually_classified:true}]};

test('일반 과목 변경 응답은 DB 트리거와 동일하게 이전 수수료 배분을 제거한다',()=>{
 const allocated={...transaction,category_id:'transfer',is_internal:true,manually_classified:true,transfer_fee_amount:5,transfer_fee_category_id:'fee'};
 const current={...initial,transactions:[allocated]};
 const changed=mergeClassificationResult(current,result).transactions[0];
 assert.equal(changed.transfer_fee_amount,0);assert.equal(changed.transfer_fee_category_id,null);
 assert.equal(changed.amount,transaction.amount);assert.equal(changed.balance,transaction.balance);
 const unchanged=mergeClassificationResult(current,{...result,transactions:[{id:'one',category_id:'transfer',is_internal:true,manually_classified:true}]}).transactions[0];
 assert.equal(unchanged.transfer_fee_amount,5);assert.equal(unchanged.transfer_fee_category_id,'fee');
});

test('분류 응답은 확인된 분류 필드만 반영하고 원본·금액·다른 거래를 보존한다',()=>{
 const changed=mergeClassificationResult(initial,result);
 assert.deepEqual(changed.transactions[0],{...transaction,category_id:'fee',manually_classified:true});
 assert.equal(changed.transactions[1],initial.transactions[1]);
 assert.equal(changed.rules,initial.rules);
 assert.equal(initial.transactions[0].category_id,null);
 assert.equal(mergeClassificationResult(initial,{...result,transactions:[{...result.transactions![0],id:'missing'}]}).transactions.length,2);
 const rules=[{id:'rule',pattern:'Synthetic',field:'description',category_id:'fee',priority:100,is_internal:false}];
 assert.equal(mergeClassificationResult(initial,{...result,rules}).rules,rules);
});

test('저장보다 늦게 도착한 이전 조회가 확인된 변경을 덮어쓰지 않는다',()=>{
 const updates=createDatasetUpdates(),read=updates.beginRead();
 updates.record(data=>mergeClassificationResult(data,result));
 assert.equal(read.apply(initial).transactions[0].category_id,'fee');
 read.finish();
 const laterRead=updates.beginRead();
 assert.equal(laterRead.apply(initial).transactions[0].category_id,null);
 laterRead.finish();
});

test('같은 조회 도중 여러 분류 결과는 저장 응답 순서대로 유지된다',()=>{
 const updates=createDatasetUpdates(),oldRead=updates.beginRead();
 updates.record(data=>mergeClassificationResult(data,result));
 const next={...result,transactions:[{...result.transactions![0],category_id:'ads'}]};
 updates.record(data=>mergeClassificationResult(data,next));
 assert.equal(oldRead.apply(initial).transactions[0].category_id,'ads');
 const newRead=updates.beginRead();oldRead.finish();
 updates.record(data=>mergeClassificationResult(data,result));
 assert.equal(newRead.apply(initial).transactions[0].category_id,'fee');
});

test('동시에 저장한 서로 다른 규칙은 응답 순서와 관계없이 함께 남는다',()=>{
 const ruleA={id:'rule-a',pattern:'Synthetic A',field:'description',category_id:'fee',priority:1,is_internal:false};
 const ruleB={...ruleA,id:'rule-b',pattern:'Synthetic B'};
 const older={...ruleA,priority:10};
 const base={...initial,rules:[older]};
 const a={...result,rulesDelta:[ruleA]},b={...result,rulesDelta:[ruleB]};
 for(const changes of [[a,b],[b,a]]){
  const merged=changes.reduce(mergeClassificationResult,base);
  assert.equal(merged.rules.length,2);
  assert.deepEqual(merged.rules.find(rule=>rule.id===ruleA.id),ruleA);
  assert.deepEqual(merged.rules.find(rule=>rule.id===ruleB.id),ruleB);
 }
});
