-- 个人资料新增「所在地区」：省 / 市两列（资料页地区选择器写入，login 的 updateProfile 白名单字段）
ALTER TABLE zx_users ADD COLUMN IF NOT EXISTS province TEXT NOT NULL DEFAULT '';
ALTER TABLE zx_users ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
