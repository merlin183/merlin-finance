import type {Category} from './types';

type CategoryLabel=Pick<Category,'name'|'group_name'>;
const expenseSections=[
 ['인건비·복리후생',['급여','상여금','퇴직금','복리후생비','경조사비']],
 ['사무실·운영',['임차료','임대료','관리비','수도광열비','통신비','지급수수료','소모품비','사무용품비','도서인쇄비']],
 ['마케팅·교육·활동',['광고선전비','교육훈련비','접대비','여비교통비','운반비','차량유지비']],
 ['세금·보험·금융',['세금과공과','보험료','이자비용','대출이자']],
 ['매입·기타 지출',['매입','기타소득']],
] as const;
const investmentSections=[
 ['자산 취득',['비품','차량운반비']],
 ['보증금·계약금',['보증금','계약금']],
] as const;
const groupOrder=['영업지출','영업수입','영업외수입','투자','재무','내부이동','조정·환입','정리필요'];

// Menu organization only. Keep stored groups and financial calculations intact.
function displayGroup(category:CategoryLabel){
 return category.name==='경조사비'&&category.group_name==='재무'?'영업지출':category.group_name;
}
function categoryPosition(category:CategoryLabel){
 const group=displayGroup(category);
 const sections=group==='영업지출'?expenseSections:group==='투자'?investmentSections:[];
 const sectionIndex=sections.findIndex(([,names])=>(names as readonly string[]).includes(category.name));
 const section=sections[sectionIndex];
 return {group,section:section?.[0],sectionIndex:sectionIndex<0?sections.length:sectionIndex,nameIndex:section?(section[1] as readonly string[]).indexOf(category.name):0};
}
export function categorySection(category:CategoryLabel){
 if(category.name==='미매핑')return '미매핑';
 if(category.name==='과거완료')return '과거완료';
 const {group,section}=categoryPosition(category);
 const label=group==='투자'?'투자·자산':group;
 return label+(section?' · '+section:group==='영업지출'?' · 기타 지출':'');
}
export function compareCategories(a:CategoryLabel,b:CategoryLabel){
 if(a.name==='미매핑'||b.name==='미매핑')return Number(b.name==='미매핑')-Number(a.name==='미매핑');
 if(a.name==='과거완료'||b.name==='과거완료')return Number(a.name==='과거완료')-Number(b.name==='과거완료');
 const rank=(category:CategoryLabel)=>{
  const {group,sectionIndex}=categoryPosition(category);
  const groupIndex=groupOrder.indexOf(group);
  return (groupIndex<0?99:groupIndex)*10+sectionIndex;
 };
 return rank(a)-rank(b)||categorySection(a).localeCompare(categorySection(b),'ko')||categoryPosition(a).nameIndex-categoryPosition(b).nameIndex||a.name.localeCompare(b.name,'ko');
}
