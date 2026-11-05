import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {read,utils} from '@e965/xlsx';
import {parseRows} from '../lib/finance/parser';
import type {Category} from '../lib/finance/types';

test('published synthetic CSV imports with its documented categories, totals and balance',async()=>{
 const bytes=readFileSync(new URL('../examples/demo-bank.csv',import.meta.url));
 const book=read(bytes,{type:'buffer',cellDates:false});
 const rows=utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]],{header:1,defval:''});
 const categories:Category[]=['매출','급여','지급수수료','미매핑'].map((name,index)=>({id:`synthetic-category-${index}`,name,group_name:name==='매출'?'영업수입':'영업지출',is_operating:true,is_internal:false}));
 const result=await parseRows(rows,{date:0,description:1,income:2,expense:3,balance:4,category:5},'00000000-0000-4000-8000-000000000001',categories,[],[],{headerRow:0});
 assert.deepEqual(result.errors,[]);
 assert.equal(result.parsed.length,4);
 assert.equal(result.parsed.filter(row=>row.direction==='in').reduce((total,row)=>total+row.amount,0),1_000_000);
 assert.equal(result.parsed.filter(row=>row.direction==='out').reduce((total,row)=>total+row.amount,0),360_000);
 assert.equal(result.parsed.at(-1)?.balance,640_000);
 assert.deepEqual(result.parsed.map(row=>row.category_id),['synthetic-category-0','synthetic-category-2','synthetic-category-1','synthetic-category-2']);
 assert.equal(new Set(result.parsed.map(row=>row.dedup_hash)).size,4);
});
