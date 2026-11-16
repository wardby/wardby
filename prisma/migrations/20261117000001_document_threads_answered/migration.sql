-- Send-to-agent: the document version a thread was sent with (the agent's
-- edit is published only while the document is still at it), and the run
-- whose ending was answered on the thread (claimed once per run).
ALTER TABLE "CommentThread" ADD COLUMN "sentVersionNumber" INTEGER;
ALTER TABLE "CommentThread" ADD COLUMN "answeredRunId" TEXT;
