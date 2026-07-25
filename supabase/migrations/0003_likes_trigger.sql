create function public.recount_likes() returns trigger language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  tid := coalesce(new.theme_id, old.theme_id);
  update public.themes set likes = (select count(*) from public.likes where theme_id = tid)
  where id = tid;
  return null;
end; $$;

create trigger likes_after_change
  after insert or delete on public.likes
  for each row execute function public.recount_likes();
