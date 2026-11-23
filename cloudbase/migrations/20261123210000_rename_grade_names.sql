-- v1.9.18 年级改名：初一/初二/初三 → 七年级/八年级/九年级
-- 与 miniprogram/utils/grade.js 及 cloudfunctions/recognize/questionMeta.js 的标准取值保持一致。
-- 覆盖所有用户副本（不限 student_id），幂等可重复执行。2026-11-23

UPDATE public.zx_questions
  SET grade = '七年级' WHERE grade = '初一';

UPDATE public.zx_questions
  SET grade = '八年级' WHERE grade = '初二';

UPDATE public.zx_questions
  SET grade = '九年级' WHERE grade = '初三';

UPDATE public.zx_knowledge_tree
  SET grade = '七年级' WHERE grade = '初一';

UPDATE public.zx_knowledge_tree
  SET grade = '八年级' WHERE grade = '初二';

UPDATE public.zx_knowledge_tree
  SET grade = '九年级' WHERE grade = '初三';
