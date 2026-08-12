The retention policy applies to every object written to the archive bucket
after 1 March 2024. Objects written before that date keep their original
lifecycle rules until they are next modified.

Deletion requests are processed nightly at 02:00 UTC. A request submitted after
01:45 UTC is picked up by the following night's run, not the current one.

Restoring an object from the archive tier takes up to twelve hours for standard
retrieval and up to five minutes for expedited retrieval. Expedited retrieval
is billed at roughly ten times the standard rate and is rate-limited per
account.

Objects under legal hold are exempt from all lifecycle transitions. A legal
hold survives bucket-level policy changes and can only be released by an
account administrator with the compliance role.

Audit records for every deletion are retained for seven years in a separate
write-once bucket that ordinary account credentials cannot reach.
