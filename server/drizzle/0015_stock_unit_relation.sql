ALTER TABLE standard_ingredient ADD COLUMN secondary_unit TEXT;
--> statement-breakpoint
ALTER TABLE standard_ingredient ADD COLUMN secondary_ratio REAL CHECK (secondary_ratio IS NULL OR secondary_ratio > 0);
