begin;

-- Raw bank/source text is display metadata, never part of the transaction's
-- existing description, merchant-note subject, category rule, or dedup hash.
alter table public.fd_transactions add column source_details jsonb default null;

create function private.fd_valid_source_details(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare field text; provenance jsonb;
begin
 if value is null or value='null'::jsonb then return true;end if;
 if jsonb_typeof(value) is distinct from 'object' then return false;end if;
 if exists(select 1 from jsonb_object_keys(value) k where k not in ('basic','detail','counterparty','record','memo','note','provenance')) then return false;end if;
 foreach field in array array['basic','detail','counterparty','record','memo','note'] loop
  if value ? field and (jsonb_typeof(value->field) is distinct from 'string' or length(value->>field)>1000) then return false;end if;
 end loop;
 if value ? 'provenance' then
  provenance:=value->'provenance';
  if jsonb_typeof(provenance) is distinct from 'object' then return false;end if;
  if not (provenance ?& array['sheet','row']) or exists(select 1 from jsonb_object_keys(provenance) k where k not in ('sheet','row','url')) then return false;end if;
  if jsonb_typeof(provenance->'sheet') is distinct from 'string' or length(btrim(provenance->>'sheet')) not between 1 and 200 then return false;end if;
  if jsonb_typeof(provenance->'row') is distinct from 'number' or coalesce(provenance->>'row','') !~ '^[1-9][0-9]{0,9}$' then return false;end if;
  if (provenance->>'row')::numeric>2147483647 then return false;end if;
  if provenance ? 'url' and (jsonb_typeof(provenance->'url') is distinct from 'string' or length(provenance->>'url') not between 1 and 2000 or (provenance->>'url') !~ '^https://[^[:space:]]+$') then return false;end if;
 end if;
 return true;
end $$;
revoke all on function private.fd_valid_source_details(jsonb) from public,anon;
grant execute on function private.fd_valid_source_details(jsonb) to authenticated;
alter table public.fd_transactions add constraint fd_transactions_source_details_valid check(private.fd_valid_source_details(source_details));

-- Missing, null, empty, or whitespace-only input cannot erase saved details.
-- A supplied nonempty field may replace its previous source value. Provenance
-- describes the most recent supplied source; it is replaced as one object.
create function private.fd_merge_source_details(previous jsonb,incoming jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare answer jsonb:=coalesce(nullif(previous,'null'::jsonb),'{}'::jsonb);field text;has_text boolean:=false;
begin
 if not private.fd_valid_source_details(incoming) then raise exception 'SOURCE_DETAILS_INVALID';end if;
 if incoming is null or incoming='null'::jsonb then return nullif(answer,'{}'::jsonb);end if;
 foreach field in array array['basic','detail','counterparty','record','memo','note'] loop
  if incoming ? field and (incoming->>field) ~ '[^[:space:]]' then
   answer:=jsonb_set(answer,array[field],incoming->field);has_text:=true;
  end if;
 end loop;
 -- Location-only metadata is useful on a new row, but a blank re-export must
 -- not replace the provenance of previously saved nonempty source details.
 if (has_text or answer='{}'::jsonb) and incoming ? 'provenance' then answer:=jsonb_set(answer,'{provenance}',incoming->'provenance');end if;
 return nullif(answer,'{}'::jsonb);
end $$;
revoke all on function private.fd_merge_source_details(jsonb,jsonb) from public,anon;
grant execute on function private.fd_merge_source_details(jsonb,jsonb) to authenticated;

create function private.fd_preserve_source_details() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' then new.source_details:=private.fd_merge_source_details(old.source_details,new.source_details);
 else new.source_details:=private.fd_merge_source_details(null,new.source_details);end if;
 return new;
end $$;
revoke all on function private.fd_preserve_source_details() from public,anon,authenticated;
create trigger fd_preserve_source_details before insert or update of source_details on public.fd_transactions
 for each row execute function private.fd_preserve_source_details();

create function public.fd_update_transaction_source_details(p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();requested integer;updated integer;account uuid;
 required_expected text[]:=array['account_id','txn_date','amount','direction','description','dedup_hash','source_details'];
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'SOURCE_DETAILS_INVALID_BATCH';end if;
 requested:=jsonb_array_length(p_changes);
 if requested<1 or requested>20000 then raise exception 'SOURCE_DETAILS_INVALID_BATCH';end if;
 if exists(select 1 from jsonb_array_elements(p_changes) c where jsonb_typeof(c) is distinct from 'object') then raise exception 'SOURCE_DETAILS_INVALID_CHANGE';end if;
 if exists(select 1 from jsonb_array_elements(p_changes) c where not (c ?& array['id','expected','source_details'])
  or exists(select 1 from jsonb_object_keys(c) k where k not in ('id','expected','source_details'))
  or jsonb_typeof(c->'id') is distinct from 'string' or jsonb_typeof(c->'expected') is distinct from 'object'
  or not (c->'expected' ?& required_expected) or not private.fd_valid_source_details(c->'source_details'))
 then raise exception 'SOURCE_DETAILS_INVALID_CHANGE';end if;
 if (select count(distinct (c->>'id')::uuid) from jsonb_array_elements(p_changes) c)<>requested then raise exception 'SOURCE_DETAILS_DUPLICATE_ID';end if;

 -- Derive locks only from accessible stored transactions, never caller-owned
 -- account/owner values. Account row locks also serialize with existing note
 -- writers, while the advisory lock namespace is shared by both import RPCs.
 for account in select distinct t.account_id from public.fd_transactions t
  join jsonb_array_elements(p_changes) c on t.id=(c->>'id')::uuid
  where t.owner_id=workspace_owner order by t.account_id loop
  perform pg_advisory_xact_lock(hashtextextended('fd_account:'||account::text,0));
 end loop;
 perform a.id from public.fd_accounts a where a.owner_id=workspace_owner
  and a.id in(select t.account_id from public.fd_transactions t join jsonb_array_elements(p_changes) c on t.id=(c->>'id')::uuid where t.owner_id=workspace_owner)
 order by a.id for update;
 perform t.id from public.fd_transactions t join jsonb_array_elements(p_changes) c on t.id=(c->>'id')::uuid
 where t.owner_id=workspace_owner order by t.id for update of t;
 if (select count(*) from public.fd_transactions t join jsonb_array_elements(p_changes) c on t.id=(c->>'id')::uuid
  where t.owner_id=workspace_owner and to_jsonb(t) @> (c->'expected')
   and coalesce(t.source_details,'null'::jsonb) is not distinct from c->'expected'->'source_details')<>requested
 then raise exception 'SOURCE_DETAILS_STALE';end if;

 update public.fd_transactions t set source_details=private.fd_merge_source_details(t.source_details,c.source_details)
 from jsonb_to_recordset(p_changes) c(id uuid,source_details jsonb)
 where t.id=c.id and t.owner_id=workspace_owner
  and t.source_details is distinct from private.fd_merge_source_details(t.source_details,c.source_details);
 get diagnostics updated=row_count;
 if updated>0 then
  insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'원본 거래 내역 보완',format('기존 거래 %s건의 원본 내역만 보완 · 금융값·분류·업로드 연결 유지',updated));
 end if;
 return jsonb_build_object('updated',updated,'unchanged',requested-updated);
end $$;
revoke all on function public.fd_update_transaction_source_details(jsonb) from public,anon;
grant execute on function public.fd_update_transaction_source_details(jsonb) to authenticated;

-- Preserve file-import identity and duplicate behavior; metadata is stored for
-- newly imported rows without changing previously uploaded transactions.
create or replace function public.fd_import_transactions(p_account uuid,p_upload uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();business uuid;inserted integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('fd_account:'||p_account::text,0));
 select business_id into strict business from public.fd_accounts where id=p_account and owner_id=workspace_owner for update;
 if not exists(select 1 from public.fd_uploads where id=p_upload and account_id=p_account and owner_id=workspace_owner) then raise exception 'Upload account mismatch';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>500 then raise exception 'Invalid batch';end if;
 insert into public.fd_transactions(owner_id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,source_details)
 select workspace_owner,business,p_account,p_upload,x.txn_date,x.txn_time,x.source_sheet,x.source_row,x.amount,x.direction,x.description,x.raw_gwamok,x.category_id,x.is_internal,x.balance,x.tax_invoice,
 case when x.balance is not null then encode(sha256(convert_to(concat_ws('|','v2',p_account::text,x.txn_date::text,x.amount::text,x.direction,x.description,x.balance::text),'UTF8')),'hex') else x.dedup_hash end,x.source_details
 from jsonb_to_recordset(p_rows) x(txn_date date,txn_time text,source_sheet text,source_row integer,amount bigint,direction text,description text,raw_gwamok text,category_id uuid,is_internal boolean,balance bigint,tax_invoice boolean,dedup_hash text,source_details jsonb)
 on conflict(account_id,dedup_hash) do nothing;
 get diagnostics inserted=row_count;return inserted;
end $$;
revoke all on function public.fd_import_transactions(uuid,uuid,jsonb) from public,anon;
grant execute on function public.fd_import_transactions(uuid,uuid,jsonb) to authenticated;

-- Extend the existing sheet RPC without changing its financial validation,
-- idempotency, duplicate/reference checks, or journal format. Every expected
-- anchor is checked so an incompatible prior definition fails the migration.
do $$
declare definition text;old text;replacement text;pair record;
begin
 definition:=replace(pg_get_functiondef('public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb)'::regprocedure),E'\r\n',E'\n');
 for pair in select * from (values
  ($old${"txn_time":null,"source_sheet":null,"source_row":null}$old$,$new${"txn_time":null,"source_sheet":null,"source_row":null,"source_details":null}$new$),
  ($old$ perform a.id from public.fd_accounts a
 join (select distinct (c->>'account_id')::uuid id from jsonb_array_elements(p_changes) c) wanted on wanted.id=a.id$old$,
   $new$ perform pg_advisory_xact_lock(hashtextextended('fd_account:'||a.id::text,0)) from public.fd_accounts a
 join (select distinct (c->>'account_id')::uuid id from jsonb_array_elements(p_changes) c) wanted on wanted.id=a.id
 where a.owner_id=workspace_owner order by a.id;
 perform a.id from public.fd_accounts a
 join (select distinct (c->>'account_id')::uuid id from jsonb_array_elements(p_changes) c) wanted on wanted.id=a.id$new$),
  ($old$incoming:=jsonb_populate_record(null::public.fd_transactions,(change->'row')-array['id','owner_id','business_id','account_id','upload_id','created_at']);$old$,
   $new$incoming:=jsonb_populate_record(null::public.fd_transactions,(change->'row')-array['id','owner_id','business_id','account_id','upload_id','created_at']);
  incoming.source_details:=private.fd_merge_source_details((select t.source_details from public.fd_transactions t where t.id=target_id and t.owner_id=workspace_owner),incoming.source_details);$new$),
  ($old$or not (to_jsonb(existing) @> expected)$old$,
   $new$or not (to_jsonb(existing) @> expected) or coalesce(existing.source_details,'null'::jsonb) is distinct from expected->'source_details'$new$),
  ($old$or not (to_jsonb(extra) @> duplicate_expected)$old$,
   $new$or not (to_jsonb(extra) @> duplicate_expected) or coalesce(extra.source_details,'null'::jsonb) is distinct from duplicate_expected->'source_details'$new$),
  ($old$   if exists(select 1 from public.fd_inter_company_links l where l.owner_id=workspace_owner and (l.out_transaction_id=extra.id or l.in_transaction_id=extra.id))$old$,
   $new$   if not (coalesce(extra.source_details-'provenance','{}'::jsonb) <@ coalesce(incoming.source_details-'provenance','{}'::jsonb)) then raise exception 'SHEET_DUPLICATE_SOURCE_DETAILS';end if;
   if exists(select 1 from public.fd_inter_company_links l where l.owner_id=workspace_owner and (l.out_transaction_id=extra.id or l.in_transaction_id=extra.id))$new$),
  ($old$dedup_hash,manually_classified)
   values$old$,$new$dedup_hash,manually_classified,source_details)
   values$new$),
  ($old$incoming.tax_invoice,incoming.dedup_hash,incoming.manually_classified);$old$,$new$incoming.tax_invoice,incoming.dedup_hash,incoming.manually_classified,incoming.source_details);$new$),
  ($old$tax_invoice=incoming.tax_invoice,dedup_hash=incoming.dedup_hash,manually_classified=incoming.manually_classified$old$,
   $new$tax_invoice=incoming.tax_invoice,dedup_hash=incoming.dedup_hash,manually_classified=incoming.manually_classified,source_details=incoming.source_details$new$),
  ($old$t.tax_invoice,t.dedup_hash,t.manually_classified)$old$,$new$t.tax_invoice,t.dedup_hash,t.manually_classified,t.source_details)$new$)
 ) patches(original,modified) loop
  -- SQL Editor may normalize pasted dollar-quoted strings to CRLF too.
  old:=replace(pair.original,E'\r\n',E'\n');replacement:=replace(pair.modified,E'\r\n',E'\n');
  if strpos(definition,old)=0 then
   raise exception 'SOURCE_DETAILS_MIGRATION_ANCHOR_MISSING: %',left(old,100);
  end if;
  definition:=replace(definition,old,replacement);
 end loop;
 execute definition;
end $$;
notify pgrst,'reload schema';
commit;
