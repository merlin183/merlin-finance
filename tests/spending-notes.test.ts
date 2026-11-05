import test from 'node:test';
import assert from 'node:assert/strict';
import {spendingMatrix,fixedCostPlans} from '../lib/finance/spending';
import {noteKey,noteSubject} from '../lib/finance/merchant-notes';
import {compareCategories,categorySection} from '../lib/finance/category-order';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
const business=(id:string)=>({id,name:id,representative:'',kind:'법인',reserve:0,color:'#fff'});
const tx=(id:string,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:'2026-02-01',amount:100,direction:'out',description:'OPENAI *SERVICE',raw_gwamok:'',category_id:'fixed',is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const data:Dataset={...emptyDataset,businesses:[business('b1'),business('b2'),business('b3')],categories:[{id:'fixed',name:'구독료',group_name:'영업지출',is_operating:true,is_internal:false,is_fixed:true},{id:'internal',name:'내부대체',group_name:'내부',is_operating:false,is_internal:true,is_fixed:false}],transactions:[tx('1'),tx('2',{business_id:'b2',amount:300}),tx('3',{amount:50,category_id:null}),tx('4',{amount:500,is_internal:true}),tx('5',{amount:70,direction:'in'}),tx('6',{amount:10,category_id:'internal'})]};
test('미매핑은 첫 행에 두고 관련 계정과목은 같은 구역에 모은다',()=>{
 const categories=[{name:'보험료',group_name:'영업지출'},{name:'급여',group_name:'영업지출'},{name:'미매핑',group_name:'정리필요'},{name:'복리후생비',group_name:'영업지출'},{name:'광고선전비',group_name:'영업지출'}].sort(compareCategories);
 assert.deepEqual(categories.map(c=>c.name),['미매핑','급여','복리후생비','광고선전비','보험료']);
 assert.equal(categorySection(categories[1]),categorySection(categories[2]));
 assert.equal(spendingMatrix(data,data.transactions,data.businesses,'out').rows[0].name,'미매핑');
});
test('사업자별 과목 합계는 외부 출금과 같고 미분류를 보존한다',()=>{
 const result=spendingMatrix(data,data.transactions,data.businesses,'out');
 assert.equal(result.total,450);assert.deepEqual(result.totals,{b1:150,b2:300,b3:0});
 assert.equal(result.rows.reduce((s,r)=>s+r.total,0),450);assert.equal(result.rows.find(r=>r.name==='미매핑')?.total,50);
 const cell=result.rows.find(r=>r.id==='fixed')!.cells.b2;assert.equal(cell.amount,cell.rows.reduce((s,t)=>s+t.amount,0));assert.deepEqual(cell.rows.map(t=>t.id),['2']);
});
test('고정비는 지정 과목의 실제 외부 출금이며 입금 환불·내부이체와 섞지 않는다',()=>{
 assert.deepEqual(spendingMatrix(data,data.transactions,data.businesses,'out').fixed,{b1:100,b2:300,b3:0});
 assert.equal(spendingMatrix(data,data.transactions,data.businesses,'in').total,70);
 assert.equal(spendingMatrix({...data,categories:data.categories.map(c=>({...c,is_fixed:false}))},data.transactions,data.businesses,'out').fixed.b1,0);
 assert.equal(spendingMatrix(data,data.transactions,[business('b2')],'out').total,300);
});
test('반복 계획의 31일·시작·종료를 반영하고 실제 사용액과 합산하지 않는다',()=>{
 const recurring={id:'r',business_id:'b1',title:'임대료',amount:1000,direction:'out' as const,day:31,start_date:'2026-02-01',end_date:'2026-02-28',frequency:'monthly' as const};
 const plans=fixedCostPlans({...data,recurring:[recurring,{...recurring,id:'future',start_date:'2026-04-01',end_date:null}]},data.businesses,'2026-02-01','2026-02-28');
 const rent=plans.find(r=>r.id==='r')!;assert.deepEqual(rent.dates,['2026-02-28']);assert.equal(rent.periodAmount,1000);assert.equal(rent.nextAmount,0);assert.equal(plans.find(r=>r.id==='future')?.periodAmount,0);
});
test('거래처 메모는 표기 변형과 분류 이후에도 유지하되 모호한 거래·계좌·방향은 분리한다',()=>{
 const original=tx('1'),variant=tx('2',{description:'OPENAI CHATGPT',category_id:'other',manually_classified:true});
 assert.equal(noteKey(noteSubject(original)),noteKey(noteSubject(variant)));
 assert.notEqual(noteKey(noteSubject(original)),noteKey(noteSubject(tx('3',{account_id:'other'}))));
 assert.notEqual(noteKey(noteSubject(original)),noteKey(noteSubject(tx('3',{direction:'in'}))));
 assert.notEqual(noteKey(noteSubject(tx('1',{description:'김민수'}))),noteKey(noteSubject(tx('2',{description:'김민수'}))));
 assert.notEqual(noteKey(noteSubject(tx('1',{description:'BZ뱅크'}))),noteKey(noteSubject(tx('2',{description:'BZ뱅크'}))));
});
