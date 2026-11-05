create function public.fd_reclassify_transactions(p_rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare updated integer;
begin
 if auth.uid() is null then raise exception 'Unauthorized';end if;
 if jsonb_array_length(p_rows)>500 then raise exception 'Batch too large';end if;
 update public.fd_transactions t set category_id=x.category_id,is_internal=x.is_internal
 from jsonb_to_recordset(p_rows) as x(id uuid,category_id uuid,is_internal boolean)
 where t.id=x.id and t.owner_id=auth.uid() and not t.manually_classified
 and (t.category_id is distinct from x.category_id or t.is_internal is distinct from x.is_internal);
 get diagnostics updated=row_count;return updated;
end $$;
revoke all on function public.fd_reclassify_transactions(jsonb) from public,anon;
grant execute on function public.fd_reclassify_transactions(jsonb) to authenticated;
