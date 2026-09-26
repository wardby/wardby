-- Additive: roles for self-hosted users (security finding A1). A privileged
-- operation (make_owner, setting workerImageRef, package approval) needs its
-- scope on the token AND one of the user's roles granting it, checked on
-- every request. Role names are validated in code (admin, package-approver).
-- Existing users get no roles (member) - an operator re-grants admin with
-- `wardby auth user grant --subject <subject> --role admin`.

-- AlterTable
ALTER TABLE "AuthUser" ADD COLUMN     "roles" TEXT[] DEFAULT ARRAY[]::TEXT[];
