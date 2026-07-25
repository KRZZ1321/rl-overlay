create function public.bump_install(p_theme uuid) returns integer
language sql security definer set search_path = '' as $$
  update public.themes set installs = installs + 1 where id = p_theme and status = 'live'
  returning installs;
$$;
