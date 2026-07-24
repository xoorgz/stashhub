-- Browsing + feed performance: every scene list and every algorithm bucket was
-- scanning the full table. The default sort is by date (browse), the feed pages
-- by created_at, and every bucket filters organized=1 then sorts by play_duration,
-- like_count, or date. COVERING INDEX means the query never touches the heap.
CREATE INDEX IF NOT EXISTS `index_scenes_on_created_at` ON `scenes` (`created_at`);
CREATE INDEX IF NOT EXISTS `index_scenes_on_play_duration` ON `scenes` (`play_duration`);
CREATE INDEX IF NOT EXISTS `index_scenes_on_date` ON `scenes` (`date`);
CREATE INDEX IF NOT EXISTS `index_scenes_on_organized` ON `scenes` (`organized`);
