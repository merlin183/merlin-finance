import {Fragment} from 'react';
import Link from 'next/link';
import {ArrowRight} from 'lucide-react';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {accountSnapshot} from '@/lib/finance/balances';
import {won} from '@/lib/finance/format';
import type {Account,Business,Dataset,Transaction} from '@/lib/finance/types';
import {Panel} from './common';

export function accountLabel(account:Account){
 return [account.name,account.bank&&!account.name.includes(account.bank)?account.bank:'',account.masked_number&&!account.name.includes(account.masked_number)?account.masked_number:''].filter(Boolean).join(' · ');
}
export function AccountBalances({data,businesses,accounts,rows,asOf,useCollectedBalance=false}:{data:Dataset;businesses:Business[];accounts:Account[];rows:Transaction[];asOf:string;useCollectedBalance?:boolean}){
 return <Panel title="통장별 자금 현황" subtitle={`${asOf}까지의 거래·동기화 잔액 기준 · 입출금은 선택 기간, 잔액은 종료일 기준입니다.`} action={<Link className="text-link" href="/settings/businesses">계좌 관리<ArrowRight size={15}/></Link>}>
  <Table><TableHeader><TableRow><TableHead>사업자 / 통장</TableHead><TableHead>잔액 기준</TableHead><TableHead className="text-right">기간 입금</TableHead><TableHead className="text-right">기간 출금</TableHead><TableHead className="text-right">잔액</TableHead></TableRow></TableHeader><TableBody>
   {businesses.map(b=>{
    const bankRows=accounts.filter(a=>a.business_id===b.id).map(a=>({account:a,snapshot:accountSnapshot(a,data.transactions,asOf,useCollectedBalance?data.balance_snapshots:undefined),income:rows.filter(t=>t.account_id===a.id&&t.direction==='in').reduce((s,t)=>s+t.amount,0),expense:rows.filter(t=>t.account_id===a.id&&t.direction==='out').reduce((s,t)=>s+t.amount,0)}));
    if(!bankRows.length)return null;
    const complete=bankRows.every(r=>r.snapshot.balance!==null);
    return <Fragment key={b.id}><TableRow className="bg-muted/40"><TableCell><span className="company-name"><i style={{background:b.color}}/>{b.name}</span><small className="muted ml-2">통장 {bankRows.length}개</small></TableCell><TableCell className="muted">표시 통장 합계</TableCell><TableCell className="money">{won(bankRows.reduce((s,r)=>s+r.income,0))}</TableCell><TableCell className="money">{won(bankRows.reduce((s,r)=>s+r.expense,0))}</TableCell><TableCell className="money font-semibold">{complete?won(bankRows.reduce((s,r)=>s+r.snapshot.balance!,0)):'잔액 확인 필요'}</TableCell></TableRow>
     {bankRows.map(({account:a,snapshot:s,income,expense})=><TableRow key={a.id}><TableCell className="pl-8 font-medium">{accountLabel(a)}</TableCell><TableCell><span className={s.balance===null?'negative':'muted'}>{s.source==='clobe'?'Clobe 수집 잔액':s.source==='statement'?'통장 거래 후 잔액':s.source==='conflict'?'원본 확인 필요':s.source==='unavailable'?'잔액 자료 없음':'계산 잔액'}{s.date&&` · ${s.date}`}</span><small className="block muted" title={s.message}>{s.source==='statement'?'이후 거래는 아직 반영되지 않았습니다.':s.message}</small></TableCell><TableCell className="money positive">{won(income)}</TableCell><TableCell className="money">{won(expense)}</TableCell><TableCell className="money font-semibold">{s.balance===null?'확인 필요':won(s.balance)}</TableCell></TableRow>)}
    </Fragment>;
   })}
   {!accounts.length&&<TableRow><TableCell colSpan={5}>표시할 통장이 없습니다. 계좌 관리에서 통장을 추가하세요.</TableCell></TableRow>}
  </TableBody></Table>
 </Panel>;
}
