import type {Business,Dataset,Transaction} from './types';
import {occurrences} from './aggregate';
import {addDays} from './format';
import {compareCategories} from './category-order';
import {accountingTransactions,type AccountingTransaction} from './transaction-accounting';
export function spendingMatrix(data:Dataset,transactions:Transaction[],businesses:Business[],direction:'in'|'out'){
 const ids=new Set(businesses.map(b=>b.id)),categories=new Map(data.categories.map(c=>[c.id,c]));
 const external=accountingTransactions(data,transactions,true).filter(t=>ids.has(t.business_id)&&t.direction===direction);
 const grouped=new Map<string,{id:string;name:string;group:string;fixed:boolean;cells:Record<string,{amount:number;rows:AccountingTransaction[]}>;total:number}>();
 for(const t of external){const id=t.category_id||'unmapped',category=categories.get(id);let row=grouped.get(id);
  if(!row){row={id,name:category?.name||'미매핑',group:category?.group_name||'정리필요',fixed:!!category?.is_fixed,cells:{},total:0};grouped.set(id,row);}
  row.cells[t.business_id]??={amount:0,rows:[]};row.cells[t.business_id].amount+=t.amount;row.cells[t.business_id].rows.push(t);row.total+=t.amount;
 }
 const rows=[...grouped.values()].sort((a,b)=>compareCategories({name:a.name,group_name:a.group},{name:b.name,group_name:b.group}));
 const totals=Object.fromEntries(businesses.map(b=>[b.id,external.filter(t=>t.business_id===b.id).reduce((s,t)=>s+t.amount,0)]));
 const fixed=Object.fromEntries(businesses.map(b=>[b.id,rows.filter(r=>r.fixed).reduce((s,r)=>s+(r.cells[b.id]?.amount||0),0)]));
 return {rows,totals,fixed,total:external.reduce((s,t)=>s+t.amount,0),transactions:external};
}
export function fixedCostPlans(data:Dataset,businesses:Business[],from:string,to:string){
 const ids=new Set(businesses.map(b=>b.id));
 return data.recurring.filter(r=>ids.has(r.business_id)&&r.direction==='out'&&r.frequency==='monthly').map(r=>{
  const dates=occurrences(r,from,to),nextDates=occurrences(r,addDays(to,1),addDays(to,30));
  return {...r,dates,nextDates,periodAmount:dates.length*r.amount,nextAmount:nextDates.length*r.amount};
 }).sort((a,b)=>a.business_id.localeCompare(b.business_id)||a.title.localeCompare(b.title));
}
