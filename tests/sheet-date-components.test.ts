import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRows,type Mapping} from '../lib/finance/parser';
import {normalizeExcelDate,readTransactions,sheetRows} from '../lib/finance/workbook';
import {utils,write} from '@e965/xlsx';

const mapping:Mapping={year:0,month:1,day:2,expense:3};
const parse=(data:unknown[][])=>normalizeRows([['연도','월','일','출금'],...data],mapping,[],[],[],{headerRow:0});

test('date-formatted split year/month/day values use UTC components and preserve actual transaction time',()=>{
 const date=new Date('2023-01-02T15:12:47Z');
 const result=parse([[date,date,date,100],[new Date('2023-08-05T00:00:00Z'),8,4,200]]);
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(result.parsed.map(r=>[r.txn_date,r.txn_time]),[['2023-01-02','15:12:47'],['2023-08-04',null]]);
});

test('small date-formatted month/day numbers retain the explicit business year and month',()=>{
 const result=parse([[2023,new Date('1900-01-12T00:00:00Z'),new Date('1900-01-29T00:00:00Z'),100],[2023,1,new Date('1900-01-02T00:00:00Z'),200],[2024,2,new Date('1900-01-29T00:00:00Z'),300]]);
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(result.parsed.map(r=>[r.txn_date,r.txn_time]),[['2023-12-29',null],['2023-01-02',null],['2024-02-29',null]]);
});

test('a complete date in the day column stands alone, advances carry context, and rejects explicit contradictions',()=>{
 const result=parse([[2023,12,31,100],['','',new Date('2024-01-02T11:00:00Z'),200],['','',3,300],[2023,1,new Date('2024-01-04T11:00:00Z'),400],[2024,2,new Date('2024-01-04T11:00:00Z'),500]]);
 assert.deepEqual(result.parsed.map(r=>r.txn_date),['2023-12-31','2024-01-02','2024-01-03']);
 assert.equal(result.errors.length,2);
 assert.ok(result.errors.every(e=>e.message.includes('일치하지 않습니다')));
});

test('invalid component serials, leap days and corrupt year/month cells remain errors rather than invented dates',()=>{
 const result=parse([
  [2023,2,new Date('1900-01-29T00:00:00Z'),100],
  [2024,1,new Date('1900-02-01T00:00:00Z'),100],
  [2024,new Date('1900-01-13T00:00:00Z'),1,100],
  [2024,1,new Date('1900-01-02T12:00:00Z'),100],
  [2024,1,1,100],
  ['잘못된 연도',2,1,100],
  ['','',2,100],
  [2024,2,new Date('invalid'),100],
 ]);
 assert.deepEqual(result.parsed.map(r=>r.txn_date),['2024-01-01']);
 assert.equal(result.errors.length,7);
});

test('explicit time column takes precedence over a full date in the day column',()=>{
 const rows=[['연도','월','일','출금','거래시간'],[2023,1,new Date('2023-01-02T15:12:47Z'),100,'16:01:02']];
 const result=normalizeRows(rows,{...mapping,time:4},[],[],[],{headerRow:0});
 assert.equal(result.parsed[0]?.txn_time,'16:01:02');
});

test('Excel dates correct only the one-millisecond boundary error and retain real fractional seconds',()=>{
 assert.equal(normalizeExcelDate(new Date('2023-01-18T14:49:06.999Z')).toISOString(),'2023-01-18T14:49:07.000Z');
 assert.equal(normalizeExcelDate(new Date('2023-01-18T14:49:07.001Z')).toISOString(),'2023-01-18T14:49:07.000Z');
 for(const fraction of ['002','125','500','998']){
  const date=new Date(`2023-01-18T14:49:06.${fraction}Z`);
  assert.equal(normalizeExcelDate(date).getTime(),date.getTime());
 }
});

test('boundary correction rolls midnight safely and preserves 1900 component serials',()=>{
 assert.equal(normalizeExcelDate(new Date('2025-12-31T23:59:59.999Z')).toISOString(),'2026-01-01T00:00:00.000Z');
 assert.equal(normalizeExcelDate(new Date('2024-02-28T23:59:59.999Z')).toISOString(),'2024-02-29T00:00:00.000Z');
 const result=parse([[2023,1,normalizeExcelDate(new Date('1900-01-02T00:00:00.001Z')),100]]);
 assert.deepEqual(result.errors,[]);assert.equal(result.parsed[0].txn_date,'2023-01-02');assert.equal(result.parsed[0].txn_time,null);
});

test('workbook decoding separates consecutive serial seconds before parsing and snapshot hashing',()=>{
 const serials=[44944.617430555554,44944.617442129631];
 const wb=utils.book_new(),sheet=utils.aoa_to_sheet([['연도','월','일','출금'],...serials.map(serial=>[serial,serial,serial,100])]);
 for(const row of [2,3])for(const [column,format] of [['A','yyyy'],['B','m'],['C','d']])sheet[`${column}${row}`].z=format;
 utils.book_append_sheet(wb,sheet,'은행');
 const decoded=readTransactions(write(wb,{type:'array',bookType:'xlsx'}));
 const rows=sheetRows(decoded,'은행');
 assert.deepEqual([rows[1][2],rows[2][2]].map(value=>(value as Date).toISOString()),['2023-01-18T14:49:06.000Z','2023-01-18T14:49:07.000Z']);
 const parsed=normalizeRows(rows,mapping,[],[],[],{headerRow:0});
 assert.deepEqual(parsed.errors,[]);assert.deepEqual(parsed.parsed.map(row=>row.txn_time),['14:49:06','14:49:07']);
});

function decodeDay(value:Date,format:string,year:unknown=2026,month:unknown=5){
 const serial=(value.getTime()-Date.UTC(1899,11,30))/86400000;
 const wb=utils.book_new(),sheet=utils.aoa_to_sheet([['연도','월','일','출금'],[year,month,serial,100]]);
 sheet.C2.z=format;utils.book_append_sheet(wb,sheet,'합성은행');
 return sheetRows(readTransactions(write(wb,{type:'array',bookType:'xlsx'})),'합성은행');
}

test('a day-only midnight cell follows its displayed day and explicit year/month, not its hidden month',()=>{
 const rows=decodeDay(new Date('2026-04-30T00:00:00Z'),'dd');
 assert.equal(rows[1][2],30);
 const result=normalizeRows(rows,mapping,[],[],[],{headerRow:0});
 assert.deepEqual(result.errors,[]);assert.equal(result.parsed[0].txn_date,'2026-05-30');assert.equal(result.parsed[0].txn_time,null);
});

test('a visible full date or non-midnight timestamp still rejects an explicit year/month contradiction',()=>{
 for(const [value,format] of [[new Date('2026-04-30T00:00:00Z'),'yyyy-mm-dd'],[new Date('2026-04-30T09:10:11Z'),'dd']] as const){
  const result=normalizeRows(decodeDay(value,format),mapping,[],[],[],{headerRow:0});
  assert.equal(result.parsed.length,0);assert.match(result.errors[0].message,/일치하지 않습니다/);
 }
});

test('day-only recovery does not infer a missing year/month or accept an impossible calendar day',()=>{
 const missing=decodeDay(new Date('2026-04-30T00:00:00Z'),'dd','',5);
 assert.ok(missing[1][2] instanceof Date);
 assert.equal(normalizeRows(missing,mapping,[],[],[],{headerRow:0}).errors.length,1);
 const invalid=normalizeRows(decodeDay(new Date('2026-01-31T00:00:00Z'),'d',2026,2),mapping,[],[],[],{headerRow:0});
 assert.equal(invalid.parsed.length,0);assert.match(invalid.errors[0].message,/존재하지 않는 날짜/);
});
