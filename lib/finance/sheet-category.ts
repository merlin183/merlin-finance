import type {Alias,Category} from './types';

export type SheetCategoryStatus='mapped'|'unregistered'|'needs_review'|'blank';
export type SheetCategoryIssue={rawName:string;count:number;status:'unregistered'|'needs_review'};
export const normalizeCategoryName=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,'');
export const isReviewCategoryName=(value:string)=>['미매핑','입금','출금'].includes(normalizeCategoryName(value));

/** Resolve only unique names/aliases; never guess a financial category. */
export function resolveSheetCategory(raw:string,categories:Category[],aliases:Alias[]):{status:SheetCategoryStatus;category?:Category}{
 const key=normalizeCategoryName(raw);
 if(!key)return {status:'blank'};
 const direct=categories.filter(category=>normalizeCategoryName(category.name)===key);
 const targets=new Set(aliases.filter(alias=>normalizeCategoryName(alias.raw_name)===key).map(alias=>normalizeCategoryName(alias.standard_name)));
 if(direct.length)targets.add(key);
 const matches:Category[]=[];
 for(const target of targets){
  const candidates=categories.filter(category=>normalizeCategoryName(category.name)===target);
  if(candidates.length!==1)return {status:'unregistered'};
  matches.push(candidates[0]);
 }
 const unique=new Map(matches.map(category=>[category.id,category]));
 if(unique.size!==1)return {status:isReviewCategoryName(raw)&&!targets.size?'needs_review':'unregistered'};
 const category=[...unique.values()][0];
 return {category,status:isReviewCategoryName(category.name)?'needs_review':'mapped'};
}
