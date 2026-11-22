-- 中考全题型支持迁移（2026-11-22）
-- 1) zx_questions 增加主观题判分字段 scoring_points / score（q_type 字段建表时已有）
-- 2) 补充 demo_student 全题型种子题：多选/判断/填空/解答/计算/阅读/实验/翻译/作文
--    覆盖「用户选择：AI 辅助判分 + 含分科专属题型」。可重复执行（ON CONFLICT DO UPDATE）。

-- 1) 新增列（幂等）
ALTER TABLE zx_questions ADD COLUMN IF NOT EXISTS scoring_points JSONB DEFAULT '[]'::jsonb;
ALTER TABLE zx_questions ADD COLUMN IF NOT EXISTS score NUMERIC(6,2) DEFAULT 2;
-- 作答记录增加 AI 判分审计字段（幂等）
ALTER TABLE zx_answer_record ADD COLUMN IF NOT EXISTS graded_by TEXT;
ALTER TABLE zx_answer_record ADD COLUMN IF NOT EXISTS ai_score NUMERIC(6,2);
ALTER TABLE zx_answer_record ADD COLUMN IF NOT EXISTS ai_max_score NUMERIC(6,2);
ALTER TABLE zx_answer_record ADD COLUMN IF NOT EXISTS ai_comment TEXT;
ALTER TABLE zx_answer_record ADD COLUMN IF NOT EXISTS needs_self_grade BOOLEAN DEFAULT false;

-- 2) 全题型种子题（数学为主，含语文/英语/物理分科专属）
INSERT INTO zx_questions (id, student_id, subject, knowledge_tags, stem, q_type, options, answer, scoring_points, score, analysis, difficulty, confidence, confirmed) VALUES
  ('qt_multi1','demo_student','数学','["k8"]','下列各数中，是无理数的有（　）','multiple','["√2","0.5","π","3"]'::jsonb,'[0,2]'::jsonb,'[]'::jsonb,2,'√2 与 π 为无理数；0.5、3 为有理数。',3,1,true),
  ('qt_judge1','demo_student','数学','["k1"]','两三角形对应角相等，则它们一定全等。（　）','judge','["正确","错误"]'::jsonb,'1'::jsonb,'[]'::jsonb,2,'错误。三角相等只能判定相似，不一定全等。',2,1,true),
  ('qt_blank1','demo_student','数学','["k2"]','一元二次方程 x²−5x+6=0 的两根之和为______，两根之积为______。','blank','[]'::jsonb,'["5","6"]'::jsonb,'[]'::jsonb,2,'韦达定理：和为5，积为6。多空逐空比对。',3,1,true),
  ('qt_solve1','demo_student','数学','["k4"]','已知二次函数 y=x²−2x−3。（1）求图象与 x 轴的交点；（2）写出顶点坐标。','solve','[]'::jsonb,'"令y=0得x=−1或3，交点(−1,0)、(3,0)；配方y=(x−1)²−4，顶点(1,−4)。"'::jsonb,'[{"point":"求出与x轴两个交点","score":5},{"point":"写出顶点坐标(1,−4)","score":5}]'::jsonb,10,'考查二次函数图象与坐标轴交点及顶点式。',4,1,true),
  ('qt_calc1','demo_student','数学','["k3"]','直角三角形两直角边分别为 6 和 8，求斜边上的高。','calculation','[]'::jsonb,'"斜边=10，面积=24，斜边上的高=2×24/10=4.8。"'::jsonb,'[{"point":"勾股定理求斜边10","score":3},{"point":"面积法求高4.8","score":3}]'::jsonb,6,'先用勾股定理求斜边，再用面积相等求高。',4,1,true),
  ('qt_read1','demo_student','语文','["语文-阅读"]','阅读短文《春》片段，回答问题：作者为什么把春天比作“刚落地的娃娃”？','reading','[]'::jsonb,'"突出春天的“新”，表现万物复苏、生机勃勃的特点，表达喜爱之情。"'::jsonb,'[{"point":"点出“新”的特点","score":3},{"point":"结合生机/复苏分析","score":3},{"point":"表达喜爱之情","score":2}]'::jsonb,8,'比喻赏析题，抓本体特征与情感。',3,1,true),
  ('qt_exp1','demo_student','物理','["物理-实验"]','在“探究凸透镜成像规律”实验中，物距 u>2f 时成什么像？如何验证？','experiment','[]'::jsonb,'"成倒立、缩小的实像；移动光屏直到屏上成清晰缩小的像，即为验证。"'::jsonb,'[{"point":"回答倒立缩小实像","score":4},{"point":"说明光屏承接验证方法","score":4}]'::jsonb,8,'凸透镜成像规律实验。',4,1,true),
  ('qt_trans1','demo_student','英语','["英语-翻译"]','把句子译成英语：他每天骑自行车上学。','translation','[]'::jsonb,'"He rides a bike to school every day."'::jsonb,'[{"point":"主语+谓语结构正确","score":3},{"point":"时间状语 every day 正确","score":3}]'::jsonb,6,'考查一般现在时与交通方式表达。',3,1,true),
  ('qt_essay1','demo_student','语文','["语文-写作"]','以「那一次，我懂得了______」为题，写一篇不少于600字的记叙文。','essay','[]'::jsonb,'"（作文无唯一答案，AI 按立意、内容、结构、语言四维评分）"'::jsonb,'[{"point":"立意切题、中心明确","score":10},{"point":"内容具体、感情真挚","score":15},{"point":"结构完整、条理清晰","score":10},{"point":"语言通顺、表达生动","score":5}]'::jsonb,40,'中考记叙文评分参考。',4,1,true)
ON CONFLICT (id) DO UPDATE SET
  q_type = EXCLUDED.q_type,
  options = EXCLUDED.options,
  answer = EXCLUDED.answer,
  scoring_points = EXCLUDED.scoring_points,
  score = EXCLUDED.score,
  analysis = EXCLUDED.analysis,
  knowledge_tags = EXCLUDED.knowledge_tags,
  stem = EXCLUDED.stem,
  confirmed = true;

-- 3) 修正旧种子题 q_type 空值（防御性，历史 demo 数据 q_type 可能为空）
UPDATE zx_questions SET q_type = 'single' WHERE q_type IS NULL OR q_type = '';
