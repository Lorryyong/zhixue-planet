-- P0-1 错因四分类：记录错因来源（self=学生自选 / auto=系统推断）
ALTER TABLE zx_wrongbook ADD COLUMN IF NOT EXISTS error_type_source TEXT DEFAULT 'auto';
