import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import Module from 'node:module';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {register} from 'tsx/cjs/api';

const require=createRequire(import.meta.url),originalLoad=Module._load;
let selectedProps;
const toastMessages=[];
// Observe the Select boundary and render native options: their values must not
// retain financial source-sheet names while the parent still receives originals.
const select={Select:props=>{selectedProps=props;return h('select',{value:props.value,onChange:()=>{}},props.children);},SelectContent:({children})=>children,SelectItem:({value,children})=>h('option',{value},children),SelectTrigger:({children})=>children,SelectValue:()=>null};
const unregister=register();
let privacy,model,common,CategoryPicker,MerchantNoteEditor,createMerchantNoteStore,noteSubject;
try{
 Module._load=function(request,parent,isMain){
  if(request==='@/components/ui/select')return select;
  if(request==='sonner')return {toast:{error:message=>toastMessages.push(message)}};
  if(request==='next/navigation')return {useRouter:()=>({push:()=>{}})};
  return originalLoad.call(this,request,parent,isMain);
 };
 privacy=require('../components/finance/financial-visibility.tsx');
 model=require('../lib/finance/financial-visibility.ts');
 common=require('../components/finance/common.tsx');
 ({CategoryPicker}=require('../components/finance/category-picker.tsx'));
 ({MerchantNoteEditor}=require('../components/finance/merchant-note.tsx'));
 ({createMerchantNoteStore}=require('../lib/finance/merchant-note-store.ts'));
 ({noteSubject}=require('../lib/finance/merchant-notes.ts'));
}finally{Module._load=originalLoad;unregister();}

function render(visible,children){
 return renderToStaticMarkup(h(privacy.FinancialVisibilityContext.Provider,{value:{amountsVisible:visible,preferenceReady:true,toggleAmountsVisible:()=>{},privateValue:value=>model.financialDisplayValue(value,visible),privateText:text=>visible?text:model.redactFinancialText(text)}},children));
}

test('공통 패널은 금융 제목·설명을 숨기고 날짜와 기능 이름을 유지한다',()=>{
 const element=h(common.Panel,{title:'합성 임차료 987,654원',subtitle:'2026-11-06 · 3건 · 원천세 8642197'},'합성 품목');
 const hidden=render(false,element),shown=render(true,element);
 assert.doesNotMatch(hidden,/987,654|8642197/);assert.match(hidden,/2026-11-06 · 3건/);assert.match(hidden,/합성 품목/);
 assert.match(shown,/987,654원/);assert.match(shown,/8642197/);
});

test('공통 선택은 표시·native option의 금융 문자열을 숨기면서 원래 선택값을 전달한다',()=>{
 const options=[{value:'합성 987,654원',label:'정산 987,654원'},{value:'계좌 123456789012',label:'다른 통장 123456789012'}],changes=[];
 const props={label:'통장 987,654원',value:options[0].value,options,onChange:value=>changes.push(value)};
 const hidden=render(false,h(common.Picker,props));
 assert.doesNotMatch(hidden,/987,654|123456789012/);assert.match(hidden,/private-option-0/);
 selectedProps.onValueChange('private-option-1');assert.deepEqual(changes,[options[1].value]);
 selectedProps.onValueChange('unknown');assert.equal(changes.length,1);
 const shown=render(true,h(common.Picker,props));assert.match(shown,/987,654/);
 assert.equal(props.value,options[0].value);assert.equal(options[1].value,'계좌 123456789012');
});

test('과목 선택 trigger는 사용자 과목명과 접근성 이름의 금융 수치를 숨긴다',()=>{
 const props={label:'분류 987,654원',value:'synthetic-category',onChange:()=>{},categories:[{id:'synthetic-category',name:'합성 임차료 987,654원',group_name:'고정비',sort_order:1}]};
 const hidden=render(false,h(CategoryPicker,props)),shown=render(true,h(CategoryPicker,props));
 assert.doesNotMatch(hidden,/987,654/);assert.match(hidden,/합성 임차료/);assert.match(shown,/987,654원/);
});

test('공동 메모는 초안을 변경하지 않고 표시와 접근성 값만 숨긴다',t=>{
 const transaction={id:'synthetic-transaction',business_id:'synthetic-business',account_id:'synthetic-account',upload_id:null,txn_date:'2026-11-06',amount:987654,direction:'out',description:'합성 임차료 987,654원',raw_gwamok:'',category_id:null,is_internal:false,balance:null,tax_invoice:false,dedup_hash:'synthetic',manually_classified:false};
 const memo='2026-11-06 지급 · 원천세 8642197 · 광고비 500만';
 const store=createMerchantNoteStore([{id:'synthetic-note',...noteSubject(transaction),memo,version:1,updated_at:'2026-11-06T00:00:00Z'}],async()=>{throw Error('Writes are prohibited in this synthetic test');});
 t.after(()=>store.dispose());
 const hidden=render(false,h(MerchantNoteEditor,{transaction,notes:store}));
 assert.doesNotMatch(hidden,/987,654|8642197|500만/);assert.match(hidden,/2026-11-06/);assert.match(hidden,/readOnly=""/);
 assert.equal(store.state(transaction).text,memo);
 const shown=render(true,h(MerchantNoteEditor,{transaction,notes:store}));assert.match(shown,/8642197/);assert.match(shown,/500만/);
});


test('열린 오류 토스트는 원본 메시지를 유지하며 같은 React node가 ON/OFF 전환을 따라간다',async()=>{
 const message='합성 지급 8,642,197원 · 합성 계좌 123-456789-12-34-5 · 2026-11-06 3건';
 await common.action(async()=>{throw Error(message);});
 const node=toastMessages.at(-1);
 assert.equal(node.type,privacy.FinancialText);
 const shown=render(true,node),hidden=render(false,node),restored=render(true,node);
 assert.match(shown,/8,642,197원/);assert.match(shown,/123-456789-12-34-5/);
 assert.doesNotMatch(hidden,/8,642,197|123-456789-12-34-5/);assert.match(hidden,/2026-11-06 3건/);
 assert.equal(node.props.value,message);assert.equal(restored,shown);
});
