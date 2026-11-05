import test from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {classificationScopes,readClassificationReviewData,classificationResultFromRpc} from '../lib/finance/classification-data';
import {buildReviewGroups,prepareReviewChanges,type ReviewSelection} from '../lib/finance/classification-review';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const account='11111111-1111-4111-8111-111111111111',otherAccount='22222222-2222-4222-8222-222222222222';
const categories=[
 {id:'unknown',name:'미매핑',group_name:'정리필요',is_internal:false,is_operating:false},
 {id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},
 {id:'ads',name:'광고선전비',group_name:'영업지출',is_internal:false,is_operating:true},
];
function row(id:string,extra:Partial<Transaction>={}):Transaction{return {id,business_id:'business',account_id:account,upload_id:null,txn_date:'2026-09-18',amount:100,direction:'out',description:'ACME SUPPLIER',raw_gwamok:'',category_id:'unknown',is_internal:false,balance:1000,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra};}
function dataset(transactions:Transaction[]):Dataset{return {...emptyDataset,categories,transactions};}
function choose(source:Dataset,remember=false):ReviewSelection{
 const group=buildReviewGroups(source).find(group=>group.account_id===account&&group.direction==='out')!;
 return {key:group.key,category_id:'fee',remember,transactions:group.rows.map(({id,category_id,manually_classified})=>({id,category_id,manually_classified}))};
}
function mockDb(source:Dataset,error:string|null=null){
 const calls:{name:string;scopes:{account_id:string;direction:string}[]}[]=[];
 const db={rpc(name:string,{p_scopes}:{p_scopes:{account_id:string;direction:string}[]}){
  calls.push({name,scopes:p_scopes});
  return Promise.resolve({error:error?{message:error}:null,data:{categories:source.categories,rules:source.rules,aliases:source.aliases,transactions:source.transactions.filter(transaction=>p_scopes.some(scope=>transaction.account_id===scope.account_id&&transaction.direction===scope.direction))}});
 }} as unknown as Pick<SupabaseClient,'rpc'>;
 return {db,calls};
}

test('one context RPC carries unique scopes and replaces all paginated table reads',async()=>{
 const source=dataset([...Array.from({length:3000},(_,index)=>row(String(index))),row('in',{direction:'in'}),row('other',{account_id:otherAccount})]);
 const selection=choose(source),{db,calls}=mockDb(source),result=await readClassificationReviewData(db,[selection,selection]);
 assert.equal(result.transactions.length,3000);
 assert.deepEqual(calls,[{name:'fd_read_classification_context',scopes:[{account_id:account,direction:'out'}]}]);
 assert.deepEqual(prepareReviewChanges(result,[selection]),prepareReviewChanges(source,[selection]));
 assert.equal(result.notes.length,0);assert.equal(result.uploads.length,0);
});

test('complete scoped history still rejects omitted rows, conflicting history and stale or duplicate selections',async()=>{
 const source=dataset([row('01'),row('02'),row('03'),row('04',{category_id:'fee',manually_classified:true}),row('05',{category_id:'ads',manually_classified:true})]);
 const selection=choose(source),{db}=mockDb(source),result=await readClassificationReviewData(db,[selection]);
 assert.throws(()=>prepareReviewChanges(result,[{...selection,transactions:selection.transactions.slice(0,2)}]),/거래가 변경/);
 assert.throws(()=>prepareReviewChanges(result,[{...selection,remember:true}]),/자동 학습/);
 assert.throws(()=>prepareReviewChanges(result,[{...selection,transactions:selection.transactions.map(transaction=>({...transaction,manually_classified:true}))}]),/거래가 변경/);
 assert.throws(()=>prepareReviewChanges(result,[selection,selection]),/중복/);
 assert.throws(()=>prepareReviewChanges(result,[{...selection,category_id:'unknown'}]),/세부 계정과목/);
});

test('malformed scope fails before RPC and a forged scope cannot borrow another accounts transactions',async()=>{
 const source=dataset([row('01'),row('02',{account_id:otherAccount})]),selection=choose(source),{db,calls}=mockDb(source);
 await assert.rejects(()=>readClassificationReviewData(db,[{...selection,key:JSON.stringify(['invalid','out','exact:any'])}]),/묶음 형식/);
 assert.equal(calls.length,0);
 const forged={...selection,key:JSON.stringify([otherAccount,'out','exact:acme supplier'])};
 assert.throws(()=>prepareReviewChanges(source,[forged]),/거래가 변경/);
 assert.throws(()=>classificationScopes([{...selection,key:'not-json'}]),/묶음 형식/);
});

test('context authentication errors preserve API status markers without falling back to table reads',async()=>{
 const source=dataset([row('01')]),selection=choose(source);
 for(const message of ['UNAUTHORIZED','ADMIN_REQUIRED'])await assert.rejects(()=>readClassificationReviewData(mockDb(source,message).db,[selection]),error=>error instanceof Error&&error.message===message);
 await assert.rejects(()=>readClassificationReviewData(mockDb(source,'sensitive internal database details').db,[selection]),/분류할 거래를 확인하지 못/);
});

const patch={id:'01',category_id:'fee',is_internal:false,manually_classified:true};
const rule={id:'rule',pattern:'^ACME SUPPLIER$',field:'description',category_id:'fee',priority:1,is_internal:false,account_id:account,direction:'out'};
test('committed patches and only affected rules are accepted with no post-save database read',()=>{
 const value={updated:1,learned:1,transactions:[{...patch,unneeded:'removed'}],rulesDelta:[rule]};
 assert.deepEqual(classificationResultFromRpc(value,['01'],1),{updated:1,learned:1,transactions:[patch],rulesDelta:[rule]});
 assert.deepEqual(classificationResultFromRpc({updated:1,learned:0,transactions:[patch],rulesDelta:[]},['01'],0),{updated:1,learned:0,transactions:[patch],rulesDelta:[]});
});

test('legacy or malformed committed replies request refresh and never suggest repeating the write',()=>{
 const base={updated:1,learned:1,transactions:[patch],rulesDelta:[rule]};
 for(const value of [null,{updated:1,learned:1},{...base,transactions:[]},{...base,transactions:[{...patch,id:'other'}]},{...base,transactions:[patch,patch]},{...base,rulesDelta:[]},{...base,learned:2},{...base,transactions:[{...patch,manually_classified:false}]}]){
  assert.deepEqual(classificationResultFromRpc(value,['01'],1),{updated:1,learned:1,needsRefresh:true});
 }
});
