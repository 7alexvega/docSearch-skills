---
title: Installing the Gateway
audience: operators
---

# Installing the Gateway

The gateway ships as a single static binary with no runtime dependencies.
Installation takes about five minutes on a clean host.

## Requirements

A Linux host running kernel 5.4 or newer, 512 MB of free memory, and outbound
access to `releases.example.com` on port 443. The gateway binds port 8080 by
default; change it with `--listen`.

## Downloading the binary

Fetch the release matching your architecture and verify its checksum before
running it:

```bash
curl -fsSL https://releases.example.com/gateway/v3.2.1/gateway-linux-amd64 -o gateway
sha256sum -c gateway.sha256
chmod +x gateway
```

### Verifying the signature

Release artifacts are signed with the project's minisign key. A failed
signature check means the download was tampered with in transit — do not run
the binary.

## Configuration

Configuration lives in `/etc/gateway/config.yaml`. The three settings that
matter for a first run are `listen`, `upstream`, and `tls.mode`.

### TLS modes

`tls.mode` accepts `off`, `terminate`, or `passthrough`. Use `terminate` when
the gateway holds the certificate, `passthrough` when the upstream does.

# Troubleshooting

If the gateway exits immediately with status 78, the config file failed to
parse. Run `gateway --check-config` to see the offending line.
