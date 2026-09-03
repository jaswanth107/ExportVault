import dns from 'node:dns';
import net from 'node:net';

/**
 * Optional DNS/address-family override, applied before anything opens a socket.
 *
 * Managed Postgres providers (Neon among them) publish both A and AAAA records.
 * On a host with no working IPv6 route, Node can stall on the IPv6 candidate
 * and the database connection fails with ETIMEDOUT even though the service is
 * perfectly reachable over IPv4 — a failure that looks like a broken database
 * rather than a broken network path.
 *
 * Node's default (Happy Eyeballs) is correct almost everywhere, so this is NOT
 * enabled by default. Set DNS_RESULT_ORDER=ipv4first if a deployment shows
 * connection timeouts to a host that resolves to both families.
 */
export function configureDns(): void {
  const order = process.env.DNS_RESULT_ORDER?.trim();
  if (!order) return;

  if (order !== 'ipv4first' && order !== 'ipv6first' && order !== 'verbatim') {
    // Never silently ignore a misspelled operational knob.
    throw new Error(
      `DNS_RESULT_ORDER must be one of ipv4first | ipv6first | verbatim, received "${order}"`,
    );
  }

  dns.setDefaultResultOrder(order);

  // Result order alone is not enough: Happy Eyeballs races both families, so
  // an unreachable IPv6 candidate can still hold the connection open.
  if (order === 'ipv4first' && net.setDefaultAutoSelectFamily) {
    net.setDefaultAutoSelectFamily(false);
  }
}
