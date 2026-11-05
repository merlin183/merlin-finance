begin;
create function public.fd_apply_classification_review(p_changes jsonb,p_rules jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 workspace_owner uuid:=private.finance_workspace_owner(); expected integer; changed integer; learned integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_typeof(p_rules) is distinct from 'array' then raise exception 'INVALID_PAYLOAD';end if;
 expected:=jsonb_array_length(p_changes);
 if expected<1 or expected>10000 or jsonb_array_length(p_rules)>1000 then raise exception 'INVALID_BATCH_SIZE';end if;
 if (select count(distinct x.id) from jsonb_to_recordset(p_changes) x(id uuid))<>expected then raise exception 'DUPLICATE_TRANSACTIONS';end if;
 -- Acquire row locks in stable order. A changed row rejects the entire operation.
 perform t.id from public.fd_transactions t
 join jsonb_to_recordset(p_changes) x(id uuid) on x.id=t.id
 where t.owner_id=workspace_owner order by t.id for update of t;
 if (select count(*) from public.fd_transactions t
 join jsonb_to_recordset(p_changes) x(id uuid,category_id uuid,expected_category_id uuid,expected_manually_classified boolean) on x.id=t.id
 left join public.fd_categories previous on previous.id=t.category_id and previous.owner_id=t.owner_id
 join public.fd_categories target on target.id=x.category_id and target.owner_id=t.owner_id
 where t.owner_id=workspace_owner and t.category_id is not distinct from x.expected_category_id
 and t.manually_classified is not distinct from x.expected_manually_classified
 and (t.category_id is null or previous.name in ('미매핑','입금','출금'))
 and target.name not in ('미매핑','입금','출금'))<>expected then raise exception 'CLASSIFICATION_STALE';end if;

 if exists(select 1 from jsonb_to_recordset(p_rules) r(pattern text,category_id uuid,account_id uuid,direction text)
 where r.pattern is null or length(r.pattern) not between 1 and 120 or r.direction is null or r.direction not in ('in','out')
 or not exists(select 1 from public.fd_transactions t
 join jsonb_to_recordset(p_changes) x(id uuid,category_id uuid) on x.id=t.id
 where t.owner_id=workspace_owner and t.account_id=r.account_id and t.direction=r.direction and x.category_id=r.category_id))
 then raise exception 'INVALID_RULE_SCOPE';end if;

 insert into public.fd_category_rules(owner_id,pattern,field,category_id,priority,is_internal,account_id,direction)
 select workspace_owner,r.pattern,'description',r.category_id,1,c.is_internal,r.account_id,r.direction
 from jsonb_to_recordset(p_rules) r(pattern text,category_id uuid,account_id uuid,direction text)
 join public.fd_categories c on c.id=r.category_id and c.owner_id=workspace_owner
 on conflict(owner_id,pattern,field,account_id,direction)
 do update set priority=least(public.fd_category_rules.priority,excluded.priority)
 where public.fd_category_rules.category_id=excluded.category_id
 and public.fd_category_rules.is_internal=excluded.is_internal;
 get diagnostics learned=row_count;
 if learned<>jsonb_array_length(p_rules) then raise exception 'CLASSIFICATION_RULE_CONFLICT';end if;

 update public.fd_transactions t set category_id=x.category_id,is_internal=c.is_internal,manually_classified=true
 from jsonb_to_recordset(p_changes) x(id uuid,category_id uuid)
 join public.fd_categories c on c.id=x.category_id and c.owner_id=workspace_owner
 where t.id=x.id and t.owner_id=workspace_owner;
 get diagnostics changed=row_count;
 if changed<>expected then raise exception 'CLASSIFICATION_STALE';end if;
 insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'미분류 묶음 정리',format('%s건 분류 · 자동 분류 규칙 %s개 저장 · 기존 세부 과목 유지',changed,learned));
 return jsonb_build_object('updated',changed,'learned',learned);
end $$;
revoke all on function public.fd_apply_classification_review(jsonb,jsonb) from public,anon;
grant execute on function public.fd_apply_classification_review(jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
