import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeFinanceCatalog} from '../lib/finance/setup';
import {cashPlanEstimateOptions} from '../lib/finance/cash-plan-policy';
import {emptyDataset} from '../lib/finance/types';
import {installationPolicy} from '../lib/finance/installation-policy';

type Row=Record<string,unknown>;
function catalogFixture(failTable=''){
 const tables=new Map<string,Row[]>([['fd_categories',[{id:'custom-payroll',name:'급여',owner_id:'synthetic-owner',group_name:'사용자 과목',is_operating:false,is_internal:false}]]]);
 const calls:string[]=[];
 const db={from(table:string){
  calls.push(table);
  return {
   async upsert(rows:readonly Row[],options:{onConflict:string;ignoreDuplicates:boolean}){
    assert.equal(options.ignoreDuplicates,true);
    if(table===failTable)return {error:{message:'Synthetic storage failure'}};
    const saved=tables.get(table)??[];
    for(const row of rows){
     assert.equal(row.owner_id,'synthetic-owner');
     if(!saved.some(existing=>options.onConflict.split(',').every(key=>existing[key]===row[key])))saved.push({...row,id:`synthetic-${table}-${saved.length}`});
    }
    tables.set(table,saved);return {error:null};
   },
   async select(){return {data:tables.get(table)??[],error:null};},
   async insert(row:Row){tables.set(table,[...(tables.get(table)??[]),row]);return {error:null};},
  };
 }} as unknown as Parameters<typeof initializeFinanceCatalog>[0];
 return {db,tables,calls};
}

test('blank installation prepares the catalog without creating businesses, accounts or financial rows',async()=>{
 const fixture=catalogFixture();
 assert.deepEqual(await initializeFinanceCatalog(fixture.db,'synthetic-owner'),{ok:true});
 const allowed=new Set(['fd_categories','fd_gwamok_aliases','fd_category_rules','fd_audit_log']);
 assert.ok(fixture.calls.every(table=>allowed.has(table)));
 const count=[...fixture.tables].filter(([table])=>table!=='fd_audit_log').map(([table,rows])=>[table,rows.length]);
 await initializeFinanceCatalog(fixture.db,'synthetic-owner');
 assert.deepEqual([...fixture.tables].filter(([table])=>table!=='fd_audit_log').map(([table,rows])=>[table,rows.length]),count);
 assert.equal(fixture.tables.get('fd_categories')?.find(row=>row.name==='급여')?.group_name,'사용자 과목');
 assert.ok(fixture.tables.get('fd_category_rules')?.some(row=>row.category_id==='custom-payroll'));
});

test('catalog write failure is reported and later tables are not written',async()=>{
 const fixture=catalogFixture('fd_gwamok_aliases');
 await assert.rejects(initializeFinanceCatalog(fixture.db,'synthetic-owner'),/저장하지 못했습니다/);
 assert.ok(!fixture.calls.includes('fd_category_rules'));
 assert.ok(!fixture.calls.includes('fd_audit_log'));
});

test('blank policy leaves estimates intact and explicit exclusion remains scoped to one category and business',()=>{
 assert.equal(installationPolicy.historicalCompletionBefore,null);
 assert.deepEqual(installationPolicy.benchmarkIndustries,[]);
 const data={...emptyDataset,businesses:[{id:'business-a',name:'예시회사 A',representative:'',kind:'법인',reserve:0,color:'#123456'},{id:'business-b',name:'예시회사 B',representative:'',kind:'법인',reserve:0,color:'#123456'}],categories:[{id:'salary',name:'급여',group_name:'영업지출',is_operating:true,is_internal:false},{id:'rent',name:'임차료',group_name:'영업지출',is_operating:true,is_internal:false}]};
 const original=JSON.stringify(data);
 assert.deepEqual(cashPlanEstimateOptions(data),{excludedBusinessCategories:[]});
 assert.deepEqual(cashPlanEstimateOptions(data,[{businessName:'예시회사 A',categoryName:'급여'}]),{excludedBusinessCategories:[{businessId:'business-a',categoryId:'salary'}]});
 assert.equal(JSON.stringify(data),original);
});
