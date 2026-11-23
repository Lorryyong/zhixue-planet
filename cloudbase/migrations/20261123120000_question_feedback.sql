-- 题目错误反馈（v1.9.9）：学生打卡时发现题目有误可提交反馈，
-- 管理员在「我的 → 题库管理 → 用户反馈错题清单」中处理（修改/删除/忽略）。
-- 处理过的反馈从待处理列表移除（status != 'pending'）。

CREATE TABLE IF NOT EXISTS zx_question_feedback (
  id            text PRIMARY KEY,
  question_id   text NOT NULL,
  student_id    text NOT NULL,        -- 反馈人 openid（云端注入，前端无法伪造）
  feedback_type text NOT NULL,        -- category=题分类错误 | stem=题目错误 | answer=答案错误
  q_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 反馈时题目快照：stem/subject/q_type/original/answer/analysis 等
  status        text NOT NULL DEFAULT 'pending',     -- pending=待处理 | fixed=已修正 | deleted=已删除题目 | ignored=已忽略
  handle_note   text DEFAULT '',       -- 管理员处理备注
  created_at    timestamptz NOT NULL DEFAULT now(),
  handled_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON zx_question_feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_question ON zx_question_feedback (question_id);
CREATE INDEX IF NOT EXISTS idx_feedback_student ON zx_question_feedback (student_id);

COMMENT ON TABLE zx_question_feedback IS '用户反馈错题清单：学生提交题目问题，管理员处理';
COMMENT ON COLUMN zx_question_feedback.feedback_type IS 'category=题分类错误 | stem=题目错误 | answer=答案错误';
COMMENT ON COLUMN zx_question_feedback.status IS 'pending=待处理 | fixed=已修正 | deleted=已删除题目 | ignored=已忽略';
