import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewGroups,prepareReviewChanges,exactDescriptionPattern} from '../lib/finance/classification-review';
import {classify} from '../lib/finance/parser';
import {emptyDataset,type Dataset,type Transaction,type Rule} from '../lib/finance/types';

const categories=[
 {id:'unknown',name:'미매핑',group_name:'정리필요',is_internal:false,is_operating:false},
 {id:'generic',name:'출금',group_name:'정리필요',is_internal:false,is_operating:false},
 {id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},
 {id:'ads',name:'광고선전비',group_name:'영업지출',is_internal:false,is_operating:true},
];
function row(id:string,extra:Partial<Transaction>={}):Transaction{return {id,business_id:'business-a',account_id:'account-a',upload_id:null,txn_date:'2026-09-18',amount:100,direction:'out',description:'ANTHROPIC              SAN FRANCISCO USA',raw_gwamok:'',category_id:'generic',is_internal:false,balance:1000,tax_invoice:false,dedup_hash:id,manually_classified:true,...extra};}
function data(transactions:Transaction[],rules:Rule[]=[]):Dataset{return {...emptyDataset,categories,transactions,rules};}
const history=[row('h1',{category_id:'fee'}),row('h2',{category_id:'fee'})];
const select=(g:ReturnType<typeof buildReviewGroups>[number],category_id='fee',remember=true)=>({key:g.key,category_id,remember:remember&&g.canLearn,transactions:g.rows.map(({id,category_id,manually_classified})=>({id,category_id,manually_classified}))});

test('528건 전체와 원장 일반 출금도 한 묶음으로 정리하며 구체 과목은 보호',()=>{
 const source=data([...history,...Array.from({length:528},(_,i)=>row(String(i))),row('other-account',{account_id:'other'}),row('incoming',{direction:'in'})]);
 const g=buildReviewGroups(source).find(g=>g.rows.length===528)!;
 assert.equal(g.suggestedCategoryId,'fee');assert.equal(g.historyCount,2);
 const result=prepareReviewChanges(source,[select(g)]);
 assert.equal(result.changes.length,528);assert.equal(result.rules.length,1);
 assert.ok(result.changes.every(c=>!['h1','h2','other-account','incoming'].includes(c.id)));
});
test('대소문자·공백·동일 공급자 표기는 묶고 숫자·참조번호는 유지',()=>{
 const source=data([row('1',{description:'OPENAI SAN FRANCISCO USA'}),row('2',{description:'openai *CHATGPT SUBSCR USA'}),row('3',{description:'Invoice 123'}),row('4',{description:'Invoice 456'})]);
 assert.deepEqual(buildReviewGroups(source).map(g=>g.rows.length).sort(),[1,1,2]);
});
test('충돌 이력과 은행 경로·이름에는 추천·자동 학습이 없다',()=>{
 const source=data([row('h1',{category_id:'fee',description:'SOLAPI LIMITED HKG'}),row('h2',{category_id:'ads',description:'SOLAPI LIMITED HKG'}),row('target',{description:'SOLAPI LIMITED HKG'}),row('channel1',{description:'BZ뱅크'}),row('channel2',{description:'BZ뱅크'}),row('person',{description:'김가상'})]);
 const groups=buildReviewGroups(source);assert.equal(groups.length,4);
 assert.ok(groups.every(g=>!g.suggestedCategoryId&&!g.canLearn));
 assert.throws(()=>prepareReviewChanges(source,[{...select(groups[0]),remember:true}]));
});
test('모호한 이름도 이미 등록한 계좌·방향·전체 일치 규칙이면 개별 추천하되 새로 학습하지 않는다',()=>{
 const rule:Rule={id:'scoped-person',pattern:'^김가상$',field:'description',category_id:'fee',priority:5,is_internal:false,account_id:'account-a',direction:'out'};
 const source=data([row('person-1',{description:'김가상'}),row('person-2',{description:'김가상'}),row('other-account',{description:'김가상',account_id:'other'}),row('incoming',{description:'김가상',direction:'in'})],[rule]);
 const groups=buildReviewGroups(source);
 assert.equal(groups.length,4);
 for(const group of groups){
  assert.equal(group.rows.length,1);assert.equal(group.ambiguous,true);assert.equal(group.canLearn,false);assert.deepEqual(group.patterns,[]);
  assert.equal(group.suggestedCategoryId,group.rows[0].id.startsWith('person-')?'fee':null);
 }
 const chosen=groups.find(group=>group.rows[0].id==='person-1')!;
 assert.equal(prepareReviewChanges(source,[select(chosen)]).rules.length,0);
 assert.throws(()=>prepareReviewChanges(source,[{...select(chosen),remember:true}]));
});

test('모호한 적요의 범위 없는 규칙·부분 일치·다른 필드·빈 적요는 계속 보류한다',()=>{
 const base:Rule={id:'scope',pattern:'^김가상$',field:'description',category_id:'fee',priority:1,is_internal:false,account_id:'account-a',direction:'out'};
 const target=row('person',{description:'김가상'});
 for(const rule of [{...base,account_id:null},{...base,direction:null},{...base,pattern:'김가상'},{...base,pattern:'^김|가상$'},{...base,field:'raw_gwamok'},{...base,pattern:'^김(가상)+$'}]){
  assert.equal(buildReviewGroups(data([target],[rule]))[0].suggestedCategoryId,null);
 }
 assert.equal(buildReviewGroups(data([row('blank',{description:''})],[{...base,pattern:'^$'}]))[0].suggestedCategoryId,null);
});

test('동일 범위의 명시 전체 일치 규칙이 상충하면 우선순위가 달라도 추천을 보류한다',()=>{
 const target=row('person',{description:'김가상'});
 const base:Rule={id:'first',pattern:'^김가상$',field:'description',category_id:'fee',priority:1,is_internal:false,account_id:'account-a',direction:'out'};
 for(const category_id of ['ads','generic','missing']){
  const group=buildReviewGroups(data([target],[base,{...base,id:'conflict',priority:99,category_id}]))[0];
  assert.equal(group.suggestedCategoryId,null);assert.equal(group.canLearn,false);
 }
 assert.equal(buildReviewGroups(data([target],[base,{...base,id:'same',priority:99}]))[0].suggestedCategoryId,'fee');
});

test('정확 범위 규칙이 있어도 실제 파서가 더 우선하는 다른 과목을 선택하면 보류한다',()=>{
 const target=row('person',{description:'김가상',raw_gwamok:'출금'});
 const exact:Rule={id:'exact',pattern:'^김가상$',field:'description',category_id:'fee',priority:5,is_internal:false,account_id:'account-a',direction:'out'};
 for(const rule of [
  {...exact,id:'broad',pattern:'김',account_id:null,direction:null,category_id:'ads',priority:1},
  {...exact,id:'raw',field:'raw_gwamok',pattern:'출금',category_id:'ads',priority:1},
 ])assert.equal(buildReviewGroups(data([target],[exact,rule]))[0].suggestedCategoryId,null);
 const lowerPriority={...exact,id:'broad-later',pattern:'김',account_id:null,direction:null,category_id:'ads',priority:10};
 assert.equal(buildReviewGroups(data([target],[exact,lowerPriority]))[0].suggestedCategoryId,'fee');
});

test('근거가 한 건뿐이거나 구체 과목 이력이 없으면 임의 추천하지 않음',()=>{
 assert.equal(buildReviewGroups(data([history[0],row('pending')]))[0].suggestedCategoryId,null);
 assert.equal(buildReviewGroups(data([row('pending')]))[0].suggestedCategoryId,null);
});
test('다른 관리자 변경·대상 누락·중복 요청·다른 사업자 거래를 검사',()=>{
 const source=data([...history,row('1'),row('2'),row('foreign',{business_id:'business-b',account_id:'account-b'})]);
 const g=buildReviewGroups(source,'business-a')[0],selection=select(g);
 assert.equal(g.rows.length,2);
 assert.throws(()=>prepareReviewChanges(data([...history,row('1',{category_id:'ads'}),row('2')]),[selection]));
 assert.throws(()=>prepareReviewChanges(source,[{...selection,transactions:selection.transactions.slice(0,1)}]));
 assert.throws(()=>prepareReviewChanges(source,[selection,selection]));
 assert.throws(()=>prepareReviewChanges(source,[{...selection,category_id:'generic'}]));
});
test('같은 규칙 범위만 학습하고 후속 입금이나 다른 계좌에는 전파하지 않음',()=>{
 const source=data([...history,row('1')]),g=buildReviewGroups(source)[0],plan=prepareReviewChanges(source,[select(g)]);
 const rules=plan.rules.map((r,i)=>({...r,id:String(i),field:'description',priority:1,is_internal:false}));
 assert.equal(classify('출금','ANTHROPIC *CLAUDE SUB USA',categories,rules,[],{account_id:'account-a',direction:'out'}).category_id,'fee');
 assert.equal(classify('출금','ANTHROPIC *CLAUDE SUB USA',categories,rules,[],{account_id:'other',direction:'out'}).category_id,'generic');
 assert.equal(classify('','ANTHROPIC *CLAUDE SUB USA',categories,rules,[],{account_id:'account-a',direction:'in'}).category_id,'unknown');
 assert.equal(classify('광고선전비','ANTHROPIC *CLAUDE SUB USA',categories,rules,[],{account_id:'account-a',direction:'out'}).category_id,'ads');
});
test('정규식 기호와 긴 적요를 자르지 않으며 학습을 끌 수 있음',()=>{
 assert.equal(exactDescriptionPattern('ACME (+) [X]'),'^ACME \\(\\+\\) \\[X\\]$');
 assert.equal(exactDescriptionPattern('a'.repeat(119)),null);
 const source=data([row('long',{description:'a'.repeat(119)})]),g=buildReviewGroups(source)[0];
 assert.equal(g.canLearn,false);assert.equal(prepareReviewChanges(source,[select(g,'fee',false)]).rules.length,0);
});
