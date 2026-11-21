-- 补全 demo_student 种子题库：q1-q12 带完整 options/answer/analysis/knowledge_tags
-- 说明：此前 20261121065157 的种子题 options 为空、answer 为 NULL，云端组卷后前端无法渲染与判题。
-- 本迁移用 ON CONFLICT DO UPDATE 覆盖旧行，保证云端闭环开箱即可答题；可重复执行。

INSERT INTO zx_questions (id, student_id, subject, knowledge_tags, stem, q_type, options, answer, analysis, difficulty, confidence, confirmed) VALUES
  ('q1','demo_student','数学','["k1"]','下列条件中，能判定△ABC≌△DEF 的是（　）','single','["AB=DE，BC=EF，∠A=∠D","AB=DE，∠A=∠D，AC=DF","∠A=∠D，∠B=∠E，BC=EF","AB=DE，BC=EF，∠C=∠F"]'::jsonb,'1'::jsonb,'两边及其夹角（SAS）可判定全等，选 B。A 为“边边角”不能判定。',3,1,true),
  ('q2','demo_student','数学','["k2"]','已知 x² − 5x + 6 = 0，则两根之和为______。','single','["5","-5","6","-6"]'::jsonb,'0'::jsonb,'由韦达定理，两根之和 = −b/a = 5。',3,1,true),
  ('q3','demo_student','数学','["k3"]','直角三角形两直角边为 3、4，则斜边长为（　）','single','["5","6","7","25"]'::jsonb,'0'::jsonb,'勾股定理：√(3²+4²)=5。',2,1,true),
  ('q4','demo_student','数学','["k4"]','将抛物线 y=x² 向右平移 2 个单位，解析式为（　）','single','["y=(x+2)²","y=(x−2)²","y=x²+2","y=x²−2"]'::jsonb,'1'::jsonb,'左加右减，向右平移 2 得 y=(x−2)²。',3,1,true),
  ('q5','demo_student','数学','["k5"]','直线 y=2x+1 的斜率为（　）','single','["1","2","-2","0"]'::jsonb,'1'::jsonb,'一次函数 y=kx+b 中 k 为斜率，故 k=2。',2,1,true),
  ('q6','demo_student','数学','["k6"]','圆 O 的半径为 5，点 P 在圆上，则 OP =（　）','single','["5","10","25","2.5"]'::jsonb,'0'::jsonb,'圆上任意点到圆心距离等于半径。',2,1,true),
  ('q7','demo_student','数学','["k8"]','若 √x 有意义，则 x 的取值范围是（　）','single','["x>0","x≥0","x<0","任意实数"]'::jsonb,'1'::jsonb,'二次根式被开方数须非负，x≥0。',2,1,true),
  ('q8','demo_student','数学','["k7"]','两个三角形对应角相等，则它们（　）','single','["全等","相似","面积相等","形状不同"]'::jsonb,'1'::jsonb,'三角对应相等可判定相似，不一定全等。',3,1,true),
  ('q9','demo_student','数学','["k2"]','方程 x²=9 的解为（　）','single','["x=3","x=-3","x=±3","无解"]'::jsonb,'2'::jsonb,'x²=9 的解为 x=±3。',2,1,true),
  ('q10','demo_student','数学','["k1"]','等腰三角形顶角 80°，底角为（　）','single','["50°","80°","100°","40°"]'::jsonb,'0'::jsonb,'(180−80)/2 = 50°。',2,1,true),
  ('q11','demo_student','数学','["k3"]','点 A(1,2) 与 B(4,6) 的距离为（　）','single','["3","4","5","√7"]'::jsonb,'2'::jsonb,'距离 = √((4−1)²+(6−2)²)=5。',3,1,true),
  ('q12','demo_student','数学','["k4"]','抛物线 y=−x² 的开口方向（　）','single','["向上","向下","向左","向右"]'::jsonb,'1'::jsonb,'二次项系数为负，开口向下。',2,1,true)
ON CONFLICT (id) DO UPDATE SET
  options = EXCLUDED.options,
  answer  = EXCLUDED.answer,
  analysis = EXCLUDED.analysis,
  knowledge_tags = EXCLUDED.knowledge_tags,
  stem = EXCLUDED.stem,
  confirmed = true;

-- 补齐知识点掌握度（已存在的 k1/k2/k5 不覆盖，保留真实学习进度）
INSERT INTO zx_mastery (id, student_id, knowledge_id, subject, score) VALUES
  ('seed_m_k3','demo_student','k3','数学',86),
  ('seed_m_k4','demo_student','k4','数学',45),
  ('seed_m_k6','demo_student','k6','数学',90),
  ('seed_m_k7','demo_student','k7','数学',70),
  ('seed_m_k8','demo_student','k8','数学',88)
ON CONFLICT (student_id, knowledge_id) DO NOTHING;
