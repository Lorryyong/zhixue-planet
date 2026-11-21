-- 将知识星球 8 张核心表加 zx_ 前缀，实现与同库其他项目表的逻辑分组隔离。
-- 幂等：仅当「无前缀旧表存在且 zx_ 新表不存在」时才重命名；
-- 新环境（init_schema 已直接建 zx_ 表）执行本迁移为空操作，不会出错。

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','papers','questions','daily_tasks',
    'answer_record','wrongbook','mastery','knowledge_tree'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND to_regclass('public.zx_' || t) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', t, 'zx_' || t);
      RAISE NOTICE 'renamed % -> zx_%', t, t;
    END IF;
  END LOOP;
END $$;
