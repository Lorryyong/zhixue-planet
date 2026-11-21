-- 种子数据：demo_student 的示例题目与掌握度，供「我的 → 云函数联调」验证
-- ON CONFLICT DO NOTHING 保证可重复执行不产生重复数据

INSERT INTO zx_questions (id, student_id, subject, knowledge_tags, stem, q_type, difficulty, options, confirmed) VALUES
  ('q1','demo_student','数学','["k2"]','若 a−b=3, ab=2, 求 a²+b²','single',3,'[]'::jsonb,true),
  ('q2','demo_student','数学','["k1","k7"]','AB=AC, ∠A=60°, △ABC 是？','single',3,'[]'::jsonb,true),
  ('q3','demo_student','数学','["k5"]','函数 y=−3x+4 经过哪些象限','single',3,'[]'::jsonb,true),
  ('q4','demo_student','数学','["k6"]','圆的切线与过切点半径的位置关系','single',4,'[]'::jsonb,true),
  ('q5','demo_student','数学','["k2"]','已知 x²−5x+6=0, 求 x','single',2,'[]'::jsonb,true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO zx_mastery (id, student_id, knowledge_id, subject, score) VALUES
  ('seed_m_k1','demo_student','k1','数学',45),
  ('seed_m_k2','demo_student','k2','数学',55),
  ('seed_m_k5','demo_student','k5','数学',90)
ON CONFLICT (student_id, knowledge_id) DO NOTHING;
