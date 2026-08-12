# Error Code Reference

## Complete error table

Error 1001 — the request body exceeded the configured maximum size.
Error 1002 — the request body was not valid UTF-8.
Error 1003 — the declared content type did not match the body.
Error 1004 — a required header was absent.
Error 1005 — a header exceeded the maximum permitted length.
Error 1006 — the request contained duplicate headers that must be unique.
Error 1007 — the request method is not permitted on this route.
Error 1008 — the request path contained an invalid escape sequence.
Error 1009 — the query string exceeded the maximum permitted length.
Error 1010 — a query parameter appeared more times than allowed.
Error 1011 — the supplied credential has expired.
Error 1012 — the supplied credential was revoked.
Error 1013 — the credential is valid but lacks the required scope.
Error 1014 — the account is suspended pending review.
Error 1015 — the account exceeded its request quota for the period.
Error 1016 — the requested resource does not exist.
Error 1017 — the requested resource was deleted and cannot be restored.
Error 1018 — the resource is locked by another operation.
Error 1019 — the operation would create a duplicate unique key.
Error 1020 — the operation conflicts with a concurrent modification.
Error 1021 — the upstream service did not respond within the timeout.
Error 1022 — the upstream service returned an unparseable response.
Error 1023 — the operation was cancelled by the client.
Error 1024 — an internal invariant was violated; report this with the trace id.
Error 1025 — the service is draining and is not accepting new work.
Error 1026 — the requested API version is no longer supported.
Error 1027 — the requested API version is not yet available in this region.
Error 1028 — the region is failing over and writes are temporarily rejected.
Error 1029 — the payload referenced an object in a different tenant.
Error 1030 — the operation requires a feature flag that is not enabled.

## Notes

Codes in the 1000 range are client errors. Codes above 2000 are reserved.
