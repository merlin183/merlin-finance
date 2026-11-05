-- The existing owner_id is a stable storage namespace, NOT an administrator role.
-- Keep existing finance rows, composite foreign keys and upload paths unchanged.
begin;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table private.finance_workspace (
  singleton boolean primary key default true check (singleton),
  data_owner_id uuid not null references auth.users(id) on delete restrict
);
create table private.finance_administrators (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check(email=lower(btrim(email))),
  user_id uuid unique references auth.users(id) on delete restrict,
  status text not null check(status in ('pending','active','revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  bootstrap boolean not null default false,
  check(status<>'active' or (user_id is not null and accepted_at is not null)),
  check(status<>'pending' or expires_at is not null or bootstrap)
);
create table private.finance_admin_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  subject_email text not null,
  created_at timestamptz not null default now()
);
alter table private.finance_workspace enable row level security;
alter table private.finance_administrators enable row level security;
alter table private.finance_admin_events enable row level security;
revoke all on private.finance_workspace,private.finance_administrators,private.finance_admin_events from public,anon,authenticated;

-- Install schema without assuming any Auth users or inheriting an operator's
-- identity. Until the installer runs operations/bootstrap_workspace.sql through
-- a trusted postgres SQL connection, the empty workspace denies every app user.
-- There is no public bootstrap RPC and no first-login administrator promotion.

create function private.finance_workspace_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select w.data_owner_id from private.finance_workspace w
 where auth.uid() is not null and exists(
  select 1 from private.finance_administrators a where a.user_id=auth.uid() and a.status='active'
 );
$$;

create function private.finance_admin_context() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); actor_email text; workspace_owner uuid; member_id uuid;
begin
 if actor is null then raise exception 'UNAUTHORIZED'; end if;
 workspace_owner:=private.finance_workspace_owner();
 if workspace_owner is null then
  -- The email is read from Auth's verified Google identity, never user-editable metadata.
  select lower(btrim(u.email)) into actor_email from auth.users u
  where u.id=actor and u.email_confirmed_at is not null and exists(
   select 1 from auth.identities i where i.user_id=u.id and i.provider='google'
   and lower(btrim(i.identity_data->>'email'))=lower(btrim(u.email))
   and i.identity_data->>'email_verified'='true'
  );
  if actor_email is not null then
   -- Same lock serializes acceptance, invitations and revocations.
   perform 1 from private.finance_workspace where singleton for update;
   update private.finance_administrators a
   set status='active',user_id=actor,accepted_at=now(),expires_at=null,bootstrap=false
   where a.email=actor_email and a.status='pending'
   and (a.user_id is null or a.user_id=actor)
   and (a.expires_at>now() or a.bootstrap)
   and (a.bootstrap or exists(select 1 from private.finance_administrators inviter
        where inviter.user_id=a.invited_by and inviter.status='active'))
   returning a.id into member_id;
   if member_id is not null then
    insert into private.finance_admin_events(actor_id,action,subject_email)
    values(actor,'accept_invitation',actor_email);
   end if;
   workspace_owner:=private.finance_workspace_owner();
  end if;
 end if;
 return jsonb_build_object('owner_id',workspace_owner,'is_admin',workspace_owner is not null);
end$$;

create function private.finance_admin_list() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or private.finance_workspace_owner() is null then raise exception 'ADMIN_REQUIRED';end if;
 return jsonb_build_object(
  'members',(select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'email',a.email,'status',case when a.status='pending' and a.expires_at<=now() then 'expired' else a.status end,
    'invited_at',a.invited_at,'expires_at',a.expires_at,'accepted_at',a.accepted_at,
    'is_self',a.user_id=auth.uid()) order by a.invited_at), '[]'::jsonb)
    from private.finance_administrators a),
  'events',(select coalesce(jsonb_agg(e order by e.created_at desc),'[]'::jsonb)
    from (select e.action,e.subject_email,e.created_at,a.email as actor_email
          from private.finance_admin_events e left join private.finance_administrators a on a.user_id=e.actor_id
          order by e.created_at desc limit 30) e)
 );
end$$;

create function private.finance_admin_invite(p_email text) returns void
language plpgsql security definer set search_path='' as $$
declare normalized text:=lower(btrim(p_email));
begin
 perform 1 from private.finance_workspace where singleton for update;
 if auth.uid() is null or private.finance_workspace_owner() is null then raise exception 'ADMIN_REQUIRED';end if;
 if normalized is null or length(normalized)>254 or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
  raise exception 'INVALID_EMAIL';
 end if;
 if exists(select 1 from private.finance_administrators where email=normalized and status='active') then
  raise exception 'ALREADY_ADMIN';
 end if;
 insert into private.finance_administrators(email,status,invited_by,expires_at)
 values(normalized,'pending',auth.uid(),now()+interval '7 days')
 on conflict(email) do update set status='pending',user_id=null,invited_by=auth.uid(),invited_at=now(),
  expires_at=now()+interval '7 days',accepted_at=null,revoked_at=null,bootstrap=false;
 insert into private.finance_admin_events(actor_id,action,subject_email)
 values(auth.uid(),'invite_admin',normalized);
end$$;

create function private.finance_admin_revoke(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare target private.finance_administrators;
begin
 perform 1 from private.finance_workspace where singleton for update;
 if auth.uid() is null or private.finance_workspace_owner() is null then raise exception 'ADMIN_REQUIRED';end if;
 select * into target from private.finance_administrators where id=p_id;
 if target.id is null then raise exception 'MEMBER_NOT_FOUND';end if;
 if target.status='revoked' then return;end if;
 if target.status='active' and (select count(*) from private.finance_administrators where status='active')<=1 then
  raise exception 'LAST_ADMIN';
 end if;
 update private.finance_administrators set status='revoked',revoked_at=now(),bootstrap=false where id=p_id;
 -- Unaccepted invitations issued by a removed administrator are cancelled as well.
 with cancelled as (
  update private.finance_administrators set status='revoked',revoked_at=now(),bootstrap=false
  where invited_by=target.user_id and status='pending' returning email
 ) insert into private.finance_admin_events(actor_id,action,subject_email)
 select auth.uid(),'cancel_invitation',email from cancelled;
 insert into private.finance_admin_events(actor_id,action,subject_email)
 values(auth.uid(),'revoke_admin',target.email);
end$$;

create function public.fd_admin_context() returns jsonb language sql security invoker set search_path='' as $$select private.finance_admin_context()$$;
create function public.fd_admin_list() returns jsonb language sql security invoker set search_path='' as $$select private.finance_admin_list()$$;
create function public.fd_admin_invite(p_email text) returns void language sql security invoker set search_path='' as $$select private.finance_admin_invite(p_email)$$;
create function public.fd_admin_revoke(p_id uuid) returns void language sql security invoker set search_path='' as $$select private.finance_admin_revoke(p_id)$$;
revoke all on function private.finance_workspace_owner(),private.finance_admin_context(),private.finance_admin_list(),private.finance_admin_invite(text),private.finance_admin_revoke(uuid) from public,anon,authenticated;
grant execute on function private.finance_workspace_owner(),private.finance_admin_context(),private.finance_admin_list(),private.finance_admin_invite(text),private.finance_admin_revoke(uuid) to authenticated;
revoke all on function public.fd_admin_context(),public.fd_admin_list(),public.fd_admin_invite(text),public.fd_admin_revoke(uuid) from public,anon,authenticated;
grant execute on function public.fd_admin_context(),public.fd_admin_list(),public.fd_admin_invite(text),public.fd_admin_revoke(uuid) to authenticated;

-- Replace (do not supplement) the former owner-only policies on all finance tables.
do $$declare t text;begin
 foreach t in array array['fd_businesses','fd_accounts','fd_categories','fd_category_rules','fd_gwamok_aliases','fd_uploads','fd_transactions','fd_recurring_items','fd_inter_company_links','fd_mapping_presets','fd_preferences','fd_audit_log'] loop
  execute format('drop policy finance_owner on public.%I',t);
  execute format('create policy finance_admin_workspace on public.%I for all to authenticated using(owner_id=(select private.finance_workspace_owner())) with check(owner_id=(select private.finance_workspace_owner()))',t);
 end loop;
end$$;

alter table public.fd_audit_log add column actor_id uuid default auth.uid();
revoke update on public.fd_audit_log from authenticated;
create function private.finance_audit_actor() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.actor_id:=auth.uid();return new;end$$;
revoke all on function private.finance_audit_actor() from public,anon,authenticated;
create trigger finance_audit_actor before insert on public.fd_audit_log for each row execute function private.finance_audit_actor();

drop policy finance_files_read on storage.objects;
drop policy finance_files_insert on storage.objects;
drop policy finance_files_delete on storage.objects;
create policy finance_files_read on storage.objects for select to authenticated
 using(bucket_id='finance-uploads' and (storage.foldername(name))[1]=(select private.finance_workspace_owner())::text);
create policy finance_files_insert on storage.objects for insert to authenticated
 with check(bucket_id='finance-uploads' and (storage.foldername(name))[1]=(select private.finance_workspace_owner())::text);
create policy finance_files_delete on storage.objects for delete to authenticated
 using(bucket_id='finance-uploads' and (storage.foldername(name))[1]=(select private.finance_workspace_owner())::text);

-- Preserve INVOKER behavior and all existing validation, with the shared namespace.
do $$declare fn regprocedure; definition text;begin
 foreach fn in array array['public.fd_import_transactions(uuid,uuid,jsonb)'::regprocedure,'public.fd_reclassify_transactions(jsonb)'::regprocedure,'public.fd_delete_my_data()'::regprocedure] loop
  definition:=pg_get_functiondef(fn);
  definition:=replace(definition,'auth.uid()','private.finance_workspace_owner()');
  execute definition;
 end loop;
end$$;
notify pgrst,'reload schema';
commit;
