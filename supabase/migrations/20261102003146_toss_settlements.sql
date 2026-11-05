begin;

-- PG expectations are isolated from the bank ledger and its cash balances.
create table private.fd_toss_merchants(
 owner_id uuid not null references auth.users(id) on delete restrict,
 merchant_id text not null check(length(merchant_id) between 1 and 100),
 business_id uuid not null,account_id uuid not null,label text not null check(length(label) between 1 and 100),
 primary key(owner_id,merchant_id),unique(owner_id,merchant_id,business_id,account_id),
 foreign key(owner_id,business_id,account_id) references public.fd_accounts(owner_id,business_id,id) on delete restrict
);
create table private.fd_toss_settlements(
 owner_id uuid not null,merchant_id text not null,transaction_key text not null check(length(transaction_key) between 1 and 200),
 payment_key text not null check(length(payment_key) between 1 and 200),business_id uuid not null,account_id uuid not null,
 paid_out_date date not null,sold_date date not null,amount bigint not null,pay_out_amount bigint not null,fee_amount bigint not null,
 synced_at timestamptz not null,
 primary key(owner_id,merchant_id,transaction_key),
 foreign key(owner_id,merchant_id,business_id,account_id) references private.fd_toss_merchants(owner_id,merchant_id,business_id,account_id) on delete restrict,
 check(abs(amount::numeric)<=9007199254740991 and abs(pay_out_amount::numeric)<=9007199254740991 and abs(fee_amount::numeric)<=9007199254740991)
);
create index fd_toss_settlements_date on private.fd_toss_settlements(owner_id,paid_out_date);
create table private.fd_toss_sync_state(
 owner_id uuid primary key references auth.users(id) on delete restrict,run_id uuid not null,
 started_at timestamptz not null,active boolean not null default false,completed_at timestamptz,range_from date,range_to date
);
alter table private.fd_toss_merchants enable row level security;
alter table private.fd_toss_settlements enable row level security;
alter table private.fd_toss_sync_state enable row level security;
revoke all on private.fd_toss_merchants,private.fd_toss_settlements,private.fd_toss_sync_state from public,anon,authenticated;

create function private.fd_toss_settlements_read() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if (select count(*) from private.fd_toss_settlements where owner_id=workspace_owner)>100000 then raise exception 'TOSS_STORAGE';end if;
 return jsonb_build_object(
  'merchants',(select coalesce(jsonb_agg(jsonb_build_object('merchantId',merchant_id,'businessId',business_id,'accountId',account_id,'label',label) order by merchant_id),'[]'::jsonb) from private.fd_toss_merchants where owner_id=workspace_owner),
  'settlements',(select coalesce(jsonb_agg(to_jsonb(s)-'owner_id' order by s.paid_out_date,s.merchant_id,s.transaction_key),'[]'::jsonb) from private.fd_toss_settlements s where s.owner_id=workspace_owner),
  'lastSyncedAt',(select completed_at from private.fd_toss_sync_state where owner_id=workspace_owner),
  'range',(select case when range_from is not null then jsonb_build_object('from',range_from,'to',range_to) else null end from private.fd_toss_sync_state where owner_id=workspace_owner)
 );
end $$;
revoke all on function private.fd_toss_settlements_read() from public,anon,authenticated;
grant execute on function private.fd_toss_settlements_read() to authenticated;
create function public.fd_toss_settlements_read() returns jsonb
language sql stable security invoker set search_path='' as $$select private.fd_toss_settlements_read()$$;
revoke all on function public.fd_toss_settlements_read() from public,anon,authenticated;
grant execute on function public.fd_toss_settlements_read() to authenticated;

create function private.fd_toss_settlements_sync_core(p_action text,p_payload text,p_proof text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();workspace_owner uuid:=private.finance_workspace_owner();secret bytea;body jsonb;r jsonb;m jsonb;
 run uuid;issued timestamptz;state private.fd_toss_sync_state;from_date date;to_date date;completed timestamptz;saved integer;
begin
 if actor is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_action is null or p_action not in ('claim','save','release') or p_payload is null or octet_length(p_payload)>12582912
  or p_proof is null or p_proof !~ '^[a-f0-9]{64}$' then raise exception 'TOSS_INVALID_REQUEST';end if;
 select decode(signing_key,'base64') into secret from private.fd_clobe_import_verifier where singleton;
 if secret is null then raise exception 'TOSS_CONFIGURATION';end if;
 if p_proof<>private.fd_clobe_import_hmac('merlin:clobe-import:v1'||E'\n'||'toss-settlements-'||p_action||E'\n'||actor::text||E'\n'||workspace_owner::text||E'\n'||p_payload,secret) then raise exception 'TOSS_UNTRUSTED';end if;
 body:=p_payload::jsonb;
 if jsonb_typeof(body) is distinct from 'object' or not(body?&array['run_id','issued_at'])
  or jsonb_typeof(body->'run_id') is distinct from 'string' or jsonb_typeof(body->'issued_at') is distinct from 'string' then raise exception 'TOSS_INVALID_REQUEST';end if;
 run:=(body->>'run_id')::uuid;issued:=(body->>'issued_at')::timestamptz;
 if issued<clock_timestamp()-interval '6 minutes' or issued>clock_timestamp()+interval '1 minute' then raise exception 'TOSS_INVALID_REQUEST';end if;
 perform pg_advisory_xact_lock(hashtextextended('fd_toss_sync:'||workspace_owner::text,0));
 select * into state from private.fd_toss_sync_state where owner_id=workspace_owner for update;
 if p_action='claim' then
  if exists(select 1 from jsonb_object_keys(body) k where k not in ('run_id','issued_at')) then raise exception 'TOSS_INVALID_REQUEST';end if;
  if state.owner_id is not null and (state.active and state.started_at>clock_timestamp()-interval '5 minutes' or state.started_at>clock_timestamp()-interval '20 seconds') then raise exception 'TOSS_BUSY';end if;
  insert into private.fd_toss_sync_state(owner_id,run_id,started_at,active) values(workspace_owner,run,clock_timestamp(),true)
   on conflict(owner_id) do update set run_id=excluded.run_id,started_at=excluded.started_at,active=true;
  return jsonb_build_object('claimed',true);
 end if;
 if state.owner_id is null or state.run_id<>run or not state.active or state.started_at<clock_timestamp()-interval '5 minutes' then raise exception 'TOSS_BUSY';end if;
 if p_action='release' then
  if exists(select 1 from jsonb_object_keys(body) k where k not in ('run_id','issued_at')) then raise exception 'TOSS_INVALID_REQUEST';end if;
  -- Preserve the last successful completion/date range on failed fetches.
  update private.fd_toss_sync_state set active=false where owner_id=workspace_owner;
  return jsonb_build_object('released',true);
 end if;
 if not(body?&array['from','to','merchants','settlements']) or exists(select 1 from jsonb_object_keys(body) k where k not in ('run_id','issued_at','from','to','merchants','settlements'))
  or jsonb_typeof(body->'merchants') is distinct from 'array' or jsonb_array_length(body->'merchants') not between 1 and 20
  or jsonb_typeof(body->'settlements') is distinct from 'array' or jsonb_array_length(body->'settlements')>20000 then raise exception 'TOSS_INVALID_REQUEST';end if;
 from_date:=(body->>'from')::date;to_date:=(body->>'to')::date;completed:=clock_timestamp();
 if from_date is null or to_date is null or from_date>to_date or to_date-from_date>210 or from_date<'2000-01-01' or to_date>'2100-12-31' then raise exception 'TOSS_INVALID_REQUEST';end if;
 if (select count(distinct v->>'merchantId') from jsonb_array_elements(body->'merchants') v)<>jsonb_array_length(body->'merchants')
  or (select count(distinct jsonb_build_array(v->>'merchant_id',v->>'transaction_key')) from jsonb_array_elements(body->'settlements') v)<>jsonb_array_length(body->'settlements') then raise exception 'TOSS_INVALID_REQUEST';end if;
 for m in select value from jsonb_array_elements(body->'merchants') loop
  if jsonb_typeof(m) is distinct from 'object' or not(m?&array['merchantId','businessId','accountId','label'])
   or exists(select 1 from jsonb_object_keys(m) k where k not in ('merchantId','businessId','accountId','label'))
   or jsonb_typeof(m->'merchantId') is distinct from 'string' or coalesce(m->>'merchantId','') !~ '^[A-Za-z0-9_-]{1,100}$'
   or jsonb_typeof(m->'label') is distinct from 'string' or length(m->>'label') not between 1 and 100
   or not exists(select 1 from public.fd_accounts a where a.owner_id=workspace_owner and a.id=(m->>'accountId')::uuid and a.business_id=(m->>'businessId')::uuid)
   or exists(select 1 from private.fd_toss_merchants old where old.owner_id=workspace_owner and old.merchant_id=m->>'merchantId' and (old.account_id<>(m->>'accountId')::uuid or old.business_id<>(m->>'businessId')::uuid)) then raise exception 'TOSS_SCOPE';end if;
 end loop;
 for r in select value from jsonb_array_elements(body->'settlements') loop
  if jsonb_typeof(r) is distinct from 'object' or not(r?&array['merchant_id','transaction_key','payment_key','business_id','account_id','paid_out_date','sold_date','amount','pay_out_amount','fee_amount','synced_at'])
   or exists(select 1 from jsonb_object_keys(r) k where k not in ('merchant_id','transaction_key','payment_key','business_id','account_id','paid_out_date','sold_date','amount','pay_out_amount','fee_amount','synced_at'))
   or jsonb_typeof(r->'transaction_key') is distinct from 'string' or length(r->>'transaction_key') not between 1 and 200
   or jsonb_typeof(r->'payment_key') is distinct from 'string' or length(r->>'payment_key') not between 1 and 200
   or jsonb_typeof(r->'amount') is distinct from 'number' or coalesce(r->>'amount','') !~ '^-?(0|[1-9][0-9]{0,15})$' or abs((r->>'amount')::numeric)>9007199254740991
   or jsonb_typeof(r->'pay_out_amount') is distinct from 'number' or coalesce(r->>'pay_out_amount','') !~ '^-?(0|[1-9][0-9]{0,15})$' or abs((r->>'pay_out_amount')::numeric)>9007199254740991
   or jsonb_typeof(r->'fee_amount') is distinct from 'number' or coalesce(r->>'fee_amount','') !~ '^-?(0|[1-9][0-9]{0,15})$' or abs((r->>'fee_amount')::numeric)>9007199254740991
   or (r->>'paid_out_date')::date not between from_date and to_date or (r->>'sold_date')::date not between '2000-01-01'::date and '2100-12-31'::date
   or (r->>'synced_at')::timestamptz<state.started_at-interval '1 minute' or (r->>'synced_at')::timestamptz>completed+interval '1 minute'
   or not exists(select 1 from jsonb_array_elements(body->'merchants') v where v->>'merchantId'=r->>'merchant_id' and v->>'accountId'=r->>'account_id' and v->>'businessId'=r->>'business_id') then raise exception 'TOSS_INVALID_REQUEST';end if;
 end loop;
 -- Only a complete, server-signed range can replace this PG planning source.
 -- The authoritative bank ledger, categories, notes and balances are untouched.
 for m in select value from jsonb_array_elements(body->'merchants') loop
  insert into private.fd_toss_merchants(owner_id,merchant_id,business_id,account_id,label) values(workspace_owner,m->>'merchantId',(m->>'businessId')::uuid,(m->>'accountId')::uuid,m->>'label')
   on conflict(owner_id,merchant_id) do update set label=excluded.label;
 end loop;
 delete from private.fd_toss_settlements s where s.owner_id=workspace_owner and s.paid_out_date between from_date and to_date
  and s.merchant_id in(select v->>'merchantId' from jsonb_array_elements(body->'merchants') v)
  and not exists(select 1 from jsonb_array_elements(body->'settlements') v where v->>'merchant_id'=s.merchant_id and v->>'transaction_key'=s.transaction_key);
 for r in select value from jsonb_array_elements(body->'settlements') loop
  insert into private.fd_toss_settlements(owner_id,merchant_id,transaction_key,payment_key,business_id,account_id,paid_out_date,sold_date,amount,pay_out_amount,fee_amount,synced_at)
   values(workspace_owner,r->>'merchant_id',r->>'transaction_key',r->>'payment_key',(r->>'business_id')::uuid,(r->>'account_id')::uuid,(r->>'paid_out_date')::date,(r->>'sold_date')::date,(r->>'amount')::bigint,(r->>'pay_out_amount')::bigint,(r->>'fee_amount')::bigint,(r->>'synced_at')::timestamptz)
   on conflict(owner_id,merchant_id,transaction_key) do update set payment_key=excluded.payment_key,paid_out_date=excluded.paid_out_date,sold_date=excluded.sold_date,amount=excluded.amount,pay_out_amount=excluded.pay_out_amount,fee_amount=excluded.fee_amount,synced_at=excluded.synced_at;
 end loop;
 saved:=jsonb_array_length(body->'settlements');
 update private.fd_toss_sync_state set active=false,completed_at=completed,range_from=from_date,range_to=to_date where owner_id=workspace_owner;
 insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'toss_settlement_sync','토스 정산 조회 '||saved||'건 · 통장 거래/분류/잔액 변경 0건');
 return jsonb_build_object('saved',saved,'from',from_date,'to',to_date);
end $$;
revoke all on function private.fd_toss_settlements_sync_core(text,text,text) from public,anon,authenticated;
grant execute on function private.fd_toss_settlements_sync_core(text,text,text) to authenticated;
create function public.fd_toss_settlements_sync(p_action text,p_payload text,p_proof text) returns jsonb
language sql security invoker set search_path='' as $$select private.fd_toss_settlements_sync_core(p_action,p_payload,p_proof)$$;
revoke all on function public.fd_toss_settlements_sync(text,text,text) from public,anon,authenticated;
grant execute on function public.fd_toss_settlements_sync(text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
