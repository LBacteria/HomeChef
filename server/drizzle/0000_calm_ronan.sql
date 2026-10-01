CREATE TABLE `ingredient_alias` (
	`id` integer PRIMARY KEY NOT NULL,
	`ingredient_id` integer NOT NULL,
	`alias` text NOT NULL,
	`alias_normalized` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ingredient_id`) REFERENCES `standard_ingredient`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_alias_alias_normalized_unique` ON `ingredient_alias` (`alias_normalized`);--> statement-breakpoint
CREATE INDEX `ingredient_alias_ingredient_id_idx` ON `ingredient_alias` (`ingredient_id`);--> statement-breakpoint
CREATE TABLE `standard_ingredient` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`unit` text NOT NULL,
	`purchase_date` text,
	`expiry_date` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "quantity_non_negative" CHECK("standard_ingredient"."quantity" >= 0),
	CONSTRAINT "unit_in_enum" CHECK("standard_ingredient"."unit" in ('个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐')),
	CONSTRAINT "expiry_not_before_purchase" CHECK("standard_ingredient"."expiry_date" is null or "standard_ingredient"."purchase_date" is null or "standard_ingredient"."expiry_date" >= "standard_ingredient"."purchase_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `standard_ingredient_name_normalized_unique` ON `standard_ingredient` (`name_normalized`);