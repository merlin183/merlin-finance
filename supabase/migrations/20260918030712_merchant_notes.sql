begin;
create table public.fd_merchant_notes(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 account_id uuid not null,
 direction text not null check(direction in ('in','out')),
 subject_key text not null check(length(subject_key) between 1 and 1500),
 subject_hash text generated always as (md5(subject_key)) stored,
 label text not null check(length(label)<=1000),
 memo text not null default '' check(length(memo)<=2000),
 version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 unique(owner_id,account_id,direction,subject_hash),
 foreign key(owner_id,account_id) references public.fd_accounts(owner_id,id) on delete cascade
);
alter table public.fd_merchant_notes enable row level security;
revoke all on public.fd_merchant_notes from public,anon,authenticated;
grant select,insert,update on public.fd_merchant_notes to authenticated;
create policy finance_notes_read on public.fd_merchant_notes for select to authenticated using(owner_id=(select private.finance_workspace_owner()));
create policy finance_notes_insert on public.fd_merchant_notes for insert to authenticated with check(owner_id=(select private.finance_workspace_owner()));
create policy finance_notes_update on public.fd_merchant_notes for update to authenticated using(owner_id=(select private.finance_workspace_owner())) with check(owner_id=(select private.finance_workspace_owner()));
create function public.fd_save_merchant_note(p_account uuid,p_direction text,p_subject text,p_label text,p_memo text,p_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); saved public.fd_merchant_notes;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_version is null or p_version<0 or p_memo is null or length(p_memo)>2000 then raise exception 'INVALID_NOTE';end if;
 if not exists(select 1 from public.fd_accounts where owner_id=workspace_owner and id=p_account) then raise exception 'ACCOUNT_REQUIRED';end if;
 if p_version=0 then
  insert into public.fd_merchant_notes(owner_id,account_id,direction,subject_key,label,memo,updated_by)
  values(workspace_owner,p_account,p_direction,p_subject,p_label,p_memo,auth.uid())
  on conflict(owner_id,account_id,direction,subject_hash) do nothing returning * into saved;
 else
  update public.fd_merchant_notes set memo=p_memo,label=p_label,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid()
  where owner_id=workspace_owner and account_id=p_account and direction=p_direction and subject_hash=md5(p_subject) and subject_key=p_subject and version=p_version returning * into saved;
 end if;
 if saved.id is null then raise exception 'NOTE_STALE';end if;
 return to_jsonb(saved);
end $$;
revoke all on function public.fd_save_merchant_note(uuid,text,text,text,text,integer) from public,anon;
grant execute on function public.fd_save_merchant_note(uuid,text,text,text,text,integer) to authenticated;
alter table public.fd_categories add column is_fixed boolean not null default false;
notify pgrst,'reload schema';
commit;
