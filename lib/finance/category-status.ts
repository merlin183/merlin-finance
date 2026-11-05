import type {Category} from './types';
import {installationPolicy} from './installation-policy';

export const reviewCategoryNames=new Set(['미매핑','입금','출금']);
export function needsCategoryReview(name:string|undefined){return !name||reviewCategoryNames.has(name);}
export const HISTORICAL_COMPLETION_CATEGORY='과거완료';
export function isHistoricalCompletionCategory(name:string|undefined){return name===HISTORICAL_COMPLETION_CATEGORY;}
export function isHistoricalDate(date:string|undefined){
 const before=installationPolicy.historicalCompletionBefore;
 return !!before&&/^\d{4}-\d{2}-\d{2}$/.test(before)&&!isNaN(new Date(before).getTime())&&new Date(before).toISOString().slice(0,10)===before
  &&!!date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&!isNaN(new Date(date).getTime())&&new Date(date).toISOString().slice(0,10)===date&&date<before;
}
/** Completion is opt-in through the reserved category and applies only after real classification. */
export function resolveHistoricalCompletion(categories:Category[],date:string|undefined,categoryId:string|null|undefined){
 if(!isHistoricalDate(date)||!needsCategoryReview(categories.find(category=>category.id===categoryId)?.name))return undefined;
 return categories.find(category=>isHistoricalCompletionCategory(category.name));
}
