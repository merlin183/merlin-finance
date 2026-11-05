begin;

-- Bank providers may change fixed-width padding or fill a previously empty
-- counterparty label. These are comparison rules only: store the raw new text.
create function private.fd_clobe_plan_source_text(p_value text) returns text
language sql immutable security invoker set search_path='' as $$
 select btrim(regexp_replace(coalesce(p_value,''),'[[:space:]]+',' ','g'));
$$;

create function private.fd_clobe_plan_source_compatible(p_previous jsonb,p_next jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 with labels as (
  select private.fd_clobe_plan_source_text(p_previous->>'party') old_party,
   private.fd_clobe_plan_source_text(p_next->>'party') new_party,
   private.fd_clobe_plan_source_text(p_previous#>>'{source_details,counterparty}') old_counterparty,
   private.fd_clobe_plan_source_text(p_next#>>'{source_details,counterparty}') new_counterparty
 )
 select case
  when jsonb_typeof(p_previous) is distinct from 'object' or jsonb_typeof(p_next) is distinct from 'object' then false
  -- Every financial field, original bank ID and any unknown top-level field
  -- must match exactly. Never infer identity from a similar recipient name.
  when (p_previous-array['description','party','source_details']) is distinct from (p_next-array['description','party','source_details']) then false
  when (coalesce(nullif(p_previous->'source_details','null'::jsonb),'{}'::jsonb)-array['basic','detail','counterparty'])
   is distinct from (coalesce(nullif(p_next->'source_details','null'::jsonb),'{}'::jsonb)-array['basic','detail','counterparty']) then false
  else private.fd_clobe_plan_source_text(p_previous->>'description')=private.fd_clobe_plan_source_text(p_next->>'description')
   and private.fd_clobe_plan_source_text(p_previous#>>'{source_details,basic}')=private.fd_clobe_plan_source_text(p_next#>>'{source_details,basic}')
   and private.fd_clobe_plan_source_text(p_previous#>>'{source_details,detail}')=private.fd_clobe_plan_source_text(p_next#>>'{source_details,detail}')
   and (old_party='' or new_party=old_party)
   and (old_counterparty='' or new_counterparty=old_counterparty)
   -- A newly supplied party/counterparty must not contradict another known
   -- label. Existing exactly preserved labels remain valid for compatibility.
   and ((old_party<>'' and old_counterparty<>'') or new_party='' or new_counterparty='' or new_party=new_counterparty)
 end from labels;
$$;
revoke all on function private.fd_clobe_plan_source_text(text),private.fd_clobe_plan_source_compatible(jsonb,jsonb) from public,anon,authenticated;

do $$
declare definition text; row_expression text; anchor text; replacement text; required text;
begin
 definition:=replace(pg_get_functiondef('private.fd_clobe_plan_actuals_sync_core(text,text)'::regprocedure),E'\r\n',E'\n');
 foreach required in array array['CLOBE_PLAN_UNTRUSTED','CLOBE_PLAN_EXPIRED','old_scope.scope_to>to_date','b.collected_at=s->>''collected_at''','old_scope.scope_from=from_date and old_scope.scope_to=to_date'] loop
  if strpos(definition,required)=0 then raise exception 'CLOBE_PLAN_SOURCE_COMPARISON_ANCHOR_MISSING: %',required;end if;
 end loop;
 row_expression:='jsonb_build_object(''external_transaction_id'',a.external_transaction_id,''txn_date'',a.txn_date,''txn_time'',a.txn_time,''amount'',a.amount,''balance'',a.balance,''description'',a.description,''party'',a.party,''source_details'',a.source_details)';
 anchor:='and v='||row_expression;
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_SOURCE_ROW_ANCHOR_MISSING';end if;
 definition:=replace(definition,anchor,'and private.fd_clobe_plan_source_compatible('||row_expression||',v)');
 anchor:='elsif old_scope.collected_order=source_order and old_scope.rows_hash is distinct from fingerprint then reason:=';
 if strpos(definition,anchor)=0 then raise exception 'CLOBE_PLAN_SOURCE_BATCH_ANCHOR_MISSING';end if;
 replacement:=E'elsif old_scope.collected_order=source_order and old_scope.rows_hash is distinct from fingerprint\n  and ((select count(*) from private.fd_clobe_plan_actuals a where a.owner_id=workspace_owner and a.account_id=account.id and a.month=scope_month)<>jsonb_array_length(s->''rows'')\n   or exists(select 1 from private.fd_clobe_plan_actuals a where a.owner_id=workspace_owner and a.account_id=account.id and a.month=scope_month\n    and not exists(select 1 from jsonb_array_elements(s->''rows'') v where v->>''external_transaction_id''=a.external_transaction_id\n     and private.fd_clobe_plan_source_compatible('||row_expression||E',v)))) then reason:=';
 definition:=replace(definition,anchor,replacement);
 execute definition;
end $$;

-- No new browser RPC or data permission. The signed existing private core is
-- the only application path to these pure comparison functions.
notify pgrst,'reload schema';
commit;
