import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRows,type Mapping} from '../lib/finance/parser';
import type {Category} from '../lib/finance/types';

const mapping:Mapping={date:0,income:1,expense:2,description:3,category:4};
const headers=['거래일자','입금','출금','기본내역','과목','비고'];
const categories:Category[]=[{id:'travel',name:'여비교통비',group_name:'비용',is_operating:true,is_internal:false,is_fixed:false}];
const parse=(rows:unknown[][])=>parseRows([headers,...rows],mapping,'synthetic-bank',categories,[],[],{headerRow:0});

test('a split-column negative expense becomes incoming cash without deleting the original charge',async()=>{
 const result=await parse([
  ['2026-01-02',0,1250,'가상 가승인','여비교통비','기존 원본 비고'],
  ['2026-01-02',0,-1250,'가상 가승인','여비교통비','기존 원본 비고'],
  ['2026-01-02',0,1300,'가상 실제 결제','여비교통비',''],
 ]);
 assert.deepEqual(result.errors,[]);
 assert.equal(result.parsed.length,3);
 assert.deepEqual(result.parsed.map(row=>[row.direction,row.amount]),[['out',1250],['in',1250],['out',1300]]);
 assert.equal(result.parsed.reduce((total,row)=>total+(row.direction==='in'?row.amount:-row.amount),0),-1300);
 assert.equal(result.parsed[1].category_id,'travel');assert.equal(result.parsed[1].raw_gwamok,'여비교통비');
 assert.equal(result.parsed[1].source_details?.basic,'가상 가승인');
 assert.equal(result.parsed[1].source_details?.note,'기존 원본 비고 · 원본 출금 -1250원: 음수 출금을 입금으로 반영');
 assert.notEqual(result.parsed[0].dedup_hash,result.parsed[1].dedup_hash);
});

test('a negative income preserves source cash effect and category as outgoing cash',async()=>{
 const result=await parse([['2026-01-02',-3500,'','가상 입금 정정','여비교통비','']]);
 assert.deepEqual(result.errors,[]);
 assert.equal(result.parsed[0].direction,'out');assert.equal(result.parsed[0].amount,3500);
 assert.equal(result.parsed[0].source_details?.note,'원본 입금 -3500원: 음수 입금을 출금으로 반영');
});

test('two populated split amount columns remain ambiguous regardless of signs',async()=>{
 const result=await parse([[10,20],[10,-20],[-10,20],[-10,-20]].map(([income,expense])=>['2026-01-02',income,expense,'가상 거래','여비교통비','']));
 assert.equal(result.parsed.length,0);assert.equal(result.errors.length,4);
 assert.ok(result.errors.every(error=>error.message.includes('입금과 출금이 모두')));
});

test('recording a reversal never silently truncates the original note',async()=>{
 const result=await parse([['2026-01-02',0,-1250,'가상 거래','여비교통비','x'.repeat(990)]]);
 assert.equal(result.parsed.length,0);assert.equal(result.errors.length,1);
 assert.match(result.errors[0].message,/원본 비고가 너무/);
});
