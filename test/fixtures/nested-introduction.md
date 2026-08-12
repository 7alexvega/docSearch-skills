# Reverse Proxy Setup

Before configuring any specific proxy, decide whether TLS terminates at the
proxy or at the application. This choice determines which of the two sections
below applies, and it cannot be changed without reissuing certificates.

Both configurations assume the application listens on `127.0.0.1:3000`.

## NGINX Configuration

Use `proxy_pass` with an explicit `Host` header. Without it, the upstream sees
the internal address and generates incorrect absolute URLs.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
}
```

## Cloudflare Configuration

Set the SSL mode to Full (strict). Flexible mode terminates TLS at the edge and
sends plaintext to the origin, which breaks the application's secure-cookie
handling.
