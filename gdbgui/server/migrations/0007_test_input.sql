-- 為 live_quiz_questions 加入 test_input 欄位（儲存出題當下的測資 Standard Input）
ALTER TABLE live_quiz_questions ADD COLUMN test_input TEXT;
