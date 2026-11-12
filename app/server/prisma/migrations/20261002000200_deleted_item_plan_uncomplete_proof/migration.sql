-- Plan uncomplete restore proof is append-only and nullable for all ordinary/legacy deletions.
ALTER TABLE "DeletedItem" ADD COLUMN "planUncompleteProof" TEXT;
