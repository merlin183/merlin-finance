import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,createClassifier,normalizeRows} from '../lib/finance/parser';
import type {Category,Rule} from '../lib/finance/types';

const categories:Category[]=[
 {id:'unknown',name:'미매핑',group_name:'검토',is_internal:false,is_operating:false},
 {id:'generic',name:'출금',group_name:'검토',is_internal:false,is_operating:false},
 {id:'fee',name:'수수료',group_name:'비용',is_internal:false,is_operating:true},
 {id:'salary',name:'급여',group_name:'비용',is_internal:false,is_operating:true},
 {id:'internal',name:'내부이체',group_name:'내부',is_internal:true,is_operating:false},
];
const rule=(patch:Partial<Rule>={}):Rule=>({id:'rule-a',pattern:'합성',field:'description',category_id:'fee',priority:5,is_internal:false,...patch});

test('batch classification keeps explicit categories and aliases ahead of description rules',()=>{
 const rules=[rule()],aliases=[{id:'alias',raw_name:'월급',standard_name:'급여'}],batch=createClassifier(categories,rules,aliases);
 assert.deepEqual(batch(' 월급 ','합성 지급'),{category_id:'salary',is_internal:false});
 assert.deepEqual(batch('내부이체','합성 지급'),{category_id:'internal',is_internal:true});
 assert.deepEqual(classify(' 월급 ','합성 지급',categories,rules,aliases),batch(' 월급 ','합성 지급'));
});

test('batch rules retain priority, ID tie order, account and direction restrictions',()=>{
 const rules=[rule({id:'z',category_id:'salary'}),rule({id:'a',account_id:'bank-a',direction:'out'}),rule({id:'later',priority:6,category_id:'internal'})];
 const original=JSON.stringify(rules),batch=createClassifier(categories,rules,[]);
 assert.equal(batch('','합성',{account_id:'bank-a',direction:'out'}).category_id,'fee');
 for(const context of [{account_id:'bank-b',direction:'out' as const},{account_id:'bank-a',direction:'in' as const},{}])assert.equal(batch('','합성',context).category_id,'salary');
 assert.equal(JSON.stringify(rules),original);
});

test('invalid and dangling rules do not stop later valid rules; normalized raw aliases remain matchable',()=>{
 const rules=[rule({id:'bad',priority:0,pattern:'(합성)+'}),rule({id:'missing',priority:1,category_id:'deleted'}),rule({id:'raw',priority:2,field:'raw_gwamok',pattern:'^원본정정$',category_id:'salary',is_internal:true})];
 const batch=createClassifier(categories,rules,[{id:'alias',raw_name:'오타',standard_name:'원본정정'}]);
 assert.deepEqual(batch('오타','합성'),{category_id:'salary',is_internal:true});
 assert.deepEqual(batch('','합성'),{category_id:'unknown',is_internal:false});
});

test('generic supplied categories and missing fallback keep their original behavior',()=>{
 const batch=createClassifier(categories,[rule()],[]);
 assert.deepEqual(batch('출금','해당 없음'),{category_id:'generic',is_internal:false});
 assert.deepEqual(batch('출금','합성'),{category_id:'fee',is_internal:false});
 assert.deepEqual(batch('미매핑','해당 없음'),{category_id:'unknown',is_internal:false});
 assert.deepEqual(createClassifier([],[],[])('',''),{category_id:null,is_internal:false});
});

test('batch classifier instances remain separate and repeated matching has no regex state',()=>{
 const first=createClassifier(categories,[rule({pattern:'^합성$'})],[]);
 const second=createClassifier(categories,[rule({pattern:'^합성$',category_id:'salary'})],[]);
 for(let i=0;i<5;i++){
  assert.equal(first('','합성').category_id,'fee');assert.equal(second('','합성').category_id,'salary');
 }
 assert.equal(first('','x'.repeat(1000)+'합성').category_id,'unknown');
});

test('a parsed batch applies per-row direction while preserving manual flags and source categories',()=>{
 const rules=[rule({account_id:'bank-a',direction:'out'}),rule({id:'incoming',account_id:'bank-a',direction:'in',category_id:'salary'})];
 const result=normalizeRows([['날짜','입금','출금','적요','과목'],['2026-01-02',0,100,'합성',''],['2026-01-02',100,0,'합성',''],['2026-01-03',0,200,'합성','내부이체']],{date:0,income:1,expense:2,description:3,category:4},categories,rules,[],{headerRow:0,accountId:'bank-a'});
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(result.parsed.map(row=>[row.category_id,row.manually_classified,row.raw_gwamok]),[['fee',false,''],['salary',false,''],['internal',false,'내부이체']]);
});
