-- ============================================================
-- X GYM — Member Portal Setup (شغّل هذا السكريبت مرة واحدة في
-- Supabase SQL Editor بعد سكريبت النظام الأساسي)
-- إضافي بالكامل — لا يحذف أو يعدّل أي بيانات موجودة
-- ============================================================

-- 1) أعمدة جديدة على جدول الأعضاء (لربطهم بحساب دخول Supabase Auth
--    وصورة البروفايل) — بيانات العضو الأساسية تفضل زي ما هي جوه data
alter table xgym_members add column if not exists user_id uuid;
alter table xgym_members add column if not exists photo_url text;
create index if not exists idx_members_user_id on xgym_members(user_id);

-- 2) Bucket تخزين صور البروفايل (لو مش موجود). لو السطر ده رفض
--    الصلاحية عندك، اعمل الخطوة يدويًا من Storage → New bucket
--    باسم member-photos واختار Public bucket
insert into storage.buckets (id, name, public)
values ('member-photos','member-photos', true)
on conflict (id) do nothing;

-- 3) سياسات القراءة/الكتابة لصورة العضو في Storage
drop policy if exists "member upload own photo" on storage.objects;
create policy "member upload own photo" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'member-photos' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "member update own photo" on storage.objects;
create policy "member update own photo" on storage.objects
  for update to authenticated
  using (bucket_id = 'member-photos' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "public read member photos" on storage.objects;
create policy "public read member photos" on storage.objects
  for select using (bucket_id = 'member-photos');

-- 4) سياسات RLS إضافية تسمح للعضو المسجّل دخوله (Supabase Auth)
--    بقراءة صف بياناته فقط وتحديث صورته فقط — بالإضافة للسياسة
--    العامة الحالية الخاصة بالأدمن (متبقّاة زي ما هي بدون تغيير)
drop policy if exists "member read own row" on xgym_members;
create policy "member read own row" on xgym_members
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "member update own photo col" on xgym_members;
create policy "member update own photo col" on xgym_members
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "member read own attendance" on xgym_attendance;
create policy "member read own attendance" on xgym_attendance
  for select to authenticated
  using (exists (
    select 1 from xgym_members m
    where m.id = xgym_attendance.member_id and m.user_id = auth.uid()
  ));

-- 5) دالة آمنة لإعادة تعيين رمز الدخول (PIN) لعضو عنده حساب Auth
--    بالفعل — تُستخدم من الأدمن عبر supabase.rpc('reset_member_pin', ...)
--    SECURITY DEFINER يسمح لها بتعديل جدول auth.users بأمان من غير
--    الحاجة لمفتاح service_role في الواجهة الأمامية
create or replace function reset_member_pin(p_member_id text, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from xgym_members where id = p_member_id;
  if v_user_id is null then
    raise exception 'هذا العضو ليس له حساب دخول بعد';
  end if;

  update auth.users
  set encrypted_password = crypt(p_new_pin, gen_salt('bf')),
      updated_at = now()
  where id = v_user_id;

  update xgym_members
  set data = jsonb_set(coalesce(data,'{}'::jsonb), '{pin}', to_jsonb(p_new_pin))
  where id = p_member_id;
end;
$$;

grant execute on function reset_member_pin(text, text) to anon, authenticated;

-- ============================================================
-- ملاحظة مهمة: تأكد إن الحد الأدنى لطول كلمة المرور في
-- Authentication → Settings → Password minimum length هو 6 على
-- الأقل (الافتراضي في Supabase هو 6) — النظام بيولّد رمز دخول
-- (PIN) من 6 أرقام لكل عضو تلقائيًا عند إضافته من الأدمن.
--
-- ولو حابب تمنع تفعيل "Confirm email" اللي ممكن يمنع تسجيل دخول
-- العضو مباشرة بعد إنشاء الحساب، من Authentication → Providers →
-- Email، عطّل خيار "Confirm email".
-- ============================================================
