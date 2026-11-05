import type {Dataset,Transaction} from './types';
import {createClassifier,safePattern} from './parser';
import {isHistoricalCompletionCategory,needsCategoryReview} from './category-status';

const merchants=[
 ['anthropic','ANTHROPIC · Claude','^ANTHROPIC |^ANTHROPIC\\*|^ANTHROPIC$'],
 ['openai','OPENAI · ChatGPT','^OPENAI |^OPENAI\\*|^OPENAI$'],
 ['cloudflare','CLOUDFLARE','^CLOUDFLARE |^CLOUDFLARE$'],
 ['solapi','SOLAPI','^SOLAPI |^SOLAPI$'],
 ['tiktok','TikTok Ads','^TIKTOK ADS |^TIKTOK ADS$'],
 ['railway','RAILWAY','^RAILWAY |^RAILWAY$'],
 ['genspark','GENSPARK','^GENSPARK\\.AI |^GENSPARK\\.AI$'],
] as const;
const merchantPatterns=merchants.map(([key,label,pattern])=>({key,label,pattern,regex:new RegExp(pattern,'i')}));
const bankChannel=/^(?:bz뱅크|타행.*|신한체|fb자동|op이체|[ge]-.*|인터넷당행|인터넷이체|스마트.*|체크입금|체크취소|카카오페이|네이버페이|현금|입금|출금|급여)$|카드(?:대금|결제|출금|취소|환불|$)/i;
const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export function exactDescriptionPattern(value:string){const pattern='^'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';try{safePattern(pattern);return pattern;}catch{return null;}}
export function descriptionIdentity(description:string){
 const normalized=normalize(description);
 const vendor=merchantPatterns.find(({regex})=>regex.test(description.trim()));
 const ambiguous=!normalized||bankChannel.test(normalized)||(/^[가-힣]{2,4}$/.test(normalized)&&!['대여금','수수료','이자','환불','매출','매입','임차료','상여금','지원금'].includes(normalized));
 return {key:vendor?'merchant:'+vendor.key:'exact:'+normalized,label:vendor?.label||description.trim()||'적요 없음',pattern:vendor?.pattern||null,ambiguous};
}
export type ReviewGroup={key:string;account_id:string;direction:'in'|'out';label:string;rows:Transaction[];total:number;from:string;to:string;patterns:string[];canLearn:boolean;ambiguous:boolean;suggestedCategoryId:string|null;reason:string;historyCount:number};
export type ReviewSelection={key:string;category_id:string;remember:boolean;transactions:{id:string;category_id:string|null;manually_classified:boolean}[]};

function exactScopedClassifier(data:Dataset,classify:ReturnType<typeof createClassifier>){
 const scoped=new Map<string,{category_id:string;pattern:RegExp}[]>(),categories=new Map(data.categories.map(category=>[category.id,category]));
 for(const rule of data.rules){
  if(isHistoricalCompletionCategory(categories.get(rule.category_id)?.name))continue;
  if(rule.field!=='description'||!rule.account_id||!rule.direction||!rule.pattern.startsWith('^')||!rule.pattern.endsWith('$'))continue;
  try{
   const key=JSON.stringify([rule.account_id,rule.direction]),rules=scoped.get(key)||[];
   rules.push({category_id:rule.category_id,pattern:safePattern(rule.pattern)});scoped.set(key,rules);
  }catch{/* Invalid historical rules cannot justify a recommendation. */}
 }
 return (transaction:Transaction)=>{
  if(!transaction.description.trim())return null;
  const ids=new Set<string>();
  for(const rule of scoped.get(JSON.stringify([transaction.account_id,transaction.direction]))||[]){
   const match=rule.pattern.exec(transaction.description);
   if(match&&match.index===0&&match[0]===transaction.description)ids.add(rule.category_id);
  }
  if(ids.size!==1)return null;
  const category=categories.get([...ids][0]);
  if(!category||needsCategoryReview(category.name))return null;
  const classified=classify(transaction.raw_gwamok,transaction.description,{account_id:transaction.account_id,direction:transaction.direction});
  return classified.category_id===category.id?category.id:null;
 };
}

export function buildReviewGroups(data:Dataset,business='all'){
 const categories=new Map(data.categories.map(c=>[c.id,c]));
 const classify=createClassifier(data.categories,data.rules,data.aliases),exactScopedRuleCategory=exactScopedClassifier(data,classify);
 const identities=new Map<string,ReturnType<typeof descriptionIdentity>>();
 const identityFor=(description:string)=>{let identity=identities.get(description);if(!identity){identity=descriptionIdentity(description);identities.set(description,identity);}return identity;};
 const unresolved=(t:Transaction)=>needsCategoryReview(t.category_id?categories.get(t.category_id)?.name:undefined);
 const key=(t:Transaction)=>JSON.stringify([t.account_id,t.direction,identityFor(t.description).key]);
 const history=new Map<string,Map<string,number>>();
 for(const t of data.transactions){
  if(unresolved(t)||!t.manually_classified||!t.category_id||isHistoricalCompletionCategory(categories.get(t.category_id)?.name))continue;
  const k=key(t),counts=history.get(k)||new Map<string,number>();counts.set(t.category_id,(counts.get(t.category_id)||0)+1);history.set(k,counts);
 }
 const map=new Map<string,ReviewGroup>();
 for(const t of data.transactions){
  if((business!=='all'&&t.business_id!==business)||!unresolved(t))continue;
  const identity=identityFor(t.description);
  // Channel labels and personal names are not evidence of a shared purpose.
  const k=identity.ambiguous?JSON.stringify([t.account_id,t.direction,'transaction:'+t.id]):key(t);
  let g=map.get(k);
  if(!g){g={key:k,account_id:t.account_id,direction:t.direction,label:identity.label,rows:[],total:0,from:t.txn_date,to:t.txn_date,patterns:[],canLearn:!identity.ambiguous,ambiguous:identity.ambiguous,suggestedCategoryId:null,reason:'과목을 한 번 선택하면 묶음 전체에 적용합니다.',historyCount:0};map.set(k,g);}
  g.rows.push(t);g.total+=t.amount;if(t.txn_date<g.from)g.from=t.txn_date;if(t.txn_date>g.to)g.to=t.txn_date;
 }
 for(const g of map.values()){
  g.rows.sort((a,b)=>a.txn_date.localeCompare(b.txn_date)||a.id.localeCompare(b.id));
  const identity=identityFor(g.rows[0].description);
  const patterns=identity.pattern?[identity.pattern]:[...new Set(g.rows.map(t=>exactDescriptionPattern(t.description)))];
  g.canLearn=g.canLearn&&patterns.every((p):p is string=>p!==null)&&patterns.length<=30;
  g.patterns=g.canLearn?patterns as string[]:[];
  if(g.ambiguous){
   const ids=g.rows.map(transaction=>exactScopedRuleCategory(transaction));
   if(ids[0]&&ids.every(id=>id===ids[0])){g.suggestedCategoryId=ids[0];g.reason='이 계좌·입출금 방향에 등록된 전체 적요 일치 규칙입니다.';}
   else g.reason='거래처나 용도를 확인한 뒤 선택하세요.';
   continue;
  }
  const known=history.get(key(g.rows[0]));
  g.historyCount=known?[...known.values()].reduce((sum,n)=>sum+n,0):0;
  if(known&&known.size>1){g.canLearn=false;g.patterns=[];g.reason='과거에 서로 다른 과목으로 분류한 거래처입니다. 자동 학습 없이 이번 내역만 정리합니다.';continue;}
  if(known?.size===1&&g.historyCount>=2){g.suggestedCategoryId=[...known.keys()][0];g.reason=`같은 계좌·입출금 방향의 확정 내역 ${g.historyCount.toLocaleString()}건이 같은 과목입니다.`;continue;}
  const matched=g.rows.map(t=>classify('',t.description,{account_id:t.account_id,direction:t.direction}));
  const ids=new Set(matched.map(m=>m.category_id).filter((id):id is string=>!!id&&!needsCategoryReview(categories.get(id)?.name)));
  if(ids.size===1&&matched.every(m=>m.category_id===[...ids][0])&&(!known||known.has([...ids][0]))){g.suggestedCategoryId=[...ids][0];g.reason='등록된 자동 분류 규칙과 일치합니다.';}
 }
 const unmapped=(g:ReviewGroup)=>g.rows.some(t=>!t.category_id||!categories.has(t.category_id)||categories.get(t.category_id)?.name==='미매핑');
 return [...map.values()].sort((a,b)=>Number(unmapped(b))-Number(unmapped(a))||Number(!!b.suggestedCategoryId)-Number(!!a.suggestedCategoryId)||b.rows.length-a.rows.length||a.label.localeCompare(b.label));
}

export function prepareReviewChanges(data:Dataset,selections:ReviewSelection[]){
 const groups=new Map(buildReviewGroups(data).map(g=>[g.key,g]));
 const seen=new Set<string>(),rules=new Map<string,{pattern:string;category_id:string;account_id:string;direction:'in'|'out'}>();
 const changes:{id:string;category_id:string;expected_category_id:string|null;expected_manually_classified:boolean}[]=[];
 for(const s of selections){
  const g=groups.get(s.key),category=data.categories.find(c=>c.id===s.category_id);
  if(!category||needsCategoryReview(category.name))throw Error('세부 계정과목을 선택해주세요.');
  if(!g||g.rows.length!==s.transactions.length)throw Error('거래가 변경되었습니다. 새로고침 후 다시 확인해주세요.');
  const expected=new Map(s.transactions.map(t=>[t.id,t]));
  if(expected.size!==s.transactions.length)throw Error('같은 거래가 중복 선택되었습니다.');
  for(const t of g.rows){
   const previous=expected.get(t.id);
   if(!previous||previous.category_id!==t.category_id||previous.manually_classified!==t.manually_classified)throw Error('거래가 변경되었습니다. 새로고침 후 다시 확인해주세요.');
   if(seen.has(t.id))throw Error('같은 거래가 중복 선택되었습니다.');seen.add(t.id);
   changes.push({id:t.id,category_id:category.id,expected_category_id:t.category_id,expected_manually_classified:t.manually_classified});
  }
  if(s.remember&&!isHistoricalCompletionCategory(category.name)){
   if(!g.canLearn)throw Error('거래처가 불명확한 항목은 자동 학습할 수 없습니다.');
   for(const pattern of g.patterns){safePattern(pattern);const k=JSON.stringify([g.account_id,g.direction,pattern]);if(rules.has(k)&&rules.get(k)!.category_id!==category.id)throw Error('같은 거래처에 서로 다른 과목을 지정할 수 없습니다.');rules.set(k,{pattern,category_id:category.id,account_id:g.account_id,direction:g.direction});}
  }
 }
 if(!changes.length||changes.length>10000)throw Error('한 번에 1~10,000건을 선택해주세요.');
 return {changes,rules:[...rules.values()]};
}
