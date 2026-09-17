-- AddForeignKey
ALTER TABLE "issue_events" ADD CONSTRAINT "issue_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
