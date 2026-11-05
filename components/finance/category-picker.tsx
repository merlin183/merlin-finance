"use client";
import {useMemo,useState} from 'react';
import {Check,ChevronsUpDown} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {Command,CommandEmpty,CommandGroup,CommandInput,CommandItem,CommandList} from '@/components/ui/command';
import {categorySection,compareCategories} from '@/lib/finance/category-order';
import type {Alias,Category} from '@/lib/finance/types';

const noAliases:Alias[]=[];
type CategoryPickerProps={
 label:string;
 value:string;
 onChange:(id:string)=>void;
 categories:Category[];
 aliases?:Alias[];
 individual?:boolean;
 allLabel?:string;
 disabled?:boolean;
};

export function CategoryPicker({label,value,onChange,categories,aliases=noAliases,individual=false,allLabel,disabled=false}:CategoryPickerProps){
 const [open,setOpen]=useState(false);
 const grouped=useMemo(()=>{
  const groups=new Map<string,Category[]>();
  for(const c of [...categories].sort(compareCategories)){
   const section=categorySection(c);
   const items=groups.get(section);
   if(items)items.push(c);else groups.set(section,[c]);
  }
  return [...groups];
 },[categories]);
 const aliasesByName=useMemo(()=>{
  const names=new Map<string,string[]>();
  for(const alias of aliases){
   const values=names.get(alias.standard_name);
   if(values)values.push(alias.raw_name);else names.set(alias.standard_name,[alias.raw_name]);
  }
  return names;
 },[aliases]);
 const selected=categories.find(c=>c.id===value);
 function select(id:string){
  if(disabled)return;
  onChange(id);
  setOpen(false);
 }
 return <Popover open={open&&!disabled} onOpenChange={next=>setOpen(!disabled&&next)}>
  <PopoverTrigger asChild><Button role="combobox" aria-label={label} aria-expanded={open&&!disabled} disabled={disabled} variant="outline" className="category-search-trigger">
   <span className={selected?.name==='미매핑'?'negative':''}>{selected?.name||(value==='all'&&allLabel?allLabel:value==='individual'?'묶음별 선택·추천 과목':'과목명 입력하여 찾기')}</span><ChevronsUpDown size={15}/>
  </Button></PopoverTrigger>
  <PopoverContent align="start" className="p-0 w-[340px] max-w-[calc(100vw-32px)]">
   <Command filter={(text,search,keywords)=>{const normalize=(s:string)=>s.replace(/\s/g,'').toLowerCase();const q=normalize(search);return normalize([text,...keywords||[]].join(' ')).includes(q)?1:0;}}>
    <CommandInput aria-label={`${label} 검색`} placeholder="과목명 검색 · 예: 수수료, 임대, 광고"/>
    <CommandList className="max-h-80">
     <CommandEmpty>일치하는 과목이 없습니다.</CommandEmpty>
     {allLabel&&<CommandGroup heading="조회 범위"><CommandItem value={allLabel} onSelect={()=>select('all')}><Check size={15} className={value==='all'?'opacity-100':'opacity-0'}/>{allLabel}</CommandItem></CommandGroup>}
     {individual&&<CommandGroup heading="일괄 적용 방식"><CommandItem value="묶음별 선택 추천 과목" onSelect={()=>select('individual')}>묶음별 선택·추천 과목</CommandItem></CommandGroup>}
     {grouped.map(([group,items])=><CommandGroup key={group} heading={group} className="[&_[cmdk-group-heading]]:rounded-sm [&_[cmdk-group-heading]]:bg-muted [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-foreground">{items.map(c=><CommandItem key={c.id} value={c.name} keywords={[group,...aliasesByName.get(c.name)||[]]} onSelect={()=>select(c.id)}><Check size={15} className={c.id===value?'opacity-100':'opacity-0'}/><span className={c.name==='미매핑'?'negative':''}>{c.name}</span></CommandItem>)}</CommandGroup>)}
    </CommandList>
   </Command>
  </PopoverContent>
 </Popover>;
}
