import type {Dataset,Transaction} from '@/lib/finance/types';
import {won} from '@/lib/finance/format';
import {accountingTransactions} from '@/lib/finance/transaction-accounting';
import {Panel} from './common';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
export function OperatingSummary({data,tx}:{data:Dataset;tx:Transaction[]}){
 const operating=accountingTransactions(data,tx,true).filter(t=>data.categories.find(c=>c.id===t.category_id)?.is_operating);
 const rows=data.businesses.filter(b=>tx.some(t=>t.business_id===b.id)).map(b=>{const income=operating.filter(t=>t.business_id===b.id&&t.direction==='in').reduce((s,t)=>s+t.amount,0);const expense=operating.filter(t=>t.business_id===b.id&&t.direction==='out').reduce((s,t)=>s+t.amount,0);return {...b,income,expense}});
 if(!rows.length)return null;
 return <Panel title="현금 기준 영업수지" subtitle="영업·조정 과목 현금 입출금 · 투자·재무·내부이동·미분류 제외 · 회계 손익과 다름"><Table><TableHeader><TableRow><TableHead>사업자</TableHead><TableHead className="text-right">영업 유입</TableHead><TableHead className="text-right">영업 유출</TableHead><TableHead className="text-right">영업 순현금</TableHead></TableRow></TableHeader><TableBody>{rows.map(b=><TableRow key={b.id}><TableCell><span className="company-name"><i style={{background:b.color}}/>{b.name}</span></TableCell><TableCell className="money">{won(b.income)}</TableCell><TableCell className="money">{won(b.expense)}</TableCell><TableCell className={'money '+(b.income-b.expense<0?'negative':'positive')}>{won(b.income-b.expense)}</TableCell></TableRow>)}</TableBody></Table></Panel>;
}
export function TransferPositions({data,links}:{data:Dataset;links:{out?:Transaction;incoming?:Transaction}[]}){
 const rows=data.businesses.map(b=>{const sent=links.filter(l=>l.out?.business_id===b.id).reduce((s,l)=>s+(l.out?.amount||0),0);const received=links.filter(l=>l.incoming?.business_id===b.id).reduce((s,l)=>s+(l.incoming?.amount||0),0);return {...b,sent,received}});
 return <Table><TableHeader><TableRow><TableHead>사업자</TableHead><TableHead className="text-right">내부 출금</TableHead><TableHead className="text-right">내부 입금</TableHead><TableHead className="text-right">순유출 (출금 − 입금)</TableHead></TableRow></TableHeader><TableBody>{rows.map(b=><TableRow key={b.id}><TableCell>{b.name}</TableCell><TableCell className="money">{won(b.sent)}</TableCell><TableCell className="money">{won(b.received)}</TableCell><TableCell className="money">{won(b.sent-b.received)}</TableCell></TableRow>)}</TableBody></Table>;
}
