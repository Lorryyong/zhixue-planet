-- 题目知识点升级：为每道题的知识点标注「出现在几年级哪册课本」的什么知识点，
-- 便于家长分析薄弱知识点、知道该补哪一册哪一块内容。
-- knowledge_points: JSON 数组 [{name:string, book:string, inferred:boolean}]
--   name = 知识点名称；book = 课本册次（如「八年级上册」）；inferred = 是否自动推断（供人工复核）
-- 默认 [] 保证存量题目行为不变；校对页/云函数会在读取时用词典自动预填。
ALTER TABLE public.zx_questions
  ADD COLUMN IF NOT EXISTS knowledge_points TEXT NOT NULL DEFAULT '[]';

COMMENT ON COLUMN public.zx_questions.knowledge_points IS '结构化知识点：[{name,book,inferred}]，book 为课本册次';
