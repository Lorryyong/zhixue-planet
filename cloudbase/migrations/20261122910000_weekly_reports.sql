-- 学情周报：云端按周（周一为起点）聚合快照，学生/家长端均可读取
-- week_key 形如 2026-W48；同一学生同一周仅一条，重复生成则 update 覆盖。
create table if not exists zx_weekly_reports (
  id text primary key,
  student_id text not null,
  week_key text not null,
  week_start text not null,
  week_end text not null,
  energy integer not null default 0,
  streak integer not null default 0,
  checkins integer not null default 0,
  answer_count integer not null default 0,
  correct_count integer not null default 0,
  accuracy integer not null default 0,
  wrong_active integer not null default 0,
  conquered integer not null default 0,
  weak_list jsonb not null default '[]'::jsonb,
  subject_stats jsonb not null default '[]'::jsonb,
  generated_at text not null,
  unique(student_id, week_key)
);
create index if not exists idx_zx_weekly_reports_student_week on zx_weekly_reports(student_id, week_key);
