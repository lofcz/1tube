-- Custom migration: FTS5 full-text index over logs.message.
--
-- External-content table: the indexed text lives in `logs` (single copy);
-- the FTS table stores only the inverted index. Triggers keep it in sync.
-- `logs` rows are append-only in practice, but the UPDATE trigger is
-- included so the index can never drift if a row is ever rewritten.
CREATE VIRTUAL TABLE `logs_fts` USING fts5(
	`message`,
	content='logs',
	content_rowid='id',
	tokenize='unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `logs_fts_ai` AFTER INSERT ON `logs` BEGIN
	INSERT INTO `logs_fts`(rowid, message) VALUES (new.id, new.message);
END;
--> statement-breakpoint
CREATE TRIGGER `logs_fts_ad` AFTER DELETE ON `logs` BEGIN
	INSERT INTO `logs_fts`(`logs_fts`, rowid, message) VALUES ('delete', old.id, old.message);
END;
--> statement-breakpoint
CREATE TRIGGER `logs_fts_au` AFTER UPDATE ON `logs` BEGIN
	INSERT INTO `logs_fts`(`logs_fts`, rowid, message) VALUES ('delete', old.id, old.message);
	INSERT INTO `logs_fts`(rowid, message) VALUES (new.id, new.message);
END;
