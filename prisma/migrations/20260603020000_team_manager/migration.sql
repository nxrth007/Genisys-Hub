-- Team manager delegation — lets Mary (role=agent) approve Team #1
-- registrations + assign their initial call-center numbers without
-- pulling Alex into every flip.
--
-- Single column: User.managesTeamNumber. Null = not a manager;
-- when set to a team number, the user can manage that team via
-- /team/manage. Admin still owns the destructive paths (password
-- reset, change number on an active user, delete).
--
-- No index — managers are a handful at most, queries scope by
-- explicit equality, sequential scan is fine at this scale.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "managesTeamNumber" INTEGER;
