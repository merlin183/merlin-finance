import type {Dataset} from './types';
import type {ClassificationResult} from './classification-result';
import type {FixedCostSaveResult} from './cash-plan-series-forward';

/** Retain a newer server version if another tab's read finishes during a save. */
export function mergeFixedCostResult(data:Dataset,result:FixedCostSaveResult):Dataset{
 const merge=<T extends {id:string;version?:number}>(current:readonly T[],saved:readonly T[]):T[]=>{
  const rows=new Map(current.map(row=>[row.id,row]));
  for(const row of saved){const existing=rows.get(row.id);if(!existing||(existing.version??0)<=(row.version??0))rows.set(row.id,row);}
  return [...rows.values()];
 };
 return {...data,cash_plan_series:merge(data.cash_plan_series??[],result.series),cash_plan_series_revisions:merge(data.cash_plan_series_revisions??[],result.revisions)};
}

export function mergeClassificationResult(data:Dataset,result:ClassificationResult):Dataset{
 const patches=new Map(result.transactions?.map(transaction=>[transaction.id,transaction]));
 const rules=result.rulesDelta?new Map((result.rules??data.rules).map(rule=>[rule.id,rule])):null;
 for(const rule of result.rulesDelta??[])rules!.set(rule.id,rule);
 return {...data,transactions:data.transactions.map(transaction=>{
  const patch=patches.get(transaction.id);
  if(!patch)return transaction;
  const reclassified=patch.category_id!==transaction.category_id||patch.is_internal!==transaction.is_internal;
  const clearedFee=reclassified&&((transaction.transfer_fee_amount??0)>0||transaction.transfer_fee_category_id)?{transfer_fee_amount:0,transfer_fee_category_id:null}:{};
  return {...transaction,...clearedFee,category_id:patch.category_id,is_internal:patch.is_internal,manually_classified:patch.manually_classified};
 }),rules:rules?[...rules.values()]:result.rules??data.rules};
}

/** Rebase writes confirmed during an older in-flight snapshot, without another full read. */
export function createDatasetUpdates(){
 type Update=(data:Dataset)=>Dataset;
 let active:Update[]|null=null;
 return {
  record(update:Update){active?.push(update);},
  beginRead(){
   const updates:Update[]=[];active=updates;
   return {
    apply(data:Dataset){return updates.reduce((current,update)=>update(current),data);},
    finish(){if(active===updates)active=null;},
   };
  },
 };
}
