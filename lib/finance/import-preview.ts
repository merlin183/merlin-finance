import {normalizeRows,type Mapping,type ParseOptions,type NormalizedRow} from './parser';
import {mappingProblems,validateMapping,type Detection} from './auto-mapping';
import type {Alias,Category,Rule} from './types';

export type SheetPlan={name:string;rows:unknown[][];detected:Detection;selected:boolean;mapping:Mapping;options:ParseOptions};
export type PreviewRow=NormalizedRow&{sheet:string};
export function previewSheets(plans:SheetPlan[],categories:Category[],rules:Rule[],aliases:Alias[],accountId?:string){
 const parsed:PreviewRow[]=[],errors:{sheet:string;row:number;message:string}[]=[],problems:string[]=[];
 const summaries:{name:string;count:number;errors:number;from?:string;to?:string}[]=[];let skipped=0;
 for(const plan of plans.filter(p=>p.selected)){
  try{
   validateMapping(plan.mapping,plan.rows,plan.options.headerRow);
   const missing=mappingProblems(plan.rows,plan.mapping,plan.options);
   if(missing.length){problems.push(...missing.map(p=>`${plan.name}: ${p}`));summaries.push({name:plan.name,count:0,errors:0});continue;}
   const result=normalizeRows(plan.rows,plan.mapping,categories,rules,aliases,{...plan.options,accountId});
   parsed.push(...result.parsed.map(row=>({...row,sheet:plan.name})));errors.push(...result.errors.map(error=>({...error,sheet:plan.name})));skipped+=result.skipped;
   const dates=result.parsed.map(row=>row.txn_date).sort();
   summaries.push({name:plan.name,count:result.parsed.length,errors:result.errors.length,from:dates[0],to:dates.at(-1)});
  }catch(error){problems.push(`${plan.name}: ${error instanceof Error?error.message:'인식 결과를 확인해주세요.'}`);}
 }
 if(!plans.some(p=>p.selected))problems.push('저장할 거래 시트를 하나 이상 선택해주세요.');
 return {parsed,errors,problems,skipped,summaries};
}
export function transactionOverview(rows:PreviewRow[]){
 const months=new Map<string,{month:string;income:number;expense:number;incomeCount:number;expenseCount:number}>();
 let income=0,expense=0,incomeCount=0,expenseCount=0,from:string|undefined,to:string|undefined;
 for(const row of rows){
  if(!from||row.txn_date<from)from=row.txn_date;if(!to||row.txn_date>to)to=row.txn_date;
  const month=row.txn_date.slice(0,7),group=months.get(month)||{month,income:0,expense:0,incomeCount:0,expenseCount:0};
  if(row.direction==='in'){income+=row.amount;incomeCount++;group.income+=row.amount;group.incomeCount++;}
  else{expense+=row.amount;expenseCount++;group.expense+=row.amount;group.expenseCount++;}
  months.set(month,group);
 }
 return {from,to,income,expense,incomeCount,expenseCount,months:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month))};
}
export function previewPage(rows:PreviewRow[],direction:string,month:string,page:number,pageSize=50){
 const filtered=rows.filter(row=>(direction==='all'||row.direction===direction)&&(month==='all'||row.txn_date.startsWith(month))).sort((a,b)=>a.txn_date.localeCompare(b.txn_date)||a.sheet.localeCompare(b.sheet)||a.source_row-b.source_row);
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),current=Math.max(0,Math.min(page,pages-1));
 return {rows:filtered.slice(current*pageSize,(current+1)*pageSize),total:filtered.length,pages,current};
}
