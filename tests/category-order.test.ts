import test from 'node:test';
import assert from 'node:assert/strict';
import {categorySection,compareCategories} from '../lib/finance/category-order';
import {categoryGroups} from '../lib/finance/seed';

test('경조사비는 재무가 아닌 인건비·복리후생 목록에 표시하고 저장 정보는 유지한다',()=>{
 const category={name:'경조사비',group_name:'재무'};
 assert.equal(categorySection(category),'영업지출 · 인건비·복리후생');
 assert.equal(category.group_name,'재무');
 assert.equal(categorySection({name:'상여금',group_name:'영업수입'}),'영업수입');
 assert.equal(categorySection({name:'퇴직금',group_name:'영업수입'}),'영업수입');
});

test('자산 취득과 보증금·계약금은 구분하고 과목명은 변경하지 않는다',()=>{
 for(const name of ['비품','차량운반비'])assert.equal(categorySection({name,group_name:'투자'}),'투자·자산 · 자산 취득');
 for(const name of ['보증금','계약금'])assert.equal(categorySection({name,group_name:'투자'}),'투자·자산 · 보증금·계약금');
 assert.equal(categorySection({name:'매입',group_name:'영업지출'}),'영업지출 · 매입·기타 지출');
});

test('같은 용도의 과목은 가나다순 대신 정해진 순서를 유지한다',()=>{
 const categories=[
  ...['경조사비','복리후생비','퇴직금','상여금','급여','지급수수료','관리비','임대료','임차료'].map(name=>({name,group_name:name==='경조사비'?'재무':'영업지출'})),
  ...['계약금','보증금','차량운반비','비품'].map(name=>({name,group_name:'투자'})),
 ];
 assert.deepEqual(categories.sort(compareCategories).map(category=>category.name),[
  '급여','상여금','퇴직금','복리후생비','경조사비','임차료','임대료','관리비','지급수수료','비품','차량운반비','보증금','계약금',
 ]);
});

test('추가된 운반비와 영업외수입도 관련 과목 옆에 표시한다',()=>{
 const categories=[
  {name:'출금',group_name:'정리필요'},
  {name:'합의금',group_name:'영업외수입'},
  {name:'비품',group_name:'투자'},
  {name:'매출',group_name:'영업수입'},
  ...['차량유지비','운반비','여비교통비'].map(name=>({name,group_name:'영업지출'})),
 ];
 assert.equal(categorySection({name:'운반비',group_name:'영업지출'}),'영업지출 · 마케팅·교육·활동');
 assert.deepEqual(categories.sort(compareCategories).map(category=>category.name),[
  '여비교통비','운반비','차량유지비','매출','합의금','비품','출금',
 ]);
});

test('정해진 순서가 없는 추가 과목과 그룹은 가나다순으로 모아 표시한다',()=>{
 const categories=[
  {name:'나과목',group_name:'사용자 정의'},
  {name:'가과목',group_name:'사용자 정의'},
  {name:'추가과목',group_name:'가그룹'},
  {name:'나비용',group_name:'영업지출'},
  {name:'가비용',group_name:'영업지출'},
  {name:'매입',group_name:'영업지출'},
 ];
 assert.deepEqual(categories.sort(compareCategories).map(category=>category.name),[
  '매입','가비용','나비용','추가과목','가과목','나과목',
 ]);
});

test('미매핑만 맨 위, 과거완료는 맨 아래에 두고 각 구역은 끊기지 않는다',()=>{
 const categories=Object.entries(categoryGroups).flatMap(([group_name,names])=>names.map(name=>({name,group_name})));
 categories.push({name:'과거완료',group_name:'정리필요'},{name:'추가과목',group_name:'사용자 정의'});
 const before=structuredClone(categories);
 const sorted=[...categories].sort(compareCategories);
 assert.equal(sorted[0].name,'미매핑');
 assert.equal(sorted.at(-1)?.name,'과거완료');
 assert.equal(categorySection(sorted[0]),'미매핑');
 assert.equal(categorySection({name:'출금',group_name:'정리필요'}),'정리필요');
 const sections=sorted.map(categorySection).filter((section,index,all)=>index===0||section!==all[index-1]);
 assert.equal(sections.length,new Set(sections).size);
 assert.deepEqual(categories,before);
 assert.equal(sorted.length,categories.length);
});
