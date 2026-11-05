begin;

-- Keep the complete one-statement display projection, but serialize records
-- directly to JSON. Constructing a large JSONB tree only to serialize it for
-- PostgREST performs unnecessary conversion and copies on every refresh.
-- Clone the CURRENT reader so later balance/actual/series additions and the
-- invoker authorization contract are retained. The old RPC remains compatible.
do $$
declare definition text; required text;
begin
 if not exists(select 1 from pg_proc where oid='public.fd_read_finance_dataset()'::regprocedure
   and not prosecdef and provolatile='s' and prorettype='jsonb'::regtype)
 then raise exception 'FINANCE_SNAPSHOT_READER_CONTRACT';end if;
 definition:=replace(pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,'FUNCTION public.fd_read_finance_dataset()')=0
   or strpos(definition,'RETURNS jsonb')=0
   or strpos(definition,'jsonb_agg(to_jsonb(r)')=0
   or strpos(definition,'workspace_owner:=private.finance_workspace_owner()')=0
   or strpos(definition,'''UNAUTHORIZED''')=0 or strpos(definition,'''ADMIN_REQUIRED''')=0
 then raise exception 'FINANCE_SNAPSHOT_READER_ANCHOR_MISSING';end if;
 foreach required in array array['balance_snapshots','bank_plan_actuals','bank_plan_coverage','cash_plan_series','cash_plan_series_revisions','transfer_fee_amount','transfer_fee_category_id'] loop
  if strpos(definition,required)=0 then raise exception 'FINANCE_SNAPSHOT_PROJECTION_MISSING: %',required;end if;
 end loop;
 definition:=replace(definition,'FUNCTION public.fd_read_finance_dataset()','FUNCTION public.fd_read_finance_snapshot()');
 definition:=replace(definition,'RETURNS jsonb','RETURNS json');
 definition:=replace(definition,'jsonb_build_object(','json_build_object(');
 definition:=replace(definition,'jsonb_agg(to_jsonb(r)','json_agg(row_to_json(r)');
 definition:=replace(definition,'''[]''::jsonb','''[]''::json');
 execute definition;
end $$;

revoke all on function public.fd_read_finance_snapshot() from public,anon,authenticated;
grant execute on function public.fd_read_finance_snapshot() to authenticated;
comment on function public.fd_read_finance_snapshot() is
 'Full finance UI JSON snapshot. Keep its projection in parity with fd_read_finance_dataset; update both readers when adding Dataset fields. Same STABLE INVOKER, workspace authorization, RLS and statement snapshot.';
notify pgrst,'reload schema';
commit;
