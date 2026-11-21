-- 智学星球 PG 初始化迁移（zx_ 前缀分组）（2026-11-21）
-- 说明：核心 8 表；id 用 TEXT 主键（由云函数生成短 id，避免依赖序列权限）
-- 所有表使用 snake_case；时间戳统一 TIMESTAMPTZ

-- 1) zx_users 用户表
CREATE TABLE IF NOT EXISTS zx_users (
  id            TEXT PRIMARY KEY,
  openid        TEXT UNIQUE,
  unionid       TEXT,
  role          TEXT NOT NULL DEFAULT 'student',
  nickname      TEXT,
  avatar        TEXT,
  phone         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_openid ON zx_users(openid);

-- 2) zx_papers 试卷表
CREATE TABLE IF NOT EXISTS zx_papers (
  id             TEXT PRIMARY KEY,
  student_id     TEXT NOT NULL,
  title          TEXT,
  subject        TEXT NOT NULL,
  grade          TEXT,
  chapter        TEXT,
  year           INT,
  source         TEXT,
  file_id        TEXT,
  page_count     INT DEFAULT 0,
  question_count INT DEFAULT 0,
  ocr_status     TEXT DEFAULT 'pending',
  confirm_status TEXT DEFAULT 'draft',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_papers_student ON zx_papers(student_id);

-- 3) zx_questions 题目表
CREATE TABLE IF NOT EXISTS zx_questions (
  id             TEXT PRIMARY KEY,
  paper_id       TEXT,
  student_id     TEXT,
  subject        TEXT,
  q_type         TEXT NOT NULL DEFAULT 'single',
  stem           TEXT,
  stem_images    JSONB DEFAULT '[]'::jsonb,
  options        JSONB DEFAULT '[]'::jsonb,
  answer         JSONB,
  analysis       TEXT,
  knowledge_tags JSONB DEFAULT '[]'::jsonb,
  difficulty     NUMERIC(3,2) DEFAULT 3,
  confidence     NUMERIC(3,2) DEFAULT 1,
  need_confirm   BOOLEAN DEFAULT false,
  confirmed      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_questions_student ON zx_questions(student_id);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON zx_questions(subject);
CREATE INDEX IF NOT EXISTS idx_questions_tags ON zx_questions USING GIN (knowledge_tags);

-- 4) zx_daily_tasks 每日任务表
CREATE TABLE IF NOT EXISTS zx_daily_tasks (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL,
  task_date    DATE NOT NULL,
  question_ids JSONB DEFAULT '[]'::jsonb,
  composition  JSONB DEFAULT '{}'::jsonb,
  status       TEXT DEFAULT 'pending',
  total_count  INT DEFAULT 0,
  done_count   INT DEFAULT 0,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, task_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_student_date ON zx_daily_tasks(student_id, task_date);

-- 5) zx_answer_record 作答记录表
CREATE TABLE IF NOT EXISTS zx_answer_record (
  id              TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL,
  question_id     TEXT NOT NULL,
  task_id         TEXT,
  answer          JSONB,
  is_correct      BOOLEAN NOT NULL,
  self_graded     BOOLEAN DEFAULT false,
  time_spent      INT DEFAULT 0,
  viewed_analysis BOOLEAN DEFAULT false,
  attempts        INT DEFAULT 1,
  answered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_answer_student ON zx_answer_record(student_id);
CREATE INDEX IF NOT EXISTS idx_answer_question ON zx_answer_record(question_id);
CREATE INDEX IF NOT EXISTS idx_answer_at ON zx_answer_record(answered_at);

-- 6) zx_wrongbook 错题本表
CREATE TABLE IF NOT EXISTS zx_wrongbook (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL,
  question_id        TEXT NOT NULL,
  error_type         TEXT,
  knowledge_tags     JSONB DEFAULT '[]'::jsonb,
  wrong_count        INT DEFAULT 1,
  continuous_correct INT DEFAULT 0,
  review_stage       INT DEFAULT 0,
  next_review_at     TIMESTAMPTZ,
  status             TEXT DEFAULT 'active',
  first_wrong_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_wrong_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_wrong_student ON zx_wrongbook(student_id);
CREATE INDEX IF NOT EXISTS idx_wrong_due ON zx_wrongbook(student_id, status, next_review_at);

-- 7) zx_mastery 知识点掌握度表（自适应基石）
CREATE TABLE IF NOT EXISTS zx_mastery (
  id              TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL,
  knowledge_id    TEXT NOT NULL,
  subject         TEXT,
  score           NUMERIC(5,2) DEFAULT 50,
  total_answered  INT DEFAULT 0,
  total_correct   INT DEFAULT 0,
  trend           TEXT DEFAULT 'stable',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, knowledge_id)
);
CREATE INDEX IF NOT EXISTS idx_mastery_student ON zx_mastery(student_id);
CREATE INDEX IF NOT EXISTS idx_mastery_score ON zx_mastery(student_id, score);

-- 8) zx_knowledge_tree 知识点树表
CREATE TABLE IF NOT EXISTS zx_knowledge_tree (
  id        TEXT PRIMARY KEY,
  subject   TEXT,
  name      TEXT,
  parent_id TEXT,
  level     INT DEFAULT 1,
  grade     TEXT,
  keywords  JSONB DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ktree_subject ON zx_knowledge_tree(subject);
