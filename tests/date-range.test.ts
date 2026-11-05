import test from 'node:test';
import assert from 'node:assert/strict';
import {dateRangeBounds,dateRangePreset,filterTransactionsByRange,formatFinanceDate,isValidDateRange,parseFinanceDate,resolveDateRange} from '../lib/finance/date-range';
import {spendingMatrix,fixedCostPlans} from '../lib/finance/spending';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

test('달력 날짜는 지역 시간대로 왕복하며 잘못된 날짜를 보정해 받아들이지 않는다',()=>{
 for(const day of ['2024-02-29','2026-01-01','2026-09-30','2026-12-31'])assert.equal(formatFinanceDate(parseFinanceDate(day)!),day);
 for(const day of ['','2026-02-29','2026-04-31','2026-00-01','2026-13-01','2026-01-00','2026-9-01','09/01/2026','2026-09-01T00:00:00Z'])assert.equal(parseFinanceDate(day),undefined);
 assert.equal(formatFinanceDate(new Date('invalid')),'');
});

test('하루 조회를 허용하고 빈 날짜와 역순 기간은 조회하지 않는다',()=>{
 assert.equal(isValidDateRange({from:'2026-09-15',to:'2026-09-15'}),true);
 for(const range of [{from:'',to:'2026-09-15'},{from:'2026-09-15',to:''},{from:'2026-09-16',to:'2026-09-15'}]){
  assert.equal(isValidDateRange(range),false);assert.deepEqual(filterTransactionsByRange([{txn_date:'2026-09-15'}],range),[]);
 }
});

test('양 끝 날짜를 포함하며 기간 밖 거래는 제외하고 원본을 변경하지 않는다',()=>{
 const rows=Object.freeze(['2026-08-31','2026-09-01','2026-09-15','2026-09-30','2026-10-01'].map(txn_date=>Object.freeze({txn_date})));
 assert.deepEqual(filterTransactionsByRange(rows,{from:'2026-09-01',to:'2026-09-30'}).map(t=>t.txn_date),['2026-09-01','2026-09-15','2026-09-30']);
 assert.deepEqual(filterTransactionsByRange(rows,{from:'2026-09-15',to:'2026-09-15'}),[rows[2]]);assert.equal(rows.length,5);
});

test('전체 기간은 실제 첫 거래와 마지막 거래를 포함하고 빈 자료는 기준일을 사용한다',()=>{
 const bounds=dateRangeBounds([{txn_date:'2023-01-02'},{txn_date:'invalid'},{txn_date:'2027-01-05'},{txn_date:'2026-01-01'}],'2026-09-22');
 assert.deepEqual(bounds,{from:'2023-01-02',to:'2027-01-05'});
 assert.deepEqual(dateRangePreset('all','2026-09-22',bounds),bounds);
 assert.deepEqual(dateRangeBounds([],'2026-09-22'),{from:'2026-09-22',to:'2026-09-22'});
});

test('빠른 기간은 연도 변경·윤년·분기 경계를 정확히 계산한다',()=>{
 assert.deepEqual(dateRangePreset('last-month','2026-01-15'),{from:'2025-12-01',to:'2025-12-31'});
 assert.deepEqual(dateRangePreset('last-month','2024-03-15'),{from:'2024-02-01',to:'2024-02-29'});
 assert.deepEqual(dateRangePreset('quarter','2026-04-01'),{from:'2026-04-01',to:'2026-04-01'});
 assert.deepEqual(dateRangePreset('quarter','2026-09-22'),{from:'2026-07-01',to:'2026-09-22'});
 assert.deepEqual(dateRangePreset('month','2026-09-22'),{from:'2026-09-01',to:'2026-09-22'});
 assert.deepEqual(dateRangePreset('year','2026-09-22'),{from:'2026-01-01',to:'2026-09-22'});
});

test('부문별 기간은 전체 기간 밖도 조회하고 전체 기간 변경과 초기화를 구분한다',()=>{
 const overall={from:'2026-09-01',to:'2026-09-22'},local={from:'2026-01-01',to:'2026-01-31'};
 const source=[{txn_date:'2026-01-15'},{txn_date:'2026-09-15'}];
 assert.deepEqual(filterTransactionsByRange(source,resolveDateRange(overall,local)),[source[0]]);
 const nextOverall={from:'2026-07-01',to:'2026-07-31'};
 assert.deepEqual(resolveDateRange(nextOverall,local),local);
 assert.deepEqual(resolveDateRange(nextOverall),nextOverall);
 assert.deepEqual(resolveDateRange(overall,{from:'',to:''}),overall);
});

test('독립 기간의 과목 합계·고정비·반복 계획은 같은 기간의 실제 거래와 일치한다',()=>{
 const business={id:'b1',name:'테스트 사업자',representative:'',kind:'법인',reserve:0,color:'#fff'};
 const transaction=(id:string,date:string,amount:number):Transaction=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:date,amount,direction:'out',description:'테스트',raw_gwamok:'',category_id:'fixed',is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false});
 const data:Dataset={...emptyDataset,businesses:[business],categories:[{id:'fixed',name:'임차료',group_name:'영업지출',is_operating:true,is_internal:false,is_fixed:true}],transactions:[transaction('jan','2026-01-31',100),transaction('feb','2026-02-28',250)],recurring:[{id:'plan',business_id:'b1',title:'테스트 임차료',amount:100,direction:'out',frequency:'monthly',day:31,start_date:'2026-01-01',end_date:null}]};
 const january={from:'2026-01-01',to:'2026-01-31'},february={from:'2026-02-01',to:'2026-02-28'};
 const subjects=spendingMatrix(data,filterTransactionsByRange(data.transactions,january),data.businesses,'out');
 const fixed=spendingMatrix(data,filterTransactionsByRange(data.transactions,february),data.businesses,'out');
 assert.equal(subjects.total,100);assert.equal(fixed.fixed.b1,250);
 assert.deepEqual(fixed.rows[0].cells.b1.rows.map(t=>t.id),['feb']);
 assert.equal(fixedCostPlans(data,data.businesses,january.from,january.to)[0].periodAmount,100);
 assert.deepEqual(fixedCostPlans(data,data.businesses,february.from,february.to)[0].dates,['2026-02-28']);
});
