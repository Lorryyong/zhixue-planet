-- PG 模式云存储桶初始化（2026-11-22 11:25）
-- 背景：目标环境 progressive-zupu-d8eb6lsc7ee9feb 为 PostgreSQL(PG) 模式。
-- PG 环境不像传统云开发自带默认存储桶，storage.buckets 初始为空，
-- 小程序 wx.cloud.uploadFile 会因此报 STORAGE_BUCKET_NOT_FOUND (-501000)。
-- 本脚本幂等创建三个业务桶，并配置 RLS 读写策略，可重复执行。

-- 1) 业务存储桶（cloudPath 第一段需与 bucket id 一致）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('imports',  'imports',  false, 20971520,
   ARRAY['text/csv','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream']::text[]),
  ('papers',   'papers',   false, 20971520,
   ARRAY['application/pdf','image/png','image/jpeg']::text[]),
  ('avatars',  'avatars',  false, 10485760,
   ARRAY['image/png','image/jpeg','image/webp']::text[])
ON CONFLICT (id) DO NOTHING;

-- 2) 桶元数据对所有客户端可读
DROP POLICY IF EXISTS buckets_read ON storage.buckets;
CREATE POLICY buckets_read ON storage.buckets
  FOR SELECT TO anon, authenticated USING (true);

-- 3) 三个业务桶：登录/匿名客户端均可读写（个人小程序场景；如需按用户隔离改为 auth.uid() 匹配 owner_id）
DROP POLICY IF EXISTS files_all ON storage.objects;
CREATE POLICY files_all ON storage.objects
  FOR ALL TO anon, authenticated
  USING (bucket_id IN ('imports','papers','avatars'))
  WITH CHECK (bucket_id IN ('imports','papers','avatars'));
