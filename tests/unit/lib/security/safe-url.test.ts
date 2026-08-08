/**
 * Tests for `checkSafeProviderUrl` — the SSRF guard used on
 * `AiProviderConfig.baseUrl`.
 */

import { describe, it, expect } from 'vitest';
import { checkSafeProviderUrl, isSafeProviderUrl } from '@/lib/security/safe-url';

describe('checkSafeProviderUrl', () => {
  describe('schemes', () => {
    it('accepts https', () => {
      expect(checkSafeProviderUrl('https://api.openai.com/v1').ok).toBe(true);
    });

    it('accepts http for non-local public hosts', () => {
      expect(checkSafeProviderUrl('http://api.example.com/').ok).toBe(true);
    });

    it.each(['file:///etc/passwd', 'gopher://evil/', 'javascript:alert(1)', 'data:,hi', 'ftp://x'])(
      'rejects %s',
      (url) => {
        const result = checkSafeProviderUrl(url);
        expect(result.ok).toBe(false);
        // file:// has no host and is often rejected as invalid_url by WHATWG parsing —
        // accept either reason
        expect(['disallowed_scheme', 'invalid_url']).toContain(result.reason);
      }
    );

    it('rejects totally malformed input', () => {
      expect(checkSafeProviderUrl('not a url').ok).toBe(false);
    });
  });

  describe('cloud metadata hosts', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://metadata.goog/',
      'http://100.100.100.200/',
    ])('blocks %s', (url) => {
      const result = checkSafeProviderUrl(url, { allowLoopback: true });
      expect(result.ok).toBe(false);
    });
  });

  describe('unspecified address', () => {
    it('blocks 0.0.0.0', () => {
      expect(checkSafeProviderUrl('http://0.0.0.0/').ok).toBe(false);
    });

    it('blocks bracketed ::', () => {
      expect(checkSafeProviderUrl('http://[::]/').ok).toBe(false);
    });
  });

  describe('loopback handling', () => {
    it.each(['http://localhost/', 'http://127.0.0.1:11434/', 'http://[::1]/'])(
      'rejects %s without allowLoopback',
      (url) => {
        const result = checkSafeProviderUrl(url);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('loopback_not_allowed');
      }
    );

    it.each([
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8080/',
      'http://host.docker.internal:11434/',
    ])('accepts %s with allowLoopback', (url) => {
      expect(checkSafeProviderUrl(url, { allowLoopback: true }).ok).toBe(true);
    });
  });

  describe('private IP ranges (always blocked, even with allowLoopback)', () => {
    it.each([
      'http://10.0.0.1/',
      'http://10.255.255.1/',
      'http://172.16.0.1/',
      'http://172.31.255.1/',
      'http://192.168.1.1/',
      'http://100.64.0.1/', // CGNAT
    ])('blocks %s', (url) => {
      const result = checkSafeProviderUrl(url, { allowLoopback: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('allows 172.15.x.x (just outside RFC1918)', () => {
      expect(checkSafeProviderUrl('http://172.15.0.1/').ok).toBe(true);
    });

    it('allows 172.32.x.x (just outside RFC1918)', () => {
      expect(checkSafeProviderUrl('http://172.32.0.1/').ok).toBe(true);
    });
  });

  describe('link-local', () => {
    it('blocks 169.254.0.0/16', () => {
      expect(checkSafeProviderUrl('http://169.254.100.100/', { allowLoopback: true }).ok).toBe(
        false
      );
    });

    it('blocks IPv6 link-local fe80::', () => {
      expect(checkSafeProviderUrl('http://[fe80::1]/', { allowLoopback: true }).ok).toBe(false);
    });
  });

  describe('IPv6 unique local', () => {
    it('blocks fc00::/7', () => {
      expect(checkSafeProviderUrl('http://[fc00::1]/', { allowLoopback: true }).ok).toBe(false);
      expect(checkSafeProviderUrl('http://[fd12:3456::1]/', { allowLoopback: true }).ok).toBe(
        false
      );
    });
  });

  // #534: an IPv4-mapped IPv6 literal reaches the same host as its dotted-quad
  // form (verified: a fetch to `http://[::ffff:127.0.0.1]:PORT/` is served by a
  // listener bound to 127.0.0.1), but matched nothing in the denylist and made
  // `parseIpv4` return null, so every range check was false and the guard said
  // ok. Note the WHATWG parser rewrites the dotted spelling into hex, so these
  // arrive as `::ffff:a9fe:a9fe` rather than the readable form written here.
  describe('IPv4-in-IPv6 literals', () => {
    it('normalizes the mapped form to its dotted quad', () => {
      // Guards the premise of every case below: if the parser stopped
      // rewriting, matching only the hex form would silently cover nothing.
      expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
    });

    it.each([
      ['cloud metadata', 'http://[::ffff:169.254.169.254]/latest/meta-data/'],
      ['metadata, hex spelling', 'http://[::ffff:a9fe:a9fe]/'],
      ['loopback', 'http://[::ffff:127.0.0.1]/'],
      ['RFC1918 10/8', 'http://[::ffff:10.0.0.5]/'],
      ['RFC1918 192.168/16', 'http://[::ffff:192.168.1.1]/'],
      ['deprecated IPv4-compatible', 'http://[::169.254.169.254]/'],
    ])('blocks %s', (_label, url) => {
      expect(checkSafeProviderUrl(url).ok).toBe(false);
    });

    it('applies the same policy as the plain form, not a blanket refusal', () => {
      // Unwrapping rather than rejecting means allowLoopback still works for a
      // local provider addressed this way — and that private ranges stay
      // blocked even with the opt-in, exactly as for the dotted form.
      expect(
        checkSafeProviderUrl('http://[::ffff:127.0.0.1]:11434/', { allowLoopback: true }).ok
      ).toBe(true);
      expect(checkSafeProviderUrl('http://[::ffff:10.0.0.5]/', { allowLoopback: true }).ok).toBe(
        false
      );
    });

    it('leaves genuine IPv6 addresses alone', () => {
      expect(checkSafeProviderUrl('http://[2606:4700:4700::1111]/').ok).toBe(true);
    });
  });

  // #553. An escalation relay inside a VPC is a legitimate target, and before
  // the refine landed it worked (because nothing was validated). This is the
  // opt-in that keeps it possible without reverting to no validation at all.
  describe('allowPrivateNetwork', () => {
    it.each([
      ['RFC1918 10/8', 'http://10.0.1.5/hooks/escalate'],
      ['RFC1918 192.168/16', 'http://192.168.1.20/hooks'],
      ['RFC1918 172.16/12', 'http://172.20.1.1/hooks'],
      ['IPv6 unique local', 'http://[fd12:3456::1]/'],
    ])('permits %s when opted in', (_label, url) => {
      expect(checkSafeProviderUrl(url).ok).toBe(false);
      expect(checkSafeProviderUrl(url, { allowPrivateNetwork: true }).ok).toBe(true);
    });

    // The whole point of the flag is that it does NOT reopen the target that
    // makes SSRF worth exploiting. BLOCKED_HOSTNAMES is checked first.
    // The flag deliberately does NOT relax link-local. A denylist of metadata
    // LITERALS is not enough: 169.254.169.254 is only the best-known one. AWS
    // ECS task metadata vends IAM role credentials from 169.254.170.2 and EKS
    // Pod Identity from 169.254.170.23, and 169.254.0.0/16 is reserved for
    // exactly this class of service — nothing an operator would legitimately
    // POST an escalation to lives there.
    it.each([
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['metadata via IPv4-mapped IPv6', 'http://[::ffff:169.254.169.254]/'],
      ['AWS ECS task credentials', 'http://169.254.170.2/v2/credentials/abc'],
      ['EKS Pod Identity credentials', 'http://169.254.170.23/v1/credentials'],
      ['any other link-local', 'http://169.254.10.10/'],
      ['IPv6 link-local', 'http://[fe80::1]/'],
      // CGNAT is shared address space, not a network the deployment owns; it
      // is also the default Tailscale range and contains Alibaba Cloud's
      // metadata service at 100.100.100.200. Relaxing it would reduce
      // protection there to that one denylisted literal — the same argument
      // that keeps link-local sealed.
      ['CGNAT 100.64/10', 'http://100.64.0.1/'],
      ['CGNAT near Alibaba metadata', 'http://100.100.100.5/'],
      ['Alibaba metadata itself', 'http://100.100.100.200/'],
      ['GCP metadata hostname', 'http://metadata.google.internal/'],
      ['unspecified address', 'http://0.0.0.0/'],
    ])('still blocks %s when opted in', (_label, url) => {
      expect(checkSafeProviderUrl(url, { allowPrivateNetwork: true }).ok).toBe(false);
    });

    it('does not imply allowLoopback', () => {
      // A VPC address is not a loopback address; widening one must not widen
      // the other.
      expect(checkSafeProviderUrl('http://127.0.0.1/', { allowPrivateNetwork: true }).ok).toBe(
        false
      );
      expect(checkSafeProviderUrl('http://[::1]/', { allowPrivateNetwork: true }).ok).toBe(false);
    });

    it('composes with allowLoopback when both are set', () => {
      expect(
        checkSafeProviderUrl('http://127.0.0.1:11434/', {
          allowLoopback: true,
          allowPrivateNetwork: true,
        }).ok
      ).toBe(true);
    });

    it('does not relax the scheme check', () => {
      expect(checkSafeProviderUrl('file:///etc/passwd', { allowPrivateNetwork: true }).ok).toBe(
        false
      );
    });
  });

  describe('public hosts', () => {
    it.each([
      'https://api.openai.com/v1',
      'https://api.anthropic.com',
      'https://api.together.xyz/v1',
      'https://api.groq.com/openai/v1',
    ])('accepts %s', (url) => {
      expect(checkSafeProviderUrl(url).ok).toBe(true);
    });
  });

  describe('isSafeProviderUrl wrapper', () => {
    it('returns true for safe URLs', () => {
      expect(isSafeProviderUrl('https://api.openai.com/v1')).toBe(true);
    });

    it('returns false for unsafe URLs', () => {
      expect(isSafeProviderUrl('http://169.254.169.254/')).toBe(false);
    });
  });

  describe('scheme rejection — exact reason code', () => {
    it('rejects file: scheme with disallowed_scheme reason', () => {
      // Arrange: file: is not http/https and must return a specific reason
      // Act
      const result = checkSafeProviderUrl('file:///etc/passwd');
      // Assert
      expect(result.ok).toBe(false);
      // file:// URLs have no host and may be rejected as invalid_url by WHATWG
      expect(['disallowed_scheme', 'invalid_url']).toContain(result.reason);
    });

    it('rejects data: scheme with disallowed_scheme reason', () => {
      // Arrange: data: URIs should be rejected at the scheme layer
      // Act
      const result = checkSafeProviderUrl('data:text/plain,hello');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('disallowed_scheme');
    });

    it('rejects gopher: scheme with disallowed_scheme reason', () => {
      // Arrange
      const result = checkSafeProviderUrl('gopher://evil.example.com/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('disallowed_scheme');
    });
  });

  describe('blocked hostnames — exact reason code', () => {
    it('blocks 169.254.169.254 with blocked_host reason', () => {
      // Arrange: AWS metadata IP is in BLOCKED_HOSTNAMES
      const result = checkSafeProviderUrl('http://169.254.169.254/latest/meta-data/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('blocked_host');
    });

    it('blocks metadata.google.internal with blocked_host reason', () => {
      // Arrange: GCP metadata hostname is in BLOCKED_HOSTNAMES
      const result = checkSafeProviderUrl('http://metadata.google.internal/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('blocked_host');
    });

    it('blocks 0.0.0.0 with blocked_host reason (not loopback_not_allowed)', () => {
      // Arrange: 0.0.0.0 is in BLOCKED_HOSTNAMES — must use blocked_host, not loopback_not_allowed
      const result = checkSafeProviderUrl('http://0.0.0.0/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('blocked_host');
    });
  });

  describe('loopback allowed path', () => {
    it('allows 127.0.0.1 when allowLoopback: true', () => {
      // Arrange: local provider config should pass with the loopback opt-in
      const result = checkSafeProviderUrl('http://127.0.0.1/', { allowLoopback: true });
      // Assert
      expect(result.ok).toBe(true);
    });
  });

  describe('private IP ranges — specific addresses', () => {
    it('blocks 10.0.0.1 with private_ip reason', () => {
      // Arrange: 10.0.0.0/8
      const result = checkSafeProviderUrl('http://10.0.0.1/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('blocks 172.16.0.1 with private_ip reason (172.16.0.0/12 range)', () => {
      // Arrange: start of RFC1918 172.16.0.0/12
      const result = checkSafeProviderUrl('http://172.16.0.1/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('blocks 192.168.1.1 with private_ip reason', () => {
      // Arrange: 192.168.0.0/16
      const result = checkSafeProviderUrl('http://192.168.1.1/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('blocks 100.64.0.1 carrier-grade NAT with private_ip reason', () => {
      // Arrange: 100.64.0.0/10 shared address space (CGNAT)
      const result = checkSafeProviderUrl('http://100.64.0.1/');
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('blocks link-local 169.254.1.1 (not the metadata IP) with private_ip reason', () => {
      // Arrange: 169.254.0.0/16 link-local — distinct from the exact metadata IP 169.254.169.254
      // which is caught by BLOCKED_HOSTNAMES. Other addresses in the subnet go through isLinkLocalIp.
      const result = checkSafeProviderUrl('http://169.254.1.1/', { allowLoopback: true });
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });

    it('blocks IPv6 unique-local fc00::1 with private_ip reason', () => {
      // Arrange: fc00::/7 unique local addresses
      const result = checkSafeProviderUrl('http://[fc00::1]/', { allowLoopback: true });
      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('private_ip');
    });
  });

  describe('isSafeProviderUrl boolean matches checkSafeProviderUrl.ok', () => {
    it('returns true when checkSafeProviderUrl returns ok: true', () => {
      // Arrange: safe public URL
      const url = 'https://api.anthropic.com';
      // Act
      const checkResult = checkSafeProviderUrl(url);
      const boolResult = isSafeProviderUrl(url);
      // Assert: thin wrapper returns the same boolean
      expect(boolResult).toBe(checkResult.ok);
      expect(boolResult).toBe(true);
    });

    it('returns false when checkSafeProviderUrl returns ok: false', () => {
      // Arrange: blocked private IP
      const url = 'http://192.168.0.1/';
      // Act
      const checkResult = checkSafeProviderUrl(url);
      const boolResult = isSafeProviderUrl(url);
      // Assert: thin wrapper returns the same boolean
      expect(boolResult).toBe(checkResult.ok);
      expect(boolResult).toBe(false);
    });
  });
});
