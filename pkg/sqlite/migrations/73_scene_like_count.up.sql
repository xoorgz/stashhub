ALTER TABLE `scenes` ADD COLUMN `like_count` INTEGER NOT NULL DEFAULT 0;
CREATE INDEX `index_scenes_on_like_count` ON `scenes`(`like_count`);
