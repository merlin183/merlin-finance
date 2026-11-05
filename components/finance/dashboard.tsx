"use client";
import {FinanceLink} from './common';
import {SpendingAnalysis} from './spending-analysis';
import {AccountBalances,accountLabel} from './account-balances';
import {accountSnapshot} from '@/lib/finance/balances';
import {OperatingSummary,TransferPositions} from "./operating-summary";
import {useMemo,useState,type ReactNode} from 'react';import {ArrowDownLeft,ArrowUpRight,Wallet,ArrowRight,ChartNoAxesCombined,Info,Plus} from 'lucide-react';import {ResponsiveContainer,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Line,ComposedChart,PieChart,Pie,Cell,Sankey} from 'recharts';import {Switch} from '@/components/ui/switch';import {Button} from '@/components/ui/button';import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';import {Panel,NoData,Picker,api,action} from './common';import {positions,monthly} from '@/lib/finance/aggregate';import {won,compact} from '@/lib/finance/format';import type {Dataset,Transaction} from '@/lib/finance/types';import {toast} from 'sonner';
import {AnalysisSection,analysisSections,type AnalysisSectionId} from './analysis-section';
import {dateRangeBounds,filterTransactionsByRange,resolveDateRange,type DateRange} from '@/lib/finance/date-range';
import {today} from '@/lib/finance/format';
import {accountingTransactions,transferFeeDetails} from '@/lib/finance/transaction-accounting';

type DashboardProps={data:Dataset;tx:Transaction[];biz:string;asOf:string;from:string;consolidated:boolean;refresh:()=>Promise<void>};

export function Dashboard({data,tx,biz,asOf,from,consolidated,refresh}:DashboardProps){
 const [external,setExternal]=useState(consolidated);
 const [account,setAccount]=useState('all');
 const [representative,setRepresentative]=useState('all');
 const [selectedSection,setSelectedSection]=useState('all');
 const [sectionRanges,setSectionRanges]=useState<Partial<Record<AnalysisSectionId,DateRange>>>({});
 const [match,setMatch]=useState(false),[out,setOut]=useState(''),[incoming,setIncoming]=useState('');
 const overall={from,to:asOf};
 const bounds=useMemo(()=>dateRangeBounds(data.transactions,today()),[data.transactions]);
 const rangeFor=(section:AnalysisSectionId)=>resolveDateRange(overall,sectionRanges[section]);
 const fundsRange=consolidated?rangeFor('funds'):overall;
 const cashflowRange=consolidated?rangeFor('cashflow'):overall;
 const transferRange=rangeFor('transfers');
 const useCollectedBalance=fundsRange.to===today();
 const allPos=useMemo(()=>positions(data,consolidated?resolveDateRange({from,to:asOf},sectionRanges.funds).to:asOf,30,useCollectedBalance?data.balance_snapshots:undefined),[data,consolidated,from,asOf,sectionRanges,useCollectedBalance]);
 const businesses=useMemo(()=>data.businesses.filter(b=>(biz==='all'||b.id===biz)&&(representative==='all'||b.representative===representative)),[data.businesses,biz,representative]);
 const businessIds=useMemo(()=>new Set(businesses.map(b=>b.id)),[businesses]);
 const pos=allPos.filter(b=>businessIds.has(b.id));
 // Date ranges are applied after business/person/account scope. An individual
 // section may legitimately query dates outside the overall analysis period.
 const scopedRows=useMemo(()=>data.transactions.filter(t=>businessIds.has(t.business_id)&&(account==='all'||t.account_id===account)),[data.transactions,businessIds,account]);
 const sourceRows=(range:DateRange)=>filterTransactionsByRange(scopedRows,range);
 const rawRows=consolidated?sourceRows(fundsRange):tx.filter(t=>(account==='all'||t.account_id===account)&&(representative==='all'||businessIds.has(t.business_id)));
 const rows=accountingTransactions(data,rawRows,external);
 const rawCashflowRows=consolidated?sourceRows(cashflowRange):rawRows;
 const cashflowRows=accountingTransactions(data,rawCashflowRows,external);
 const recentRows=rawRows.filter(t=>!external||(!t.is_internal&&!data.categories.find(c=>c.id===t.category_id)?.is_internal)||!!transferFeeDetails(data,t));
 const income=rows.filter(t=>t.direction==='in').reduce((sum,t)=>sum+t.amount,0);
 const expense=rows.filter(t=>t.direction==='out').reduce((sum,t)=>sum+t.amount,0);
 const shownAccounts=data.accounts.filter(a=>businessIds.has(a.business_id)&&(account==='all'||a.id===account));
 // Balances always retain the complete history up to this section's end date.
 const snapshots=shownAccounts.map(a=>accountSnapshot(a,data.transactions,fundsRange.to,useCollectedBalance?data.balance_snapshots:undefined));
 const balance=snapshots.length&&snapshots.every(s=>s.balance!==null)?snapshots.reduce((sum,s)=>sum+s.balance!,0):null;
 const available=pos.length&&pos.every(b=>b.available!==null)?pos.reduce((sum,b)=>sum+b.available!,0):null;
 const chart=monthly(cashflowRows);
 const categories=Object.entries(rows.filter(t=>t.direction==='out'&&!t.is_internal).reduce<Record<string,number>>((all,t)=>{
  const name=data.categories.find(c=>c.id===t.category_id)?.name||'미매핑';all[name]=(all[name]||0)+t.amount;return all;
 },{})).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,value])=>({name,value}));
 // An included endpoint keeps its counterpart visible, even if that business
 // or endpoint date is outside the selected scope. Internal exclusion above
 // applies to cashflow, not to this dedicated transfer report.
 const visibleIds=new Set(filterTransactionsByRange(scopedRows,transferRange).map(t=>t.id));
 const transactionsById=new Map(data.transactions.map(t=>[t.id,t]));
 const links=data.links.map(link=>({link,out:transactionsById.get(link.out_transaction_id),incoming:transactionsById.get(link.in_transaction_id)}))
  .filter(link=>link.out&&link.incoming&&(visibleIds.has(link.out.id)||visibleIds.has(link.incoming.id)));
 const transferBusinessIds=new Set(links.flatMap(link=>[link.out!.business_id,link.incoming!.business_id]));
 const transferBusinesses=data.businesses.filter(b=>transferBusinessIds.has(b.id));
 const flowNodes=[...transferBusinesses.map(b=>({name:b.name+' · 출금'})),...transferBusinesses.map(b=>({name:b.name+' · 입금'}))];
 const flowLinks=links.map(link=>({source:transferBusinesses.findIndex(b=>b.id===link.out!.business_id),target:transferBusinesses.length+transferBusinesses.findIndex(b=>b.id===link.incoming!.business_id),value:link.out!.amount}));
 const matchedIds=new Set(data.links.flatMap(link=>[link.out_transaction_id,link.in_transaction_id]));
 const possibleOut=data.transactions.filter(t=>t.is_internal&&t.direction==='out'&&!matchedIds.has(t.id));
 const selectedOut=possibleOut.find(t=>t.id===out);
 const possibleIn=data.transactions.filter(t=>t.is_internal&&t.direction==='in'&&!matchedIds.has(t.id)&&selectedOut&&t.business_id!==selectedOut.business_id&&t.amount===selectedOut.amount);

 const fundsSummary=<><div className="kpi-grid">{[{label:'종료일 기준 잔액',value:balance,icon:Wallet,note:(account==='all'?'표시 통장 합계':'선택 통장')+' · '+fundsRange.to,color:'blue'},{label:'기간 내 유입',value:income,icon:ArrowDownLeft,note:`입금 ${new Set(rows.filter(t=>t.direction==='in').map(t=>t.accounting_source_id??t.id)).size.toLocaleString()}건`,color:'green'},{label:'기간 내 유출',value:expense,icon:ArrowUpRight,note:`출금 ${new Set(rows.filter(t=>t.direction==='out').map(t=>t.accounting_source_id??t.id)).size.toLocaleString()}건`,color:'red'},{label:'순증감',value:income-expense,icon:ChartNoAxesCombined,note:'선택 기간 유입 − 유출',color:income-expense>=0?'green':'red'}].map(k=><article key={k.label} className={'kpi '+k.color}><div className="kpi-top"><span>{k.label}</span><span className="kpi-icon"><k.icon size={18}/></span></div><strong>{k.value===null?'잔액 확인 필요':won(k.value)}</strong><small>{k.note}</small></article>)}</div>{account==='all'&&<div className="available-strip"><div><span className="available-icon"><Wallet size={21}/></span><div><strong>30일 가용자금</strong><p>조회 종료일 잔액 − 이후 30일 예정 지출 − 유보액</p></div></div><strong>{won(available)}</strong><FinanceLink href={`/cash-utilization?biz=${encodeURIComponent(biz)}`}>자금 계획 보기<ArrowRight size={16}/></FinanceLink></div>}{balance===null&&<div className="info-line"><Info size={16}/><span>잔액 기준을 확인하세요. 미등록 잔액은 <FinanceLink href={`/settings/businesses?biz=${encodeURIComponent(biz)}`}>개시잔액과 개시일</FinanceLink>을 설정하고, 연결 오류는 원본 거래와 대조하세요.</span></div>}<AccountBalances data={data} businesses={pos} accounts={shownAccounts} rows={rows} asOf={fundsRange.to} useCollectedBalance={useCollectedBalance}/></>;
 const monthlyPanel=<Panel title="월별 현금흐름" action={<div className="chart-legend"><span><i style={{background:'#3a70e8'}}/>유입</span><span><i style={{background:'#bdccef'}}/>유출</span></div>}>{chart.length?<div className="chart-box"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chart} margin={{top:20,right:20,bottom:10,left:0}}><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--border)"/><XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} tickFormatter={v=>v.slice(2)}/><YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={70} fontSize={12}/><Tooltip formatter={(v)=>won(Number(v))}/><Bar dataKey="income" name="유입" fill="#3a70e8" radius={[4,4,0,0]} maxBarSize={23}/><Bar dataKey="expense" name="유출" fill="#bdccef" radius={[4,4,0,0]} maxBarSize={23}/><Line dataKey="net" name="순증감" stroke="#15a596" strokeWidth={2} dot={false}/></ComposedChart></ResponsiveContainer></div>:<NoData/>}</Panel>;
 const compositionPanel=<Panel title={consolidated?'사업자별 잔액 비중':'주요 지출 과목'} subtitle={consolidated?'확인된 통장 잔액의 양수 합계 기준':'내부 자금이동 제외'}>{consolidated&&pos.some(b=>b.balance!==null&&b.balance>0)?<><div className="donut-box"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={pos.filter(b=>b.balance!==null&&b.balance>0)} dataKey="balance" nameKey="name" innerRadius="62%" outerRadius="86%" paddingAngle={3}>{pos.filter(b=>b.balance!==null&&b.balance>0).map(b=><Cell key={b.id} fill={b.color}/>)}</Pie><Tooltip formatter={v=>won(Number(v))}/></PieChart></ResponsiveContainer></div><div className="donut-legend">{pos.map(b=><div key={b.id}><span><i style={{background:b.color}}/>{b.name}</span><strong>{won(b.balance)}</strong></div>)}</div></>:categories.length?<div className="expense-list">{categories.map((c,i)=><div key={c.name}><div><span><small>{String(i+1).padStart(2,'0')}</small>{c.name}</span><strong>{won(c.value)}</strong></div><div className="bar-track"><span style={{width:`${c.value/categories[0].value*100}%`,background:i===0?'#3a70e8':'#b4c8f7'}}/></div></div>)}</div>:<NoData title="분석할 자료가 없습니다" text="거래내역과 개시잔액을 입력해주세요."/>}</Panel>;
 const fundingPanel=<Panel title="사업자별 자금 계획" subtitle={`${fundsRange.to} 잔액 · 이후 30일 지출`} action={<FinanceLink className="text-link" href={`/settings/businesses?biz=${encodeURIComponent(biz)}`}>계좌 관리<ArrowRight size={15}/></FinanceLink>}><Table><TableHeader><TableRow><TableHead>사업자</TableHead><TableHead>대표 / 유형</TableHead><TableHead className="text-right">종료일 잔액</TableHead><TableHead className="text-right">예정 지출</TableHead><TableHead className="text-right">유보액</TableHead><TableHead className="text-right">가용자금</TableHead></TableRow></TableHeader><TableBody>{pos.map(b=><TableRow key={b.id}><TableCell><span className="company-name"><i style={{background:b.color}}/>{b.name}</span></TableCell><TableCell className="muted">{b.representative} · {b.kind}</TableCell><TableCell className="money">{won(b.balance)}</TableCell><TableCell className="money">{won(b.expenses)}</TableCell><TableCell className="money">{won(b.reserve)}</TableCell><TableCell className={'money '+(b.available!==null&&b.available<0?'negative':'positive')}>{won(b.available)}</TableCell></TableRow>)}</TableBody></Table></Panel>;
 const transferPanel=<Panel title="사업자 간 자금이동" subtitle="연결 확인된 이체 · 순이체액은 법적 대여잔액과 다를 수 있음" action={<Button variant="outline" size="sm" onClick={()=>setMatch(true)}><Plus size={15}/>내부거래 연결</Button>}>{flowLinks.length?<><div className="chart-box"><ResponsiveContainer width="100%" height="100%"><Sankey data={{nodes:flowNodes,links:flowLinks}} nodePadding={30} nodeWidth={10} margin={{top:20,bottom:20,left:30,right:30}} link={{stroke:'#7095ec'}}><Tooltip/></Sankey></ResponsiveContainer></div><TransferPositions data={{...data,businesses:transferBusinesses}} links={links}/><Table><TableHeader><TableRow><TableHead>보낸 사업자</TableHead><TableHead>받은 사업자</TableHead><TableHead>날짜</TableHead><TableHead className="text-right">이체액</TableHead><TableHead>연결</TableHead></TableRow></TableHeader><TableBody>{links.map(l=><TableRow key={l.link.id}><TableCell>{data.businesses.find(b=>b.id===l.out!.business_id)?.name}</TableCell><TableCell>{data.businesses.find(b=>b.id===l.incoming!.business_id)?.name}</TableCell><TableCell>{l.out!.txn_date}</TableCell><TableCell className="money">{won(l.out!.amount)}</TableCell><TableCell><Button variant="ghost" size="sm" onClick={()=>void action(async()=>{await api('/api/manage/links',{action:'delete',id:l.link.id});await refresh()})}>연결 해제</Button></TableCell></TableRow>)}</TableBody></Table></>:<NoData title="연결된 내부거래가 없습니다" text="서로 다른 사업자의 같은 금액 입출금을 연결해 자금이동을 확인하세요." href=""/>}</Panel>;
 const recentPanel=<Panel title="최근 거래" subtitle="선택한 기간의 최근 20건" action={<FinanceLink href={`/transactions?biz=${encodeURIComponent(biz)}`} className="text-link">전체 보기<ArrowRight size={15}/></FinanceLink>}>{recentRows.length?<Table><TableHeader><TableRow><TableHead>날짜</TableHead><TableHead>적요</TableHead><TableHead>계정과목</TableHead><TableHead className="text-right">입금</TableHead><TableHead className="text-right">출금</TableHead></TableRow></TableHeader><TableBody>{[...recentRows].sort((a,b)=>b.txn_date.localeCompare(a.txn_date)).slice(0,20).map(t=><TableRow key={t.id}><TableCell>{t.txn_date}</TableCell><TableCell>{t.description||'적요 없음'}</TableCell><TableCell><span className="category-tag">{data.categories.find(c=>c.id===t.category_id)?.name||'미매핑'}</span>{transferFeeDetails(data,t)&&<small className="block muted">이체 {won(t.amount-(t.transfer_fee_amount??0))} · 수수료 {won(t.transfer_fee_amount??0)}</small>}</TableCell><TableCell className="money positive">{t.direction==='in'?won(t.amount):'–'}</TableCell><TableCell className="money">{t.direction==='out'?won(t.amount):'–'}</TableCell></TableRow>)}</TableBody></Table>:<NoData/>}</Panel>;
 const section=(id:AnalysisSectionId,children:ReactNode,description?:string)=><AnalysisSection
  key={id} title={analysisSections.find(item=>item.value===id)!.label}
  overall={overall} override={sectionRanges[id]} bounds={bounds}
  visible={selectedSection==='all'||selectedSection===id} description={description}
  onChange={range=>setSectionRanges(current=>({...current,[id]:range}))}
  onReset={()=>setSectionRanges(current=>{const next={...current};delete next[id];return next;})}
 >{children}</AnalysisSection>;
 const spendingSection=(id:'categories'|'fixed'|'plans')=>{
  const range=rangeFor(id);
  return section(id,<SpendingAnalysis data={data} tx={sourceRows(range)} businesses={businesses} from={range.from} to={range.to} refresh={refresh} section={id}/>);
 };

 return <>
  <div className={consolidated?"view-options consolidated-options":"view-options"}><div className="toggle-label"><Switch id="external" checked={external} onCheckedChange={setExternal}/><label htmlFor="external">내부 자금이동 제외</label></div>{consolidated?<Picker value={representative} onChange={setRepresentative} label="대표자" options={[{value:'all',label:'대표자 전체'},...Array.from(new Set(data.businesses.map(b=>b.representative))).filter(Boolean).map(name=>({value:name,label:name+' 대표'}))]}/>:<Picker value={account} onChange={setAccount} label="계좌" options={[{value:'all',label:'전체 계좌'},...data.accounts.filter(a=>biz==='all'||a.business_id===biz).map(a=>({value:a.id,label:(biz==='all'?(data.businesses.find(b=>b.id===a.business_id)?.name+' · '):'')+accountLabel(a)}))]}/>}</div>
  {consolidated?<div className="consolidated-analysis">
   <div className="analysis-section-picker"><span>조회 부문</span><Picker label="조회 부문" value={selectedSection} onChange={setSelectedSection} options={[{value:'all',label:'전체 부문'},...analysisSections]}/><p>각 부문의 달력에서 기간을 바꿀 수 있습니다.</p></div>
   {section('funds',<>{fundsSummary}<div className="analysis-grid">{fundingPanel}{compositionPanel}</div></>,'입출금은 선택 기간 · 잔액은 종료일 기준')}
   {spendingSection('categories')}
   {spendingSection('fixed')}
   {spendingSection('plans')}
   {section('cashflow',<>{monthlyPanel}<OperatingSummary data={data} tx={rawCashflowRows}/></>)}
   {section('transfers',transferPanel,'선택 범위의 송금 또는 수금과 연결된 상대 거래 포함')}
  </div>:<>
   {fundsSummary}<div className="analysis-grid">{monthlyPanel}{compositionPanel}</div>
   <OperatingSummary data={data} tx={rawRows}/>{fundingPanel}{recentPanel}
  </>}
  <Dialog open={match} onOpenChange={setMatch}><DialogContent><DialogHeader><DialogTitle>내부거래 연결</DialogTitle><DialogDescription>다른 사업자의 같은 금액 출금·입금만 연결할 수 있습니다.</DialogDescription></DialogHeader><label>보낸 거래</label><Picker label="출금 거래" value={out} onChange={v=>{setOut(v);setIncoming('')}} options={possibleOut.map(t=>({value:t.id,label:`${t.txn_date} · ${data.businesses.find(b=>b.id===t.business_id)?.name} · ${won(t.amount)}`}))}/><label>받은 거래</label><Picker label="입금 거래" value={incoming} onChange={setIncoming} options={possibleIn.map(t=>({value:t.id,label:`${t.txn_date} · ${data.businesses.find(b=>b.id===t.business_id)?.name} · ${won(t.amount)}`}))}/><Button disabled={!out||!incoming} onClick={()=>void action(async()=>{await api('/api/manage/links',{data:{out_transaction_id:out,in_transaction_id:incoming}});setMatch(false);await refresh();toast.success('내부거래를 연결했습니다.')})}>연결 저장</Button></DialogContent></Dialog>
 </>;
}
