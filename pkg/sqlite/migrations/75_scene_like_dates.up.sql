-- One row per like, so the feed can favour scenes liked recently. like_count on
-- scenes stays the source of truth for the total; this only adds the when.
CREATE TABLE `scenes_like_dates` (
  `scene_id` integer not null,
  `like_date` datetime not null,
  foreign key(`scene_id`) references `scenes`(`id`) on delete CASCADE
);
CREATE INDEX `index_scenes_like_dates_scene_id` ON `scenes_like_dates`(`scene_id`);
CREATE INDEX `index_scenes_like_dates_like_date` ON `scenes_like_dates`(`like_date`);
